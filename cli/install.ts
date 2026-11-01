import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutomationClientError } from "./client";

export function installedLauncher(): string {
	return process.env.SCREENDANCE_CLI_PATH ?? fileURLToPath(import.meta.url);
}
export async function installCli(
	directory = path.join(os.homedir(), ".local/bin"),
	remove = false,
) {
	const target = await fs.realpath(installedLauncher());
	const destination = path.join(path.resolve(directory), "screendance");
	let existing: Awaited<ReturnType<typeof fs.lstat>> | undefined;
	try {
		existing = await fs.lstat(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existing) {
		if (
			!existing.isSymbolicLink() ||
			(await fs.realpath(destination).catch(() => "")) !== target
		)
			throw new AutomationClientError(
				"OUTPUT_EXISTS",
				"An unrelated file or link already uses this CLI path. Choose another directory.",
			);
		if (remove) await fs.unlink(destination);
	} else if (!remove) {
		await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
		await fs.symlink(target, destination);
	}
	return {
		installed: !remove,
		path: destination,
		launcher: target,
		pathHint: `Add ${path.dirname(destination)} to PATH if needed.`,
	};
}
const quote = (value: string) => `'${value.split("'").join("'\\''")}'`;
export function clientSetup(client: string) {
	if (!["codex", "claude"].includes(client))
		throw new AutomationClientError("INVALID_ARGUMENT", "setup requires codex or claude.");
	const executable = installedLauncher();
	const prefix = process.env.SCREENDANCE_CLI_PATH
		? quote(executable)
		: `${quote(process.execPath)} ${quote(executable)}`;
	return {
		client,
		command:
			client === "codex"
				? `codex mcp add screendance -- ${prefix} mcp serve`
				: `claude mcp add --transport stdio screendance -- ${prefix} mcp serve`,
		applied: false,
	};
}
