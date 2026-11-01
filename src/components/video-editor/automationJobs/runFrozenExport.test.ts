import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationError } from "../../../../shared/automation";
import type { JobJson, JobObject } from "../../../../shared/jobAutomation";
import type { RendererAutomationJobContext } from "./useAutomationJobs";

const mocks = vi.hoisted(() => ({
	configs: [] as { engine: string; config: Record<string, unknown> }[],
	export: vi.fn(),
	cancel: vi.fn(async () => {}),
	probe: vi.fn(async (input: { width: number; height: number }) => ({
		...input,
		capped: false,
		encoderPath: { codec: "avc1.640033", hardwareAcceleration: "prefer-hardware" },
	})),
	gifDimensions: vi.fn(() => ({ width: 640, height: 360 })),
	mediaUrl: vi.fn(
		async (source: string) => `http://fresh-process/video?path=${encodeURIComponent(source)}`,
	),
}));
vi.mock("../../../lib/exporter/modernVideoExporter", () => ({
	ModernVideoExporter: class {
		constructor(config: Record<string, unknown>) {
			mocks.configs.push({ engine: "modern", config });
		}
		export = mocks.export;
		cancel = mocks.cancel;
	},
}));
vi.mock("../../../lib/exporter/videoExporter", () => ({
	VideoExporter: class {
		constructor(config: Record<string, unknown>) {
			mocks.configs.push({ engine: "legacy", config });
		}
		export = mocks.export;
		cancel = mocks.cancel;
	},
}));
vi.mock("../../../lib/exporter/gifExporter", () => ({
	GifExporter: class {
		constructor(config: Record<string, unknown>) {
			mocks.configs.push({ engine: "gif", config });
		}
		export = mocks.export;
		cancel = mocks.cancel;
	},
	calculateOutputDimensions: mocks.gifDimensions,
}));
vi.mock("../../../lib/exporter/mp4Support", () => ({
	DEFAULT_MP4_CODEC: "avc1.640033",
	probeSupportedMp4Dimensions: mocks.probe,
}));
vi.mock("../projectPersistence", () => ({
	resolveVideoUrl: mocks.mediaUrl,
	fromFileUrl: (source: string) => source.replace("file://", ""),
	toFileUrl: (source: string) => `file://${source}`,
}));

import { runFrozenExport, streamFrozenExportBlob } from "./runFrozenExport";

let api: {
	openExportStream: ReturnType<typeof vi.fn>;
	writeExportStreamChunk: ReturnType<typeof vi.fn>;
	closeExportStream: ReturnType<typeof vi.fn>;
	discardExportedTemp: ReturnType<typeof vi.fn>;
};
const snapshot = (): JobJson => ({
	videoPath: "/source/clip.mp4",
	videoWidth: 1920,
	videoHeight: 1080,
	aspectRatio: "native",
	revision: 4,
	commonConfig: {
		wallpaper: "#000000",
		zoomRegions: [],
		trimRegions: [],
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		showShadow: true,
		shadowIntensity: 0.5,
		backgroundBlur: 0,
		padding: 40,
		autoCaptions: [{ id: "cue", startMs: 0, endMs: 1000, text: "Frozen caption" }],
		sourceAudioFallbackPaths: ["/source/mic.webm"],
		sourceAudioTrackSettings: { microphone: { volume: 0.6 } },
		webcam: { sourcePath: "/source/webcam.mp4", timeOffsetMs: 25 },
		webcamUrl: "http://old-process/video?path=%2Fsource%2Fwebcam.mp4",
	},
	defaults: {
		format: "mp4",
		quality: "source",
		encodingMode: "quality",
		mp4FrameRate: 60,
		backendPreference: "auto",
		pipelineModel: "modern",
	},
});
const ctx = (signal = new AbortController().signal): RendererAutomationJobContext => ({
	jobId: "job",
	signal,
	progress: vi.fn(),
	checkpoint: vi.fn(),
	beginCommit: vi.fn(),
});
beforeEach(() => {
	vi.clearAllMocks();
	mocks.configs.length = 0;
	mocks.export.mockResolvedValue({ success: true, tempFilePath: "/managed/output.mp4" });
	api = {
		openExportStream: vi.fn(async () => ({
			success: true,
			streamId: "stream",
			tempPath: "/managed/blob.gif",
		})),
		writeExportStreamChunk: vi.fn(async () => ({ success: true })),
		closeExportStream: vi.fn(async () => ({ success: true, tempPath: "/managed/blob.gif" })),
		discardExportedTemp: vi.fn(async () => ({ success: true })),
	};
	vi.stubGlobal("window", { electronAPI: api });
});

describe("frozen export job rendering", () => {
	it("uses frozen composition/audio/captions and refreshes media URLs without any save dialog", async () => {
		const document = snapshot();
		const context = ctx();
		const result = await runFrozenExport(document, { outputPath: "/output/film.mp4" }, context);
		expect(mocks.configs[0]).toMatchObject({
			engine: "modern",
			config: {
				frameRate: 60,
				encodingMode: "quality",
				width: 1920,
				height: 1080,
				padding: 40,
				autoCaptions: [{ text: "Frozen caption" }],
				sourceAudioFallbackPaths: ["/source/mic.webm"],
				webcam: { timeOffsetMs: 25 },
				videoUrl: expect.stringContaining("fresh-process"),
				webcamUrl: expect.stringContaining("fresh-process"),
			},
		});
		expect(mocks.mediaUrl).toHaveBeenCalledWith("/source/clip.mp4");
		expect(mocks.mediaUrl).toHaveBeenCalledWith("/source/webcam.mp4");
		expect(result).toMatchObject({
			tempFilePath: "/managed/output.mp4",
			fileName: "film.mp4",
			revision: 4,
			format: "mp4",
		});
		expect(context.checkpoint).toHaveBeenCalledWith({
			pendingOutputPath: "/managed/output.mp4",
			tempFilePath: "/managed/output.mp4",
			fileName: "film.mp4",
			format: "mp4",
		});
		expect(context.beginCommit).not.toHaveBeenCalled();
	});
	it("preserves the selected legacy and WebCodecs settings", async () => {
		await runFrozenExport(
			snapshot(),
			{
				outputPath: "/output/film.mp4",
				settings: {
					pipelineModel: "legacy",
					backendPreference: "breeze",
					quality: "medium",
					mp4FrameRate: 24,
				},
			},
			ctx(),
		);
		expect(mocks.configs[0]).toMatchObject({
			engine: "legacy",
			config: {
				width: 1152,
				height: 648,
				frameRate: 24,
				backendPreference: "webcodecs",
				experimentalNativeExport: false,
			},
		});
	});
	it("retains alpha MOV in the existing modern encoder and skips MP4 support probing", async () => {
		await runFrozenExport(
			snapshot(),
			{
				outputPath: "/output/film.mov",
				settings: {
					transparentBackground: true,
					alphaFormat: "mov",
					alphaSafeCanvas: true,
					alphaSafeCanvasScale: 1.5,
					pipelineModel: "legacy",
				},
			},
			ctx(),
		);
		expect(mocks.configs[0]).toMatchObject({
			engine: "modern",
			config: {
				transparentBackground: true,
				alphaFormat: "mov",
				width: 2880,
				height: 1620,
				layoutViewport: { x: 480, y: 270, width: 1920, height: 1080 },
				experimentalNativeExport: false,
			},
		});
		expect(mocks.probe).not.toHaveBeenCalled();
	});
	it("uses the original GIF exporter and streams its Blob to an owned temp file", async () => {
		mocks.export.mockResolvedValueOnce({ success: true, blob: new Blob(["GIF89a"]) });
		const result = await runFrozenExport(
			snapshot(),
			{
				outputPath: "/output/film.gif",
				settings: {
					format: "gif",
					gifConfig: {
						frameRate: 25,
						loop: false,
						sizePreset: "large",
						width: 960,
						height: 540,
					},
				},
			},
			ctx(),
		);
		expect(mocks.configs[0]).toMatchObject({
			engine: "gif",
			config: { frameRate: 25, loop: false, width: 960, height: 540 },
		});
		expect(api.writeExportStreamChunk).toHaveBeenCalledTimes(1);
		expect(result.tempFilePath).toBe("/managed/blob.gif");
	});
	it("waits for exporter cancellation and discards a late completed temp file", async () => {
		const controller = new AbortController();
		let finish!: (value: unknown) => void;
		mocks.export.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const exporting = runFrozenExport(
			snapshot(),
			{ outputPath: "/output/film.mp4" },
			ctx(controller.signal),
		);
		await vi.waitFor(() => expect(mocks.export).toHaveBeenCalled());
		const assertion = expect(exporting).rejects.toMatchObject({ code: "CANCELLED" });
		controller.abort(new AutomationError("CANCELLED", "User cancelled"));
		finish({ success: true, tempFilePath: "/managed/output.mp4" });
		await assertion;
		expect(mocks.cancel).toHaveBeenCalledTimes(1);
		expect(api.discardExportedTemp).toHaveBeenCalledWith("/managed/output.mp4");
	});
	it("reports real encoder failure instead of producing a successful job", async () => {
		mocks.export.mockResolvedValueOnce({ success: false, error: "Encoder unavailable" });
		await expect(
			runFrozenExport(snapshot(), { outputPath: "/output/film.mp4" }, ctx()),
		).rejects.toMatchObject({ code: "EXPORT_FAILED", message: "Encoder unavailable" });
	});
	it("rejects an extension/settings mismatch before starting an encoder", async () => {
		await expect(
			runFrozenExport(
				snapshot(),
				{
					outputPath: "/output/film.mp4",
					settings: { transparentBackground: true, alphaFormat: "mov" },
				},
				ctx(),
			),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		expect(mocks.export).not.toHaveBeenCalled();
	});
	it("does not mutate its persisted document or effective export preferences", async () => {
		const captured = snapshot();
		const before = JSON.stringify(captured);
		await runFrozenExport(
			captured,
			{ outputPath: "/output/film.mp4", settings: { quality: "medium" } },
			ctx(),
		);
		expect(JSON.stringify(captured)).toBe(before);
	});
});

describe("managed Blob streaming", () => {
	it("aborts a partial stream on failed writes", async () => {
		api.writeExportStreamChunk.mockResolvedValueOnce({ success: false, error: "Disk full" });
		await expect(
			streamFrozenExportBlob(new Blob(["test"]), "gif", new AbortController().signal),
		).rejects.toMatchObject({ code: "EXPORT_STREAM_FAILED" });
		expect(api.closeExportStream).toHaveBeenCalledWith("stream", { abort: true });
	});
	it("does not open a stream after cancellation", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			streamFrozenExportBlob(new Blob(["test"]), "gif", controller.signal),
		).rejects.toThrow("cancelled");
		expect(api.openExportStream).not.toHaveBeenCalled();
	});
});
