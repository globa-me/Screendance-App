import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobObject } from "../../shared/jobAutomation";
import type { AutomationJobContext } from "./jobs";

const mocks = vi.hoisted(() => ({
	directory: "",
	runtime: "",
	ffmpeg: "",
	candidates: [] as { path: string; label: string }[],
}));
vi.mock("electron", () => ({ app: { getPath: () => mocks.directory } }));
vi.mock("../ipc/constants", () => ({
	get WHISPER_MODEL_DIR() {
		return path.join(mocks.directory, "models");
	},
	get WHISPER_SMALL_MODEL_PATH() {
		return path.join(mocks.directory, "models/small.bin");
	},
	WHISPER_MODEL_DOWNLOAD_URL: "https://example.invalid/small.bin",
}));
vi.mock("../ipc/captions/generate", () => ({
	ensureReadableFile: (file: string) => fs.access(file),
	resolveWhisperExecutablePath: async () => mocks.runtime,
	resolveCaptionAudioCandidates: async () => mocks.candidates,
}));
vi.mock("../ipc/captions/whisper", () => ({
	getWhisperSmallModelStatus: async () => {
		const modelPath = path.join(mocks.directory, "models/small.bin");
		try {
			await fs.access(modelPath);
			return { success: true, exists: true, path: modelPath };
		} catch {
			return { success: true, exists: false, path: null };
		}
	},
}));
vi.mock("../ipc/ffmpeg/binary", () => ({ getFfmpegBinaryPath: () => mocks.ffmpeg }));

import {
	captureAutomationCaptionAudio,
	deleteAutomationModel,
	downloadAutomationModel,
	downloadJobModel,
	generateAutomationCaptions,
	listAutomationModels,
	runJobProcess,
} from "./jobMedia";

const context = (signal = new AbortController().signal): AutomationJobContext => ({
	jobId: "11111111-1111-1111-1111-111111111111",
	kind: "captions.generate",
	input: {},
	snapshot: {
		videoPath: path.join(mocks.directory, "video.mp4"),
		whisperModelPath: path.join(mocks.directory, "model.bin"),
		language: "en",
	},
	signal,
	progress: vi.fn(),
	checkpoint: vi.fn(async () => {}),
	beginCommit: vi.fn(),
});
beforeEach(async () => {
	mocks.directory = await fs.mkdtemp(path.join(os.tmpdir(), "sd-job-media-"));
	mocks.runtime = path.join(mocks.directory, "whisper.cjs");
	mocks.ffmpeg = path.join(mocks.directory, "ffmpeg.cjs");
	await fs.writeFile(path.join(mocks.directory, "video.mp4"), "video");
	await fs.writeFile(path.join(mocks.directory, "model.bin"), "model");
	await fs.writeFile(
		mocks.ffmpeg,
		'#!/usr/bin/env node\nconst fs=require("node:fs");fs.writeFileSync(process.argv.at(-1),"wav");',
		{ mode: 0o700 },
	);
	await fs.writeFile(
		mocks.runtime,
		'#!/usr/bin/env node\nconst fs=require("node:fs");const args=process.argv.slice(2);const out=args[args.indexOf("-of")+1];fs.writeFileSync(out+".json",JSON.stringify({transcription:[{offsets:{from:0,to:1000},text:"Hello world"}]}));fs.writeFileSync(out+".srt","1\\n00:00:00,000 --> 00:00:01,000\\nHello world\\n");',
		{ mode: 0o700 },
	);
	mocks.candidates = [{ path: path.join(mocks.directory, "video.mp4"), label: "recording" }];
});
afterEach(async () => {
	await fs.rm(mocks.directory, { recursive: true, force: true });
});

describe("job-owned Whisper/media processes", () => {
	it("freezes audio companions at enqueue and never discovers a later sidecar", async () => {
		const ctx = context();
		const missing = path.join(mocks.directory, "later-webcam.mp4");
		mocks.candidates.push({ path: missing, label: "late companion" });
		ctx.snapshot = await captureAutomationCaptionAudio(ctx.snapshot!);
		expect(ctx.snapshot).toMatchObject({
			_audioCandidates: [
				{ path: path.join(mocks.directory, "video.mp4"), label: "recording" },
			],
		});
		await fs.writeFile(missing, "new companion");
		mocks.candidates = [{ path: missing, label: "late companion" }];
		await expect(generateAutomationCaptions(ctx)).resolves.toMatchObject({
			audioSourceLabel: "recording",
		});
	});
	it("validates frozen paths and honors an empty frozen candidate list", async () => {
		const ctx = context();
		ctx.snapshot = {
			...(ctx.snapshot as JobObject),
			_audioCandidates: [{ path: "relative.mp4", label: "invalid" }],
		};
		await expect(generateAutomationCaptions(ctx)).rejects.toMatchObject({
			code: "INVALID_SNAPSHOT",
		});
		ctx.snapshot = { ...(ctx.snapshot as JobObject), _audioCandidates: [] };
		await expect(generateAutomationCaptions(ctx)).rejects.toMatchObject({ code: "NO_AUDIO" });
	});
	it("runs the existing extraction/runtime/parser contract and cleans temporary artifacts", async () => {
		const ctx = context();
		const result = await generateAutomationCaptions(ctx);
		expect(result).toMatchObject({
			cues: [{ id: "caption-1", startMs: 0, endMs: 1000, text: "Hello world" }],
			audioSourceLabel: "recording",
			language: "en",
		});
		expect(ctx.progress).toHaveBeenCalledWith({ phase: "transcribing", percentage: 0 });
		expect(
			(await fs.readdir(mocks.directory)).filter((file) =>
				file.startsWith("screendance-job-"),
			),
		).toEqual([]);
	});
	it("uses linked recording audio candidates without substituting another project", async () => {
		mocks.candidates = [
			{ path: path.join(mocks.directory, "missing.mp4"), label: "recording" },
			{ path: path.join(mocks.directory, "video.mp4"), label: "linked webcam recording" },
		];
		await expect(generateAutomationCaptions(context())).resolves.toMatchObject({
			audioSourceLabel: "linked webcam recording",
		});
	});
	it("reports missing audio and cleans extraction output", async () => {
		mocks.candidates = [];
		await expect(generateAutomationCaptions(context())).rejects.toMatchObject({
			code: "NO_AUDIO",
		});
		expect(
			(await fs.readdir(mocks.directory)).filter((file) =>
				file.startsWith("screendance-job-"),
			),
		).toEqual([]);
	});
	it("does not launch media work for an already cancelled job", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(generateAutomationCaptions(context(controller.signal))).rejects.toThrow(
			"cancelled",
		);
	});
	it("kills a real subprocess and resolves cancellation only after its exit", async () => {
		const controller = new AbortController();
		const result = runJobProcess(
			process.execPath,
			[
				"-e",
				'process.on("SIGTERM",()=>{});process.stderr.write("ready");setInterval(()=>{},1000);',
			],
			{ signal: controller.signal, onStderr: () => controller.abort() },
		);
		await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
	});
	it("enforces subprocess deadlines without waiting for the caller's connection", async () => {
		await expect(
			runJobProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
				signal: new AbortController().signal,
				timeoutMs: 25,
			}),
		).rejects.toMatchObject({ code: "TIMEOUT" });
	});
	it("retains subprocess diagnostics on normal failure", async () => {
		await expect(
			runJobProcess(
				process.execPath,
				["-e", 'process.stderr.write("unsupported model");process.exit(2)'],
				{ signal: new AbortController().signal },
			),
		).rejects.toThrow("unsupported model");
	});
});

describe("managed models", () => {
	it("lists the existing managed model and runtime without downloads", async () => {
		await fs.mkdir(path.join(mocks.directory, "models"));
		await fs.writeFile(path.join(mocks.directory, "models/small.bin"), "existing model");
		await expect(listAutomationModels()).resolves.toMatchObject({
			models: [{ modelId: "small", downloaded: true }],
			runtime: { available: true },
		});
		const ctx = context();
		ctx.kind = "models.download";
		await expect(downloadAutomationModel(ctx)).resolves.toMatchObject({ alreadyPresent: true });
		expect(ctx.beginCommit).not.toHaveBeenCalled();
	});
	it("deletes only the managed small model and never an arbitrary path", async () => {
		await fs.mkdir(path.join(mocks.directory, "models"));
		await fs.writeFile(path.join(mocks.directory, "models/small.bin"), "managed");
		await expect(deleteAutomationModel("../../model.bin")).rejects.toMatchObject({
			code: "INVALID_PARAMS",
		});
		await deleteAutomationModel();
		await expect(fs.access(path.join(mocks.directory, "models/small.bin"))).rejects.toThrow();
		await expect(fs.access(path.join(mocks.directory, "model.bin"))).resolves.toBeUndefined();
	});
	it("refuses insecure redirects and pre-cancelled downloads before network access", async () => {
		await expect(
			downloadJobModel(
				"http://example.invalid/model",
				path.join(mocks.directory, "part"),
				new AbortController().signal,
				() => {},
			),
		).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			downloadJobModel(
				"https://example.invalid/model",
				path.join(mocks.directory, "part"),
				controller.signal,
				() => {},
			),
		).rejects.toThrow("cancelled");
	});
});
