import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistPreview, preflightOpen, preparePreviewPath, requireLocalFile } from "./files";

let directory: string;
beforeEach(async () => {
	directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sd-file-")));
});
afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5YQAAAAASUVORK5CYII=",
	"base64",
);
const preview = { pngDataUrl: `data:image/png;base64,${png.toString("base64")}`, timeMs: 5000 };

describe("automation filesystem preflight", () => {
	it("requires regular absolute files and resolves symlinks before checking format", async () => {
		await expect(requireLocalFile("relative.mp4")).rejects.toMatchObject({
			code: "INVALID_PARAMS",
		});
		await expect(requireLocalFile(directory)).rejects.toMatchObject({ code: "INVALID_PATH" });
		await expect(requireLocalFile(path.join(directory, "missing.mov"))).rejects.toMatchObject({
			code: "FILE_UNAVAILABLE",
		});
		const source = path.join(directory, "Моё видео.MOV");
		await fs.writeFile(source, "media fixture");
		const alias = path.join(directory, "alias.mp4");
		await fs.symlink(source, alias);
		expect(await preflightOpen("video.open", alias)).toBe(source);
		await expect(preflightOpen("project.open", source)).rejects.toMatchObject({
			code: "UNSUPPORTED_FORMAT",
		});
	});

	it("validates project media including file URLs and webcam before opening", async () => {
		const source = path.join(directory, "Мой фильм.mov");
		const camera = path.join(directory, "camera.mp4");
		await fs.writeFile(source, "source");
		await fs.writeFile(camera, "camera");
		const projectPath = path.join(directory, "session.scrdance");
		const data = {
			version: 1,
			videoPath: pathToFileURL(source).href,
			editor: { webcam: { sourcePath: pathToFileURL(camera).href } },
		};
		await fs.writeFile(projectPath, `\uFEFF${JSON.stringify(data)}`);
		expect(await preflightOpen("project.open", projectPath)).toBe(projectPath);
		await fs.rm(camera);
		await expect(preflightOpen("project.open", projectPath)).rejects.toMatchObject({
			code: "FILE_UNAVAILABLE",
		});
	});

	it.each([
		"{invalid",
		"null",
		"[]",
		'{"version":2,"videoPath":"/tmp/a","editor":{}}',
		'{"version":1,"videoPath":"/tmp/a","editor":[]}',
	])("rejects malformed or unsupported projects: %s", async (data) => {
		const file = path.join(directory, "invalid.recordly");
		await fs.writeFile(file, data);
		await expect(preflightOpen("project.open", file)).rejects.toMatchObject({
			code: "INVALID_PROJECT",
		});
	});

	it("rejects oversized projects before parsing", async () => {
		const file = path.join(directory, "large.scrdance");
		await fs.writeFile(file, Buffer.alloc(16 * 1024 * 1024 + 1));
		await expect(preflightOpen("project.open", file)).rejects.toMatchObject({
			code: "INVALID_PROJECT",
		});
	});
});

describe("automation preview persistence", () => {
	it("writes a private PNG and reports actual image dimensions without returning base64", async () => {
		const outputPath = await preparePreviewPath(path.join(directory, "Кадр.png"));
		expect(await persistPreview(outputPath, preview)).toEqual({
			outputPath,
			timeMs: 5000,
			bytes: png.length,
			width: 1,
			height: 1,
		});
		expect(await fs.readFile(outputPath)).toEqual(png);
		expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o600);
	});

	it("never overwrites existing files even when created after preflight", async () => {
		const outputPath = await preparePreviewPath(path.join(directory, "frame.png"));
		await fs.writeFile(outputPath, "keep this");
		await expect(persistPreview(outputPath, preview)).rejects.toMatchObject({
			code: "OUTPUT_EXISTS",
		});
		await expect(preparePreviewPath(outputPath)).rejects.toMatchObject({
			code: "OUTPUT_EXISTS",
		});
		expect(await fs.readFile(outputPath, "utf8")).toBe("keep this");
	});

	it("refuses symlink output destinations including dangling links", async () => {
		const destination = path.join(directory, "destination.png");
		const outputPath = path.join(directory, "frame.png");
		await fs.symlink(destination, outputPath);
		await expect(preparePreviewPath(outputPath)).rejects.toMatchObject({
			code: "OUTPUT_EXISTS",
		});
		await expect(persistPreview(outputPath, preview)).rejects.toMatchObject({
			code: "OUTPUT_EXISTS",
		});
		await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each([
		"relative.png",
		"/tmp/not-a-png.jpg",
		"/tmp/nonexistent-directory-for-sd/frame.png",
	])("rejects invalid destinations: %s", async (outputPath) => {
		await expect(preparePreviewPath(outputPath)).rejects.toMatchObject({
			code: outputPath.endsWith("frame.png") ? "INVALID_PATH" : "INVALID_PARAMS",
		});
	});

	it.each([
		null,
		{},
		{ pngDataUrl: "data:image/jpeg;base64,AA==" },
		{ pngDataUrl: "data:image/png;base64,AA==" },
	])("refuses invalid image payloads without creating a file: %j", async (value) => {
		const outputPath = path.join(directory, "invalid.png");
		await expect(persistPreview(outputPath, value)).rejects.toMatchObject({
			code: "INVALID_PREVIEW",
		});
		await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
