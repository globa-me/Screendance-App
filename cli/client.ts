import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	AUTOMATION_MAX_MESSAGE_BYTES,
	AUTOMATION_PROTOCOL_VERSION,
	type AutomationEndpoint,
} from "../shared/automation";

export interface ClientOptions {
	endpoint?: string;
	timeoutMs?: number;
	launch?: string;
	dev?: boolean;
}

export class AutomationClientError extends Error {
	constructor(
		public code: string,
		message: string,
		public details?: unknown,
	) {
		super(message);
		this.name = "AutomationClientError";
	}
}

export function endpointPath(options: ClientOptions): string {
	return resolve(
		options.endpoint ??
			process.env.SCREENDANCE_AUTOMATION_ENDPOINT ??
			`${homedir()}/Library/Application Support/Screendance App${options.dev ? "-dev" : ""}/automation/endpoint.json`,
	);
}

async function readEndpoint(path: string) {
	try {
		const metadata = await stat(path);
		if (
			!metadata.isFile() ||
			(metadata.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && metadata.uid !== process.getuid())
		) {
			throw new AutomationClientError(
				"INVALID_ENDPOINT",
				"Endpoint descriptor must be a private file owned by the current user.",
			);
		}
		if (metadata.size > 16_384)
			throw new AutomationClientError(
				"INVALID_ENDPOINT",
				"Endpoint descriptor is too large.",
			);
		const endpoint = JSON.parse(await readFile(path, "utf8"));
		if (
			endpoint.protocolVersion !== AUTOMATION_PROTOCOL_VERSION ||
			typeof endpoint.socketPath !== "string" ||
			!endpoint.socketPath.startsWith("/") ||
			typeof endpoint.token !== "string" ||
			endpoint.token.length < 16 ||
			!Number.isInteger(endpoint.pid) ||
			endpoint.pid < 1
		) {
			throw new AutomationClientError(
				"INVALID_ENDPOINT",
				"Unsupported or malformed endpoint descriptor.",
			);
		}
		return endpoint as AutomationEndpoint;
	} catch (error) {
		if (error instanceof AutomationClientError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new AutomationClientError(
				"APP_NOT_RUNNING",
				`No automation endpoint at ${path}. Start Screendance App with automation enabled or supply --endpoint.`,
			);
		}
		throw new AutomationClientError(
			"INVALID_ENDPOINT",
			"Cannot read the automation endpoint descriptor.",
		);
	}
}

async function requestOnce(
	options: ClientOptions,
	method: string,
	params: Record<string, unknown>,
	timeoutMs: number,
): Promise<unknown> {
	const endpoint = await readEndpoint(endpointPath(options));
	return new Promise((resolveResult, reject) => {
		const socket = createConnection(endpoint.socketPath);
		const id = randomUUID();
		let connected = false;
		let done = false;
		let buffer = "";
		const finish = (error?: Error, result?: unknown) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolveResult(result);
		};
		const timer = setTimeout(
			() =>
				finish(
					new AutomationClientError(
						"TIMEOUT",
						"Automation command timed out; its outcome may be unknown. Inspect application state before retrying.",
					),
				),
			timeoutMs,
		);
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			connected = true;
			socket.write(
				`${JSON.stringify({ id, method, params, token: endpoint.token, protocolVersion: AUTOMATION_PROTOCOL_VERSION })}\n`,
			);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > AUTOMATION_MAX_MESSAGE_BYTES) {
				finish(
					new AutomationClientError(
						"INVALID_RESPONSE",
						"Automation response exceeded the size limit.",
					),
				);
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = JSON.parse(buffer.slice(0, newline));
				if (
					response.id !== id ||
					(!Object.keys(response).includes("result") && !response.error)
				) {
					throw new Error("Invalid envelope");
				}
				if (response.error) {
					if (
						typeof response.error.code !== "string" ||
						typeof response.error.message !== "string"
					)
						throw new Error("Invalid error");
					finish(
						new AutomationClientError(
							response.error.code,
							response.error.message,
							response.error.details,
						),
					);
				} else finish(undefined, response.result);
			} catch {
				finish(
					new AutomationClientError(
						"INVALID_RESPONSE",
						"Application returned an invalid automation response.",
					),
				);
			}
		});
		socket.on("error", () =>
			finish(
				new AutomationClientError(
					connected ? "CONNECTION_LOST" : "APP_NOT_RUNNING",
					connected
						? "Application connection was lost; inspect application state before retrying."
						: "Cannot connect to Screendance App. Start the app with automation enabled or use --launch APP_PATH.",
				),
			),
		);
		socket.on("end", () =>
			finish(
				new AutomationClientError(
					"CONNECTION_LOST",
					"Application closed the connection before replying; inspect state before retrying.",
				),
			),
		);
	});
}

async function launchApp(path: string, timeoutMs: number): Promise<void> {
	if (process.platform !== "darwin")
		throw new AutomationClientError(
			"UNSUPPORTED_PLATFORM",
			"Automatic application launch currently requires macOS.",
		);
	await new Promise<void>((resolveLaunch, reject) => {
		const launchEnvironment = { ...process.env };
		delete launchEnvironment.ELECTRON_RUN_AS_NODE;
		const child = spawn(
			"/usr/bin/open",
			["-g", "-a", resolve(path), "--args", "--automation"],
			{ stdio: "ignore", timeout: timeoutMs, env: launchEnvironment },
		);
		child.once("error", () =>
			reject(
				new AutomationClientError(
					"LAUNCH_FAILED",
					"Could not launch the specified application.",
				),
			),
		);
		child.once("exit", (code) =>
			code === 0
				? resolveLaunch()
				: reject(
						new AutomationClientError(
							"LAUNCH_FAILED",
							"macOS could not open the specified application.",
						),
					),
		);
	});
}

export async function callAutomation(
	options: ClientOptions,
	method: string,
	params: Record<string, unknown> = {},
): Promise<unknown> {
	options = { ...options, launch: options.launch ?? process.env.SCREENDANCE_APP_BUNDLE };
	const timeoutMs = options.timeoutMs ?? 120_000;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
		throw new AutomationClientError(
			"INVALID_ARGUMENT",
			"timeout-ms must be an integer between 1 and 600000.",
		);
	const deadline = Date.now() + timeoutMs;
	try {
		return await requestOnce(options, method, params, timeoutMs);
	} catch (error) {
		if (
			!(error instanceof AutomationClientError) ||
			error.code !== "APP_NOT_RUNNING" ||
			!options.launch
		)
			throw error;
	}
	await launchApp(options.launch, Math.max(1, deadline - Date.now()));
	while (Date.now() < deadline) {
		try {
			return await requestOnce(options, method, params, Math.max(1, deadline - Date.now()));
		} catch (error) {
			if (!(error instanceof AutomationClientError) || error.code !== "APP_NOT_RUNNING")
				throw error;
		}
		await new Promise((resolveWait) =>
			setTimeout(resolveWait, Math.min(150, Math.max(1, deadline - Date.now()))),
		);
	}
	throw new AutomationClientError(
		"APP_NOT_RUNNING",
		"Application did not publish an automation endpoint before the timeout. Enable automation in the launched app and check the endpoint path.",
	);
}

export function exitCodeForError(code: string): number {
	if (
		[
			"INVALID_ARGUMENT",
			"INVALID_PARAMS",
			"UNKNOWN_METHOD",
			"UNKNOWN_COMMAND",
			"METHOD_NOT_FOUND",
			"INVALID_REQUEST",
		].includes(code)
	)
		return 2;
	if (
		[
			"APP_NOT_RUNNING",
			"LAUNCH_FAILED",
			"CONNECTION_LOST",
			"INVALID_ENDPOINT",
			"PROTOCOL_MISMATCH",
		].includes(code)
	)
		return 3;
	if (["UNAUTHORIZED", "FORBIDDEN", "ACCESS_DENIED"].includes(code)) return 4;
	if (code === "TIMEOUT") return 5;
	return 1;
}
