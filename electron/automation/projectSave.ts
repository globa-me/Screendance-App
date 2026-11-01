import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { AutomationError } from "../../shared/automation";

const MAX_PROJECT_BYTES = 16 * 1024 * 1024;

export interface PreparedAutomationProjectSave {
	readonly path: string;
	readonly overwrite: boolean;
}

interface SaveIdentity {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

interface PreparedSaveContext {
	path: string;
	parent: string;
	parentDev: bigint;
	parentIno: bigint;
	existing: SaveIdentity | null;
}

// Prepared targets stay in the main process. Renderer data cannot supply or alter
// the filesystem identities captured before it provides the document snapshot.
const preparedSaves = new WeakMap<PreparedAutomationProjectSave, PreparedSaveContext>();

function validateSavePath(value: unknown): asserts value is string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.includes("\0") ||
		!path.isAbsolute(value) ||
		![".scrdance", ".recordly"].includes(path.extname(value).toLowerCase())
	) {
		throw new AutomationError(
			"INVALID_PARAMS",
			"An absolute .scrdance or .recordly save path is required; use Save As for an unsaved project.",
		);
	}
}

function identity(stat: BigIntStats): SaveIdentity {
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
	};
}

async function inspectTarget(target: string): Promise<SaveIdentity | null> {
	try {
		const stat = await fs.lstat(target, { bigint: true });
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new AutomationError(
				"INVALID_PATH",
				"Project save target must be a regular file; symlinks and directories are refused.",
			);
		}
		return identity(stat);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		if (error instanceof AutomationError) throw error;
		throw new AutomationError("INVALID_PATH", "Cannot inspect the project save target.");
	}
}

/** Read-only preparation. Existing files require explicit overwrite or the trusted current path. */
export async function prepareAutomationProjectSave(
	filePath: unknown,
	currentPath: string | null,
	overwrite: unknown,
): Promise<PreparedAutomationProjectSave> {
	if (overwrite !== undefined && typeof overwrite !== "boolean") {
		throw new AutomationError("INVALID_PARAMS", "overwrite must be a boolean.");
	}
	const requested = filePath === undefined ? currentPath : filePath;
	validateSavePath(requested);
	let parent: string;
	let parentStat: BigIntStats;
	try {
		parent = await fs.realpath(path.dirname(requested));
		parentStat = await fs.lstat(parent, { bigint: true });
		if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
			throw new Error("Not a directory");
	} catch {
		throw new AutomationError(
			"INVALID_PATH",
			"Project save directory does not exist or is not accessible.",
		);
	}
	const target = path.join(parent, path.basename(requested));
	let currentTarget: string | null = null;
	if (currentPath && path.isAbsolute(currentPath)) {
		try {
			currentTarget = path.join(
				await fs.realpath(path.dirname(currentPath)),
				path.basename(currentPath),
			);
		} catch {
			/* A different Save As path does not depend on the old directory still existing. */
		}
	}
	const allowOverwrite = overwrite === true || target === currentTarget;
	const existing = await inspectTarget(target);
	if (existing && !allowOverwrite) {
		throw new AutomationError(
			"OUTPUT_EXISTS",
			"A different project already exists at this path; set overwrite=true to replace it.",
		);
	}
	const prepared = Object.freeze({ path: target, overwrite: allowOverwrite });
	preparedSaves.set(prepared, {
		path: target,
		parent,
		parentDev: parentStat.dev,
		parentIno: parentStat.ino,
		existing,
	});
	return prepared;
}

function isProject(
	value: unknown,
): value is Record<string, unknown> & { videoPath: string; editor: Record<string, unknown> } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const project = value as Record<string, unknown>;
	return (
		project.version === 1 &&
		typeof project.videoPath === "string" &&
		!!project.videoPath.trim() &&
		!project.videoPath.includes("\0") &&
		!!project.editor &&
		typeof project.editor === "object" &&
		!Array.isArray(project.editor) &&
		(project.projectId === undefined || typeof project.projectId === "string")
	);
}

function encodeProject(value: unknown): { content: string; projectId: string } {
	if (!isProject(value))
		throw new AutomationError(
			"INVALID_PROJECT",
			"Expected a version 1 project with videoPath and editor.",
		);
	const projectId =
		typeof value.projectId === "string" && value.projectId.trim()
			? value.projectId
			: randomUUID();
	let content: string;
	try {
		content = `${JSON.stringify({ ...value, projectId }, null, 2)}\n`;
		const encoded: unknown = JSON.parse(content);
		if (!isProject(encoded) || encoded.projectId !== projectId)
			throw new Error("Invalid encoded project");
	} catch {
		throw new AutomationError("INVALID_PROJECT", "Project cannot be serialized as valid JSON.");
	}
	if (Buffer.byteLength(content, "utf8") > MAX_PROJECT_BYTES) {
		throw new AutomationError("INVALID_PROJECT", "Project file exceeds 16 MiB.");
	}
	return { content, projectId };
}

async function checkParent(context: PreparedSaveContext): Promise<void> {
	try {
		const stat = await fs.lstat(context.parent, { bigint: true });
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.dev !== context.parentDev ||
			stat.ino !== context.parentIno ||
			(await fs.realpath(context.parent)) !== context.parent
		)
			throw new Error("Directory changed");
	} catch {
		throw new AutomationError(
			"TARGET_CHANGED",
			"Project save directory changed while preparing the save; retry with a new target.",
		);
	}
}

async function checkTarget(context: PreparedSaveContext): Promise<void> {
	let current: SaveIdentity | null;
	try {
		current = await inspectTarget(context.path);
	} catch {
		throw new AutomationError(
			"TARGET_CHANGED",
			"Project save target changed or became a symlink; prepare the save again.",
		);
	}
	const expected = context.existing;
	if (expected === null && current === null) return;
	if (
		!expected ||
		!current ||
		Object.keys(expected).some(
			(key) => expected[key as keyof SaveIdentity] !== current[key as keyof SaveIdentity],
		)
	) {
		throw new AutomationError(
			"TARGET_CHANGED",
			"Project save target changed while preparing the save; prepare the save again.",
		);
	}
}

/** Persist a complete, synced sibling file before atomically publishing it. */
export async function persistAutomationProject(
	prepared: PreparedAutomationProjectSave,
	projectData: unknown,
): Promise<{ path: string; projectId: string }> {
	const context = preparedSaves.get(prepared);
	if (!context)
		throw new AutomationError("INVALID_PARAMS", "A prepared project save target is required.");
	const { content, projectId } = encodeProject(projectData);
	await checkParent(context);
	await checkTarget(context);
	const temporary = path.join(context.parent, `.screendance-${randomUUID()}.tmp`);
	let temporaryCreated = false;
	let committed = false;
	let failure: unknown;
	try {
		const file = await fs.open(temporary, "wx", 0o600);
		temporaryCreated = true;
		try {
			await file.chmod(0o600);
			await file.writeFile(content, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await checkParent(context);
		await checkTarget(context);
		if (context.existing) {
			// rename replaces the directory entry and never follows a target symlink.
			await fs.rename(temporary, context.path);
			temporaryCreated = false;
		} else {
			try {
				await fs.link(temporary, context.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST")
					throw new AutomationError(
						"OUTPUT_EXISTS",
						"A file appeared at the save target; choose a new path.",
					);
				throw error;
			}
		}
		committed = true;
		if (temporaryCreated) {
			await fs.unlink(temporary);
			temporaryCreated = false;
		}
		const directory = await fs.open(context.parent, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} catch (error) {
		failure = error;
	} finally {
		if (temporaryCreated) {
			try {
				await fs.unlink(temporary);
			} catch (error) {
				failure ??= error;
			}
		}
	}
	if (failure) {
		if (failure instanceof AutomationError) throw failure;
		throw new AutomationError(
			"SAVE_FAILED",
			committed
				? "Project was written, but final synchronization or cleanup failed; inspect the saved file before retrying."
				: "Project could not be saved; the target was not replaced.",
			{ path: context.path, committed },
		);
	}
	return { path: context.path, projectId };
}
