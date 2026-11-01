import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { AutomationError } from "../../shared/automation";

type Identity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
export interface PreparedAutomationOutput {
	readonly path: string;
	readonly parent: string;
	readonly parentDev: bigint;
	readonly parentIno: bigint;
	readonly existing: Identity | null;
}
const prepared = new WeakSet<PreparedAutomationOutput>();
function identity(stat: BigIntStats): Identity {
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
	};
}
function sameIdentity(left: Identity, right: Identity): boolean {
	return Object.keys(left).every(
		(key) => left[key as keyof Identity] === right[key as keyof Identity],
	);
}
async function inspect(file: string): Promise<Identity | null> {
	try {
		const stat = await fs.lstat(file, { bigint: true });
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new AutomationError(
				"INVALID_PATH",
				"Output cannot replace a symlink or special file.",
			);
		return identity(stat);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
export async function prepareAutomationOutput(
	outputPath: unknown,
	overwrite: unknown,
): Promise<PreparedAutomationOutput> {
	if (
		typeof outputPath !== "string" ||
		!path.isAbsolute(outputPath) ||
		outputPath.includes("\0") ||
		![".mp4", ".gif", ".mov", ".webm"].includes(path.extname(outputPath).toLowerCase())
	)
		throw new AutomationError(
			"INVALID_PARAMS",
			"An absolute .mp4/.gif/.mov/.webm output path is required.",
		);
	if (overwrite !== undefined && typeof overwrite !== "boolean")
		throw new AutomationError("INVALID_PARAMS", "overwrite must be boolean.");
	let parent: string;
	try {
		parent = await fs.realpath(path.dirname(outputPath));
	} catch {
		throw new AutomationError("INVALID_PATH", "Output directory must already exist.");
	}
	const stat = await fs.lstat(parent, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new AutomationError("INVALID_PATH", "Invalid output directory.");
	const filename = path.join(parent, path.basename(outputPath));
	const existing = await inspect(filename);
	if (existing && overwrite !== true)
		throw new AutomationError(
			"OUTPUT_EXISTS",
			"Output exists; choose another path or explicitly set overwrite=true.",
		);
	const target = Object.freeze({
		path: filename,
		parent,
		parentDev: stat.dev,
		parentIno: stat.ino,
		existing: existing ? Object.freeze(existing) : null,
	});
	prepared.add(target);
	return target;
}
async function assertTarget(target: PreparedAutomationOutput) {
	if (!prepared.has(target))
		throw new AutomationError(
			"ACCESS_DENIED",
			"Output target was not prepared by this application.",
		);
	let parent: BigIntStats;
	try {
		parent = await fs.lstat(target.parent, { bigint: true });
	} catch {
		throw new AutomationError("TARGET_CHANGED", "Output directory changed while rendering.");
	}
	if (
		!parent.isDirectory() ||
		parent.isSymbolicLink() ||
		parent.dev !== target.parentDev ||
		parent.ino !== target.parentIno ||
		(await fs.realpath(target.parent)) !== target.parent
	)
		throw new AutomationError("TARGET_CHANGED", "Output directory changed while rendering.");
	const current = await inspect(target.path);
	if (
		(target.existing === null) !== (current === null) ||
		(current && target.existing && !sameIdentity(current, target.existing))
	)
		throw new AutomationError(
			"TARGET_CHANGED",
			"Output target changed while rendering; save the retained result to a new path.",
		);
}
/** Copy from an opened regular-file descriptor; never follow a swapped source symlink. */
async function copyRetainedOutput(
	source: string,
	destination: string,
	signal: AbortSignal,
): Promise<void> {
	let input;
	try {
		input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP")
			throw new AutomationError("INVALID_OUTPUT", "Retained output must not be a symlink.");
		throw error;
	}
	try {
		const original = await input.stat({ bigint: true });
		if (!original.isFile() || original.size < 1n)
			throw new AutomationError(
				"INVALID_OUTPUT",
				"Retained output must be a nonempty regular file.",
			);
		const output = await fs.open(destination, "wx", 0o600);
		try {
			const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
			let position = 0;
			while (true) {
				signal.throwIfAborted();
				const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
				if (!bytesRead) break;
				let written = 0;
				while (written < bytesRead) {
					signal.throwIfAborted();
					const result = await output.write(
						buffer,
						written,
						bytesRead - written,
						position + written,
					);
					if (result.bytesWritten === 0)
						throw new AutomationError(
							"OUTPUT_WRITE_FAILED",
							"Output copy stopped making progress.",
						);
					written += result.bytesWritten;
				}
				position += bytesRead;
			}
			if (!sameIdentity(identity(original), identity(await input.stat({ bigint: true }))))
				throw new AutomationError(
					"SOURCE_CHANGED",
					"Retained output changed while it was being copied.",
				);
			await output.sync();
		} finally {
			await output.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP")
			throw new AutomationError("INVALID_OUTPUT", "Retained output must not be a symlink.");
		throw error;
	} finally {
		await input.close();
	}
}
/** Copy the retained complete artifact, then atomically publish after the cancel boundary. */
export async function publishAutomationOutput(
	target: PreparedAutomationOutput,
	source: string,
	signal: AbortSignal,
	beginCommit: () => void,
) {
	const temporary = path.join(
		target.parent,
		`.screendance-export-${randomUUID()}${path.extname(target.path)}`,
	);
	let committed = false;
	try {
		signal.throwIfAborted();
		await assertTarget(target);
		if ((await fs.realpath(source)) === target.path)
			throw new AutomationError(
				"INVALID_OUTPUT",
				"Output destination cannot replace its retained source artifact.",
			);
		await copyRetainedOutput(source, temporary, signal);
		signal.throwIfAborted();
		await assertTarget(target);
		beginCommit();
		if (target.existing) await fs.rename(temporary, target.path);
		else {
			try {
				await fs.link(temporary, target.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST")
					throw new AutomationError(
						"TARGET_CHANGED",
						"Another file appeared at the output path before publication.",
					);
				throw error;
			}
		}
		committed = true;
		const directory = await fs.open(target.parent, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
		return { outputPath: target.path, bytes: (await fs.stat(target.path)).size };
	} catch (error) {
		if (committed)
			throw new AutomationError(
				"OUTPUT_COMMITTED",
				"Output was written but final synchronization failed; inspect it before retrying.",
				{ outputPath: target.path, committed: true },
			);
		throw error;
	} finally {
		await fs.unlink(temporary).catch(() => {
			// The temporary may already have been moved; preserve the publication result.
		});
	}
}
