import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistAutomationProject, prepareAutomationProjectSave } from "./projectSave";

let directory: string;
const project = {
	version: 1,
	videoPath: "/Users/me/Мой фильм.mov",
	editor: {
		wallpaper: "#123456",
		clipRegions: [{ id: "clip-1", startMs: 100, endMs: 1000, speed: 2 }],
	},
};

beforeEach(async () => {
	directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sd-save-")));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(directory, { recursive: true, force: true });
});

async function expectNoTemporaryFiles() {
	expect(
		(await fs.readdir(directory)).filter(
			(name) => name.startsWith(".screendance-") && name.endsWith(".tmp"),
		),
	).toEqual([]);
}

describe("automation project save preparation", () => {
	it("requires Save As for a fresh document and performs no writes during preparation", async () => {
		await expect(
			prepareAutomationProjectSave(undefined, null, undefined),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		const target = path.join(directory, "Мой проект.scrdance");
		expect(await prepareAutomationProjectSave(target, null, undefined)).toEqual({
			path: target,
			overwrite: false,
		});
		expect(await fs.readdir(directory)).toEqual([]);
	});

	it.each([
		"relative.scrdance",
		"/tmp/file.mp4",
		"",
		null,
		7,
		"/tmp/bad\0.scrdance",
	])("rejects invalid save path %j", async (target) => {
		await expect(prepareAutomationProjectSave(target, null, undefined)).rejects.toMatchObject({
			code: "INVALID_PARAMS",
		});
	});

	it("rejects missing/non-directory parents and nonboolean overwrite policies", async () => {
		await expect(
			prepareAutomationProjectSave(
				path.join(directory, "missing", "project.scrdance"),
				null,
				false,
			),
		).rejects.toMatchObject({ code: "INVALID_PATH" });
		const file = path.join(directory, "file");
		await fs.writeFile(file, "ordinary file");
		await expect(
			prepareAutomationProjectSave(path.join(file, "project.scrdance"), null, false),
		).rejects.toMatchObject({ code: "INVALID_PATH" });
		await expect(
			prepareAutomationProjectSave(path.join(directory, "project.scrdance"), null, "true"),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
	});

	it("canonicalizes the parent and recognizes the current project through a parent alias", async () => {
		const parent = path.join(directory, "real");
		const alias = path.join(directory, "alias");
		await fs.mkdir(parent);
		await fs.symlink(parent, alias);
		const target = path.join(parent, "project.RECORDLY");
		await fs.writeFile(target, "existing");
		const prepared = await prepareAutomationProjectSave(
			path.join(alias, "project.RECORDLY"),
			target,
			false,
		);
		expect(prepared).toEqual({ path: target, overwrite: true });
		expect(Object.isFrozen(prepared)).toBe(true);
	});

	it("allows current-project saves and requires explicit overwrite for a different existing file", async () => {
		const target = path.join(directory, "existing.scrdance");
		await fs.writeFile(target, "old project");
		expect(await prepareAutomationProjectSave(undefined, target, undefined)).toEqual({
			path: target,
			overwrite: true,
		});
		await expect(
			prepareAutomationProjectSave(target, "/different/project.scrdance", false),
		).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
		expect(await prepareAutomationProjectSave(target, null, true)).toEqual({
			path: target,
			overwrite: true,
		});
		expect(await fs.readFile(target, "utf8")).toBe("old project");
	});

	it.each([
		false,
		true,
	])("refuses symlink targets even with overwrite=true (dangling=%s)", async (dangling) => {
		const actual = path.join(directory, "actual.scrdance");
		const alias = path.join(directory, "alias.scrdance");
		if (!dangling) await fs.writeFile(actual, "keep");
		await fs.symlink(actual, alias);
		await expect(prepareAutomationProjectSave(alias, alias, true)).rejects.toMatchObject({
			code: "INVALID_PATH",
		});
		if (!dangling) expect(await fs.readFile(actual, "utf8")).toBe("keep");
	});

	it("refuses a directory with a project extension", async () => {
		const target = path.join(directory, "folder.scrdance");
		await fs.mkdir(target);
		await expect(prepareAutomationProjectSave(target, null, true)).rejects.toMatchObject({
			code: "INVALID_PATH",
		});
	});
});

describe("atomic automation project persistence", () => {
	it("writes a complete private project, generates a UUID, and preserves all authored data", async () => {
		const target = path.join(directory, "Мой проект.scrdance");
		const prepared = await prepareAutomationProjectSave(target, null, undefined);
		const result = await persistAutomationProject(prepared, project);
		expect(result).toMatchObject({
			path: target,
			projectId: expect.stringMatching(
				/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
			),
		});
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({
			...project,
			projectId: result.projectId,
		});
		expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
		expect(project).not.toHaveProperty("projectId");
		await expectNoTemporaryFiles();
	});

	it("preserves legacy nonempty project ids when atomically replacing the current file", async () => {
		const target = path.join(directory, "current.recordly");
		await fs.writeFile(target, "old project");
		const originalStat = await fs.stat(target);
		const prepared = await prepareAutomationProjectSave(undefined, target, undefined);
		const originalRename = fs.rename.bind(fs);
		const rename = vi.spyOn(fs, "rename").mockImplementation(async (temporary, destination) => {
			expect(await fs.readFile(target, "utf8")).toBe("old project");
			expect(JSON.parse(await fs.readFile(temporary, "utf8"))).toEqual({
				...project,
				projectId: "legacy-project-id",
			});
			expect((await fs.stat(temporary)).mode & 0o777).toBe(0o600);
			return originalRename(temporary, destination);
		});
		expect(
			await persistAutomationProject(prepared, {
				...project,
				projectId: "legacy-project-id",
			}),
		).toEqual({ path: target, projectId: "legacy-project-id" });
		expect(rename).toHaveBeenCalledTimes(1);
		expect((await fs.stat(target)).ino).not.toBe(originalStat.ino);
		await expectNoTemporaryFiles();
	});

	it.each([
		null,
		[],
		{ version: 2, videoPath: "/source.mov", editor: {} },
		{ version: 1, videoPath: " ", editor: {} },
		{ version: 1, videoPath: "/source.mov", editor: [] },
		{ version: 1, videoPath: "/source.mov", editor: {}, projectId: 123 },
	])("rejects malformed snapshots before touching the old file: %j", async (snapshot) => {
		const target = path.join(directory, "current.scrdance");
		await fs.writeFile(target, "keep");
		const prepared = await prepareAutomationProjectSave(undefined, target, undefined);
		await expect(persistAutomationProject(prepared, snapshot)).rejects.toMatchObject({
			code: "INVALID_PROJECT",
		});
		expect(await fs.readFile(target, "utf8")).toBe("keep");
		await expectNoTemporaryFiles();
	});

	it("rejects unserializable or oversized UTF-8 snapshots before creating temporary files", async () => {
		const target = path.join(directory, "project.scrdance");
		const prepared = await prepareAutomationProjectSave(target, null, false);
		const circular = { ...project, editor: {} as Record<string, unknown> };
		circular.editor.self = circular;
		await expect(persistAutomationProject(prepared, circular)).rejects.toMatchObject({
			code: "INVALID_PROJECT",
		});
		await expect(
			persistAutomationProject(prepared, {
				...project,
				editor: { text: "я".repeat(9 * 1024 * 1024) },
			}),
		).rejects.toMatchObject({ code: "INVALID_PROJECT" });
		await expect(
			persistAutomationProject(prepared, { ...project, toJSON: () => null }),
		).rejects.toMatchObject({ code: "INVALID_PROJECT" });
		expect(await fs.readdir(directory)).toEqual([]);
	});

	it("rejects a forged prepared target", async () => {
		await expect(
			persistAutomationProject(
				{ path: path.join(directory, "project.scrdance"), overwrite: true },
				project,
			),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		expect(await fs.readdir(directory)).toEqual([]);
	});

	it("refuses a file appearing between preparation and saving even if overwrite was allowed", async () => {
		const target = path.join(directory, "project.scrdance");
		const prepared = await prepareAutomationProjectSave(target, null, true);
		await fs.writeFile(target, "competing project");
		await expect(persistAutomationProject(prepared, project)).rejects.toMatchObject({
			code: "TARGET_CHANGED",
		});
		expect(await fs.readFile(target, "utf8")).toBe("competing project");
		await expectNoTemporaryFiles();
	});

	it("uses exclusive publication to prevent overwriting a file created at the final write boundary", async () => {
		const target = path.join(directory, "project.scrdance");
		const prepared = await prepareAutomationProjectSave(target, null, false);
		const originalLink = fs.link.bind(fs);
		vi.spyOn(fs, "link").mockImplementation(async (temporary, destination) => {
			await fs.writeFile(destination, "race winner");
			return originalLink(temporary, destination);
		});
		await expect(persistAutomationProject(prepared, project)).rejects.toMatchObject({
			code: "OUTPUT_EXISTS",
		});
		expect(await fs.readFile(target, "utf8")).toBe("race winner");
		await expectNoTemporaryFiles();
	});

	it.each([
		"replace",
		"modify",
		"symlink",
		"remove",
	])("refuses changed overwrite targets: %s", async (change) => {
		const target = path.join(directory, "project.scrdance");
		await fs.writeFile(target, "old");
		const prepared = await prepareAutomationProjectSave(undefined, target, true);
		if (change === "replace") {
			const replacement = path.join(directory, "replacement");
			await fs.writeFile(replacement, "new");
			await fs.rename(replacement, target);
		} else if (change === "modify") await fs.writeFile(target, "new");
		else {
			await fs.unlink(target);
			if (change === "symlink") await fs.symlink("/missing/source.scrdance", target);
		}
		await expect(persistAutomationProject(prepared, project)).rejects.toMatchObject({
			code: "TARGET_CHANGED",
		});
		if (change === "replace" || change === "modify")
			expect(await fs.readFile(target, "utf8")).toBe("new");
		if (change === "symlink") expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
		await expectNoTemporaryFiles();
	});

	it("refuses a replaced parent directory without writing to it", async () => {
		const parent = path.join(directory, "parent");
		await fs.mkdir(parent);
		const prepared = await prepareAutomationProjectSave(
			path.join(parent, "project.scrdance"),
			null,
			false,
		);
		await fs.rename(parent, path.join(directory, "previous-parent"));
		await fs.mkdir(parent);
		await expect(persistAutomationProject(prepared, project)).rejects.toMatchObject({
			code: "TARGET_CHANGED",
		});
		expect(await fs.readdir(parent)).toEqual([]);
	});

	it("rechecks overwrite identity after writing the sibling and refuses a late symlink swap", async () => {
		const target = path.join(directory, "current.scrdance");
		const protectedTarget = path.join(directory, "protected.scrdance");
		await fs.writeFile(target, "old project");
		await fs.writeFile(protectedTarget, "protected project");
		const prepared = await prepareAutomationProjectSave(undefined, target, undefined);
		const originalOpen = fs.open.bind(fs);
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const file = await originalOpen(...args);
			if (args[1] === "wx") {
				const originalSync = file.sync.bind(file);
				vi.spyOn(file, "sync").mockImplementationOnce(async () => {
					await originalSync();
					await fs.rename(target, path.join(directory, "old-project-backup"));
					await fs.symlink(protectedTarget, target);
				});
			}
			return file;
		});
		await expect(persistAutomationProject(prepared, project)).rejects.toMatchObject({
			code: "TARGET_CHANGED",
		});
		expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(protectedTarget, "utf8")).toBe("protected project");
		expect(await fs.readFile(path.join(directory, "old-project-backup"), "utf8")).toBe(
			"old project",
		);
		await expectNoTemporaryFiles();
	});

	it("leaves the original intact and removes the sibling file when syncing its contents fails", async () => {
		const target = path.join(directory, "current.scrdance");
		await fs.writeFile(target, "old project");
		const prepared = await prepareAutomationProjectSave(undefined, target, undefined);
		const originalOpen = fs.open.bind(fs);
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const file = await originalOpen(...args);
			if (args[1] === "wx")
				vi.spyOn(file, "sync").mockRejectedValueOnce(new Error("Simulated disk failure"));
			return file;
		});
		await expect(persistAutomationProject(prepared, project)).rejects.toMatchObject({
			code: "SAVE_FAILED",
			details: { committed: false },
		});
		expect(await fs.readFile(target, "utf8")).toBe("old project");
		await expectNoTemporaryFiles();
	});

	it("reports an ambiguous durability failure after publication without removing the saved project", async () => {
		const target = path.join(directory, "project.scrdance");
		const prepared = await prepareAutomationProjectSave(target, null, false);
		const originalOpen = fs.open.bind(fs);
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const file = await originalOpen(...args);
			if (args[1] === "r")
				vi.spyOn(file, "sync").mockRejectedValueOnce(new Error("Directory fsync failed"));
			return file;
		});
		await expect(persistAutomationProject(prepared, project)).rejects.toMatchObject({
			code: "SAVE_FAILED",
			details: { path: target, committed: true },
		});
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toMatchObject(project);
		await expectNoTemporaryFiles();
	});
});
