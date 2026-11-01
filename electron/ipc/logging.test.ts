import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ directory: "" }));
vi.mock("electron", () => ({
	app: { getPath: () => state.directory },
	ipcMain: { handle: vi.fn() },
	clipboard: { writeText: vi.fn() },
}));

import { clearAppLogs, getLogFilePath } from "./logging";

it("clears only the known app log, recreates it privately, and refuses a symlink to another file", async () => {
	state.directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sd-log-")));
	try {
		const filename = getLogFilePath();
		await fs.writeFile(filename, "previous diagnostics");
		await expect(clearAppLogs()).resolves.toEqual({ success: true });
		expect(await fs.readFile(filename, "utf8")).toMatch(/^=== Logs Cleared at /);
		await fs.unlink(filename);
		await expect(clearAppLogs()).resolves.toEqual({ success: true });
		expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
		await fs.unlink(filename);
		const outside = path.join(state.directory, "keep.txt");
		await fs.writeFile(outside, "keep this content");
		await fs.symlink(outside, filename);
		await expect(clearAppLogs()).resolves.toMatchObject({ success: false });
		expect(await fs.readFile(outside, "utf8")).toBe("keep this content");
	} finally {
		await fs.rm(state.directory, { recursive: true, force: true });
	}
});
