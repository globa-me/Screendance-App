import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import {
	AUTOMATION_MAX_REQUEST_BYTES,
	AUTOMATION_PROTOCOL_VERSION,
	type AutomationEndpoint,
	AutomationError,
	type AutomationRequest,
	toAutomationError,
	validateAutomationRequest,
} from "../../shared/automation";

const MAX_REQUEST_BYTES = AUTOMATION_MAX_REQUEST_BYTES;

async function requirePrivateDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(directory);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(process.getuid && stat.uid !== process.getuid()) ||
		stat.mode & 0o077
	) {
		throw new AutomationError(
			"ACCESS_DENIED",
			"Automation directories must be private directories owned by this user.",
		);
	}
}

function processIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Exclusive lifetime lock: concurrent desktop launches may not replace one another. */
async function acquireEndpointLock(
	endpointPath: string,
	token: string,
): Promise<() => Promise<void>> {
	const lockPath = `${endpointPath}.lock`;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const file = await fs.open(lockPath, "wx", 0o600);
			try {
				await file.writeFile(JSON.stringify({ token, pid: process.pid }));
			} catch (error) {
				await file.close();
				await fs.rm(lockPath, { force: true });
				throw error;
			}
			await file.close();
			return async () => {
				try {
					const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
					if (owner?.token === token) await fs.rm(lockPath, { force: true });
				} catch {
					/* Never remove another owner's lock. */
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let stat;
		try {
			stat = await fs.lstat(lockPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			(process.getuid && stat.uid !== process.getuid()) ||
			stat.mode & 0o077
		) {
			throw new AutomationError("ACCESS_DENIED", "Invalid automation ownership lock.");
		}
		let owner: { pid?: unknown } | null = null;
		try {
			owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
		} catch {
			/* An acquiring process may not have written metadata yet. */
		}
		const validPid =
			typeof owner?.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0;
		if (
			(validPid && processIsLive(owner!.pid as number)) ||
			(!validPid && Date.now() - stat.mtimeMs < 60_000)
		) {
			throw new AutomationError(
				"ALREADY_RUNNING",
				"An automation host already owns this endpoint.",
			);
		}
		// Recheck the inode to avoid reclaiming a lock that changed during inspection.
		const current = await fs.lstat(lockPath).catch(() => null);
		if (current?.ino === stat.ino && current.dev === stat.dev)
			await fs.rm(lockPath, { force: true });
	}
	throw new AutomationError(
		"ALREADY_RUNNING",
		"Automation endpoint ownership changed during startup; retry later.",
	);
}

async function isSocketLive(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		const finish = (live: boolean) => {
			socket.destroy();
			resolve(live);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.setTimeout(500, () => finish(true)); // An unresponsive owner is not permission to replace it.
	});
}

/** Private per-user local transport. One bounded JSON request per connection. */
export async function startAutomationSocket(options: {
	endpointPath: string;
	dispatch: (request: AutomationRequest) => Promise<unknown>;
}): Promise<{ endpoint: AutomationEndpoint; close: () => Promise<void> }> {
	const endpointPath = path.resolve(options.endpointPath);
	const endpointDir = path.dirname(endpointPath);
	await requirePrivateDirectory(endpointDir);
	const token = randomBytes(32).toString("hex");
	const releaseLock = await acquireEndpointLock(endpointPath, token);
	try {
		try {
			const previous = JSON.parse(
				await fs.readFile(endpointPath, "utf8"),
			) as AutomationEndpoint;
			if (
				previous &&
				typeof previous.socketPath === "string" &&
				(await isSocketLive(previous.socketPath))
			) {
				throw new AutomationError(
					"ALREADY_RUNNING",
					"An automation host already owns this endpoint.",
				);
			}
		} catch (error) {
			if (error instanceof AutomationError) throw error;
			if (
				(error as NodeJS.ErrnoException).code !== "ENOENT" &&
				!(error instanceof SyntaxError)
			)
				throw error;
		}
		// Keep below macOS sockaddr_un's short path limit, independent of profile path length.
		const socketDirectoryName = `sd-auto-${process.getuid?.() ?? "user"}`;
		let socketDir = path.join(os.tmpdir(), socketDirectoryName);
		if (Buffer.byteLength(path.join(socketDir, "0123456789abcdef.sock")) > 103)
			socketDir = path.join("/tmp", socketDirectoryName);
		await requirePrivateDirectory(socketDir);
		const socketPath = path.join(socketDir, `${randomBytes(8).toString("hex")}.sock`);
		const endpoint: AutomationEndpoint = {
			protocolVersion: AUTOMATION_PROTOCOL_VERSION,
			socketPath,
			token,
			pid: process.pid,
		};
		const clients = new Set<import("node:net").Socket>();
		let server: Server;
		server = createServer((socket) => {
			clients.add(socket);
			socket.once("close", () => clients.delete(socket));
			socket.on("error", () => socket.destroy());
			// Recorder finalization includes camera/microphone sidecars and may outlive
			// the old one-minute idle deadline while the renderer is still working.
			socket.setTimeout(150_000, () => socket.destroy());
			const chunks: Buffer[] = [];
			let byteLength = 0;
			let received = false;
			socket.on("data", (chunk) => {
				if (received) return;
				const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
				byteLength += bytes.length;
				if (byteLength > MAX_REQUEST_BYTES) {
					socket.destroy();
					return;
				}
				chunks.push(bytes);
				if (bytes.indexOf(10) < 0) return;
				const buffer = Buffer.concat(chunks, byteLength);
				const newline = buffer.indexOf(10);
				received = true;
				void (async () => {
					let id = "invalid";
					try {
						const value = JSON.parse(
							buffer.subarray(0, newline).toString("utf8"),
						) as Record<string, unknown>;
						if (value && typeof value.id === "string") id = value.id.slice(0, 128);
						if (!value || value.token !== token)
							throw new AutomationError(
								"ACCESS_DENIED",
								"Invalid automation credentials.",
							);
						if (value.protocolVersion !== AUTOMATION_PROTOCOL_VERSION)
							throw new AutomationError(
								"PROTOCOL_MISMATCH",
								"Unsupported automation protocol version.",
							);
						const request = validateAutomationRequest(value);
						const result = await options.dispatch(request);
						socket.end(`${JSON.stringify({ id, result })}\n`);
					} catch (error) {
						const failure =
							error instanceof SyntaxError
								? new AutomationError("INVALID_REQUEST", "Invalid JSON request.")
								: error;
						socket.end(
							`${JSON.stringify({ id, error: toAutomationError(failure) })}\n`,
						);
					}
				})();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		let closing: Promise<void> | undefined;
		const close = () => {
			if (closing) return closing;
			closing = (async () => {
				try {
					for (const client of clients) client.destroy();
					await new Promise<void>((resolve) => server.close(() => resolve()));
					await fs.rm(socketPath, { force: true });
					try {
						const current = JSON.parse(
							await fs.readFile(endpointPath, "utf8"),
						) as AutomationEndpoint;
						if (current?.token === token) await fs.rm(endpointPath, { force: true });
					} catch {
						/* Another instance or cleanup may already have removed the descriptor. */
					}
				} finally {
					await releaseLock();
				}
			})();
			return closing;
		};
		const staging = `${endpointPath}.${token}.tmp`;
		try {
			await fs.chmod(socketPath, 0o600);
			await fs.writeFile(staging, `${JSON.stringify(endpoint)}\n`, {
				mode: 0o600,
				flag: "wx",
			});
			await fs.chmod(staging, 0o600);
			await fs.rename(staging, endpointPath);
		} catch (error) {
			await close();
			throw error;
		} finally {
			await fs.rm(staging, { force: true });
		}
		return { endpoint, close };
	} catch (error) {
		await releaseLock();
		throw error;
	}
}
