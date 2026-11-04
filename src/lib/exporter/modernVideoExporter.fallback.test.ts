import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const videoInfo = {
		width: 1920,
		height: 1080,
		duration: 1,
		streamDuration: 1,
		frameRate: 30,
		codec: "h264",
		hasAudio: false,
		audioCodec: null,
		audioSampleRate: null,
	};

	return {
		videoInfo,
		streamingDecoderDestroy: vi.fn(),
		streamingDecoderCancel: vi.fn(),
		streamingDecoderDecodeAll: vi.fn(async () => {}),
		streamingDecoderGetDemuxer: vi.fn(() => null),
		streamingDecoderGetEffectiveDuration: vi.fn(() => 0),
		streamingDecoderLoadMetadata: vi.fn(async () => videoInfo),
		frameRendererDestroy: vi.fn(),
		frameRendererGetBackend: vi.fn(() => "webgl"),
		frameRendererInitialize: vi.fn(async () => {}),
		muxerDestroy: vi.fn(),
		muxerFinalize: vi.fn(async () => ({
			mode: "buffer" as const,
			blob: new Blob([], { type: "video/mp4" }),
		})),
		muxerInitialize: vi.fn(async () => {}),
	};
});

vi.mock("./streamingDecoder", () => ({
	StreamingVideoDecoder: vi.fn().mockImplementation(function () {
		return {
			cancel: mocks.streamingDecoderCancel,
			decodeAll: mocks.streamingDecoderDecodeAll,
			destroy: mocks.streamingDecoderDestroy,
			getDemuxer: mocks.streamingDecoderGetDemuxer,
			getEffectiveDuration: mocks.streamingDecoderGetEffectiveDuration,
			loadMetadata: mocks.streamingDecoderLoadMetadata,
		};
	}),
}));

vi.mock("./modernFrameRenderer", () => ({
	FrameRenderer: vi.fn().mockImplementation(function () {
		return {
			destroy: mocks.frameRendererDestroy,
			getRendererBackend: mocks.frameRendererGetBackend,
			initialize: mocks.frameRendererInitialize,
		};
	}),
}));

vi.mock("./muxer", () => ({
	VideoMuxer: vi.fn().mockImplementation(function () {
		return {
			destroy: mocks.muxerDestroy,
			finalize: mocks.muxerFinalize,
			initialize: mocks.muxerInitialize,
		};
	}),
}));

describe("ModernVideoExporter native fallback routing", () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	it("falls back to WebCodecs instead of surfacing a native error when Breeze is unavailable", async () => {
		const { ModernVideoExporter } = await import("./modernVideoExporter");
		const exporter = new ModernVideoExporter({
			videoUrl: "file:///recording.mp4",
			width: 1920,
			height: 1080,
			frameRate: 30,
			bitrate: 8_000_000,
			wallpaper: "#101010",
			padding: 0,
			borderRadius: 0,
			backgroundBlur: 0,
			shadowIntensity: 0,
			showShadow: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			experimentalNativeExport: true,
			backendPreference: "breeze",
		} as never) as unknown as {
			export: () => Promise<{ success: boolean; blob?: Blob; error?: string }>;
			initializeEncoder: () => Promise<unknown>;
			loadNativeStaticLayoutVideoInfo: () => Promise<unknown>;
			tryExportNativeStaticLayout: () => Promise<unknown>;
			tryStartNativeVideoExport: () => Promise<boolean>;
			lastNativeExportError: string | null;
		};

		vi.spyOn(exporter, "loadNativeStaticLayoutVideoInfo").mockResolvedValue(mocks.videoInfo);
		vi.spyOn(exporter, "tryExportNativeStaticLayout").mockResolvedValue(null);
		vi.spyOn(exporter, "tryStartNativeVideoExport").mockImplementation(async () => {
			exporter.lastNativeExportError = "Breeze native encoder unavailable";
			return false;
		});
		const initializeEncoder = vi.spyOn(exporter, "initializeEncoder").mockResolvedValue({
			codec: "avc1.640034",
			hardwareAcceleration: "prefer-hardware",
		});

		const result = await exporter.export();

		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.blob).toBeInstanceOf(Blob);
		expect(initializeEncoder).toHaveBeenCalledTimes(1);
		expect(mocks.muxerFinalize).toHaveBeenCalledTimes(1);
	}, 15_000);

	it("retries the main decode path once with a readable file-backed source", async () => {
		const { ModernVideoExporter } = await import("./modernVideoExporter");
		mocks.streamingDecoderGetEffectiveDuration.mockReturnValue(1);
		mocks.streamingDecoderDecodeAll
			.mockRejectedValueOnce(
				new Error("readAVPacket pipeline failed: Failed after 3 attempts"),
			)
			.mockResolvedValueOnce(undefined);

		const exporter = new ModernVideoExporter({
			videoUrl: "file:///recording.mp4",
			width: 1920,
			height: 1080,
			frameRate: 30,
			bitrate: 8_000_000,
			wallpaper: "#101010",
			padding: 0,
			borderRadius: 0,
			backgroundBlur: 0,
			shadowIntensity: 0,
			showShadow: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			backendPreference: "webcodecs",
		} as never) as unknown as {
			export: () => Promise<{ success: boolean; blob?: Blob; error?: string }>;
			initializeEncoder: () => Promise<unknown>;
		};

		vi.spyOn(exporter, "initializeEncoder").mockResolvedValue({
			codec: "avc1.640034",
			hardwareAcceleration: "prefer-hardware",
		});

		const result = await exporter.export();

		expect(result.success).toBe(true);
		expect(mocks.streamingDecoderLoadMetadata).toHaveBeenCalledTimes(2);
		expect(mocks.streamingDecoderLoadMetadata.mock.calls[0]).toEqual([
			"file:///recording.mp4",
			{
				forceReadableFileSource: false,
			},
		]);
		expect(mocks.streamingDecoderLoadMetadata.mock.calls[1]).toEqual([
			"file:///recording.mp4",
			{
				forceReadableFileSource: true,
			},
		]);
		expect(mocks.streamingDecoderDecodeAll).toHaveBeenCalledTimes(2);
		expect(mocks.muxerFinalize).toHaveBeenCalledTimes(1);
	});
});

describe("ModernVideoExporter cancellation", () => {
	it("releases frame loops waiting for encoder capacity when cancelled", async () => {
		const { ModernVideoExporter } = await import("./modernVideoExporter");
		const exporter = new ModernVideoExporter({
			videoUrl: "file:///recording.mp4",
			width: 1920,
			height: 1080,
			frameRate: 30,
			bitrate: 8_000_000,
		} as never) as unknown as {
			cancel: () => Promise<void>;
			waitForEncodeCapacity: () => Promise<void>;
		};

		// A closed encoder never reports capacity again; cancel must wake the waiter.
		let released = false;
		const waiting = exporter.waitForEncodeCapacity().then(() => {
			released = true;
		});
		await Promise.resolve();
		expect(released).toBe(false);

		await exporter.cancel();
		await waiting;
		expect(released).toBe(true);
		await expect(exporter.waitForEncodeCapacity()).resolves.toBeUndefined();
	});
});
