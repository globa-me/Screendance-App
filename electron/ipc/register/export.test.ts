import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
