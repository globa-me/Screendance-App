import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dialog, ipcMain } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getAppPath: () => process.cwd(),
		getPath: () => process.env.TEMP ?? process.cwd(),
		isPackaged: false,
	},
	BrowserWindow: {
		fromWebContents: () => null,
	},
	dialog: {
		showSaveDialog: vi.fn(),
	},
	ipcMain: {
		handle: vi.fn(),
		on: vi.fn(),
	},
	powerSaveBlocker: {
		isStarted: () => true,
		start: () => 1,
		stop: vi.fn(),
	},
}));

vi.mock("../ffmpeg/binary", () => ({
	getFfmpegBinaryPath: () => "ffmpeg",
	getFfprobeBinaryPath: () => "ffprobe",
}));

import {
	buildWebmToProResArgs,
	getProResAlphaValidationError,
	moveExportedTempFile,
	parseAlphaSignalStats,
	registerExportHandlers,
} from "./export";

const tempDirs: string[] = [];

async function makeTempDir() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-export-move-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.allSettled(
		tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
	);
});

describe("select-export-destination", () => {
	it("resolves a writable destination before rendering and normalizes its extension", async () => {
		const dir = await makeTempDir();
		vi.mocked(dialog.showSaveDialog).mockResolvedValue({
			canceled: false,
			filePath: path.join(dir, "my-export.webm"),
		});
		registerExportHandlers();
		const registration = vi
			.mocked(ipcMain.handle)
			.mock.calls.find(([channel]) => channel === "select-export-destination");
		expect(registration).toBeDefined();
		const result = await registration![1]({ sender: {} } as never, {
			fileName: "video.mov",
			format: "mov",
			expectedBytes: 1024,
		});
		expect(result).toMatchObject({ success: true, path: path.join(dir, "my-export.mov") });
	});

	it("rejects a destination when the space estimate exceeds available bytes", async () => {
		const dir = await makeTempDir();
		vi.mocked(dialog.showSaveDialog).mockResolvedValue({
			canceled: false,
			filePath: path.join(dir, "video.mp4"),
		});
		registerExportHandlers();
		const registration = vi
			.mocked(ipcMain.handle)
			.mock.calls.find(([channel]) => channel === "select-export-destination");
		const result = await registration![1]({ sender: {} } as never, {
			fileName: "video.mp4",
			format: "mp4",
			expectedBytes: Number.MAX_SAFE_INTEGER,
		});
		expect(result).toMatchObject({
			success: false,
			error: "Not enough free space at the selected destination",
		});
	});

	it("does not overwrite an existing file after correcting the extension", async () => {
		const dir = await makeTempDir();
		const existingPath = path.join(dir, "my-export.mov");
		await fs.writeFile(existingPath, "existing result");
		vi.mocked(dialog.showSaveDialog).mockResolvedValue({
			canceled: false,
			filePath: path.join(dir, "my-export.webm"),
		});
		registerExportHandlers();
		const registration = vi
			.mocked(ipcMain.handle)
			.mock.calls.find(([channel]) => channel === "select-export-destination");
		const result = await registration![1]({ sender: {} } as never, {
			fileName: "video.mov",
			format: "mov",
			expectedBytes: 1024,
		});
		expect(result).toMatchObject({ success: false, code: "name-conflict" });
		await expect(fs.readFile(existingPath, "utf8")).resolves.toBe("existing result");
	});
});

describe("moveExportedTempFile", () => {
	it("moves an app-managed export temp file to the selected destination", async () => {
		const dir = await makeTempDir();
		const tempPath = path.join(dir, "export-temp.mp4");
		const destinationPath = path.join(dir, "export-final.mp4");
		await fs.writeFile(tempPath, "recordly-export");

		await moveExportedTempFile(tempPath, destinationPath);

		await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe("recordly-export");
		await expect(fs.access(tempPath)).rejects.toThrow();
	});

	it("falls back when Windows reports the destination already exists during initial rename", async () => {
		const dir = await makeTempDir();
		const tempPath = path.join(dir, "export-temp.mp4");
		const destinationPath = path.join(dir, "export-final.mp4");
		await fs.writeFile(tempPath, "new-export");
		await fs.writeFile(destinationPath, "previous-export");

		const originalRename = fs.rename.bind(fs);
		const renameSpy = vi.spyOn(fs, "rename");
		renameSpy.mockImplementation(async (from, to) => {
			if (from === tempPath && to === destinationPath) {
				const error = new Error("destination exists") as NodeJS.ErrnoException;
				error.code = "EEXIST";
				throw error;
			}

			return originalRename(from, to);
		});

		await moveExportedTempFile(tempPath, destinationPath);

		await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe("new-export");
		await expect(fs.access(tempPath)).rejects.toThrow();
	});
});

describe("ProRes alpha export helpers", () => {
	it("builds a WebM-to-ProRes command that preserves and labels alpha", () => {
		const args = buildWebmToProResArgs("/tmp/input.webm", "/tmp/output.mov");

		expect(args).toEqual(
			expect.arrayContaining([
				"-c:v",
				"libvpx-vp9",
				"-map",
				"0:v:0",
				"-map",
				"0:a?",
				"-c:v",
				"prores_ks",
				"-profile:v",
				"4",
				"-pix_fmt",
				"yuva444p10le",
				"-color_primaries",
				"bt709",
				"-color_trc",
				"-colorspace",
				"alpha_mode=1",
				"-alpha_bits",
				"16",
			]),
		);
		expect(args.at(-1)).toBe("/tmp/output.mov");
	});

	it("accepts ProRes 4444 streams with an alpha-capable pixel format", () => {
		expect(
			getProResAlphaValidationError({
				streams: [
					{
						codec_type: "video",
						codec_name: "prores",
						profile: "4444",
						codec_tag_string: "ap4h",
						pix_fmt: "yuva444p12le",
					},
				],
			}),
		).toBeNull();
	});

	it("rejects ProRes streams that lost their alpha pixel format", () => {
		expect(
			getProResAlphaValidationError({
				streams: [
					{
						codec_type: "video",
						codec_name: "prores",
						profile: "HQ",
						codec_tag_string: "apch",
						pix_fmt: "yuv422p10le",
					},
				],
			}),
		).toContain("Expected ProRes 4444");
	});

	it("parses decoded alpha plane signal stats", () => {
		const stats = parseAlphaSignalStats(`
frame:0
lavfi.signalstats.YMIN=256
lavfi.signalstats.YMAX=3763
lavfi.signalstats.YAVG=3125.45
frame:1
lavfi.signalstats.YMIN=300
lavfi.signalstats.YMAX=3700
lavfi.signalstats.YAVG=3100.55
`);

		expect(stats).toEqual({
			frameCount: 2,
			min: 256,
			max: 3763,
			avg: 3113,
		});
	});
});
