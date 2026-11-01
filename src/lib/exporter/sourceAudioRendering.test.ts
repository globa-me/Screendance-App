import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AudioRegion,
	ClipRegion,
	SourceAudioTrackSettings,
} from "@/components/video-editor/types";
import { AudioProcessor } from "./audioEncoder";
import { ModernVideoExporter } from "./modernVideoExporter";
import {
	buildSourceAudioGainRanges,
	type SourceAudioGainRange,
	type SourceAudioTimelineSlice,
} from "./sourceAudioEnvelope";
import type { DecodedVideoInfo } from "./streamingDecoder";
import { VideoExporter } from "./videoExporter";

type Scheduler = {
	scheduleBufferThroughTimeline(
		ctx: OfflineAudioContext,
		buffer: AudioBuffer,
		slices: SourceAudioTimelineSlice[],
		delay: number,
		gain: number,
		chunkStart: number,
		chunkDuration: number,
		ranges?: SourceAudioGainRange[],
	): void;
	scheduleRegionForChunk(
		ctx: OfflineAudioContext,
		buffer: AudioBuffer,
		region: AudioRegion,
		slices: SourceAudioTimelineSlice[],
		chunkStart: number,
		chunkDuration: number,
	): void;
	stretchAudioBuffer(...args: unknown[]): AudioBuffer;
	renderAndMuxOfflineAudio(...args: unknown[]): Promise<void>;
};
function context() {
	const sources: Array<{
		start: ReturnType<typeof vi.fn>;
		buffer: AudioBuffer | null;
		playbackRate: { value: number };
		connect: ReturnType<typeof vi.fn>;
	}> = [];
	const gains: Array<{ gain: { value: number }; connect: ReturnType<typeof vi.fn> }> = [];
	const ctx = {
		destination: {},
		createBufferSource: () => {
			const node = {
				start: vi.fn(),
				buffer: null,
				playbackRate: { value: 1 },
				connect: vi.fn(),
			};
			sources.push(node);
			return node;
		},
		createGain: () => {
			const node = { gain: { value: 1 }, connect: vi.fn() };
			gains.push(node);
			return node;
		},
	} as unknown as OfflineAudioContext;
	return { ctx, sources, gains };
}
function scheduler() {
	const processor = new AudioProcessor();
	const api = processor as unknown as Scheduler;
	const stretch = vi
		.spyOn(api, "stretchAudioBuffer")
		.mockImplementation((...args) => args[0] as AudioBuffer);
	return { processor, api, stretch };
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("audio gain envelopes reach scheduled output", () => {
	it("schedules the correct gain and source offsets on both sides of a30s render chunk", () => {
		const { api, stretch } = scheduler(),
			{ ctx, sources, gains } = context();
		const buffer = { duration: 60 } as AudioBuffer;
		api.scheduleBufferThroughTimeline(
			ctx,
			buffer,
			[{ sourceStartMs: 0, sourceEndMs: 60000, speed: 1 }],
			0,
			1,
			30,
			2,
			[
				{ startSec: 0, endSec: 31, gain: 0.25 },
				{ startSec: 31, endSec: 60, gain: 0.8 },
			],
		);
		expect(gains.map((node) => node.gain.value)).toEqual([0.25, 0.8]);
		expect(sources.map((node) => node.start.mock.calls[0][0])).toEqual([0, 1]);
		expect(stretch.mock.calls.map((args) => [args[2], args[3], args[4]])).toEqual([
			[30, 1, 1],
			[31, 1, 1],
		]);
	});
	it("maps muted source clips after trims/speed while preserving delayed sidecar alignment", () => {
		const { api, stretch } = scheduler(),
			{ ctx, sources, gains } = context();
		const slices = [
			{ sourceStartMs: 2000, sourceEndMs: 4000, speed: 1 },
			{ sourceStartMs: 4000, sourceEndMs: 8000, speed: 2 },
		];
		const options = {
			clipRegions: [
				{ id: "mute", startMs: 2000, endMs: 4000, speed: 1, muted: true },
				{ id: "fast", startMs: 4000, endMs: 6000, speed: 2 },
			],
			sourceAudioTrackSettingsByClip: { fast: { mic: { volume: 0.4, normalize: false } } },
		};
		api.scheduleBufferThroughTimeline(
			ctx,
			{ duration: 6.5 } as AudioBuffer,
			slices,
			1.5,
			1,
			0,
			30,
			buildSourceAudioGainRanges(slices, "mic", options),
		);
		expect(gains.map((node) => node.gain.value)).toEqual([0.4]);
		expect(sources[0].start).toHaveBeenCalledExactlyOnceWith(2);
		expect(stretch.mock.calls[0].slice(1, 5)).toEqual([2, 2.5, 4, 2]);
	});
	it("does not mute separately authored audio overlays with the source clip", () => {
		const { api } = scheduler(),
			{ ctx, sources, gains } = context();
		const slices = [{ sourceStartMs: 2000, sourceEndMs: 4000, speed: 1 }];
		const buffer = { duration: 2 } as AudioBuffer;
		api.scheduleBufferThroughTimeline(ctx, buffer, slices, 0, 1, 0, 30, [
			{ startSec: 0, endSec: 2, gain: 0 },
		]);
		expect(sources).toHaveLength(0);
		api.scheduleRegionForChunk(
			ctx,
			buffer,
			{ id: "music", startMs: 2000, endMs: 4000, audioPath: "/tmp/music.wav", volume: 0.5 },
			slices,
			0,
			30,
		);
		expect(gains.map((node) => node.gain.value)).toEqual([0.5]);
		expect(sources[0].start).toHaveBeenCalledExactlyOnceWith(0, 0, 2);
	});
	it("forces offline PCM processing even when only an unselected clip has authored gain", async () => {
		const { processor, api } = scheduler();
		const render = vi.spyOn(api, "renderAndMuxOfflineAudio").mockResolvedValue();
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2000, speed: 1 },
		];
		const map: Record<string, SourceAudioTrackSettings> = {
			b: { mixed: { volume: 0.2, normalize: false } },
		};
		await processor.process(
			null,
			{} as never,
			"file:///tmp/video.mp4",
			[],
			[],
			undefined,
			[],
			[],
			undefined,
			{},
			clips,
			map,
			{},
		);
		expect(render).toHaveBeenCalledOnce();
		expect(render.mock.calls[0].slice(-2)).toEqual([map, {}]);
	});
});

const videoInfo: DecodedVideoInfo = {
	width: 1920,
	height: 1080,
	duration: 4,
	streamDuration: 4,
	frameRate: 30,
	codec: "h264",
	hasAudio: true,
	audioCodec: "aac",
	audioSampleRate: 48000,
};
describe.each([
	ModernVideoExporter,
	VideoExporter,
])("native audio routing with clip controls (%s)", (Exporter) => {
	it("does not passthrough or use a gain-blind filtergraph for clip-specific gain", () => {
		vi.stubGlobal("window", { electronAPI: {} });
		const exporter = new Exporter({
			videoUrl: "file:///tmp/recording.mp4",
			width: 1920,
			height: 1080,
			frameRate: 30,
			bitrate: 8000000,
			wallpaper: "#000",
			padding: 0,
			borderRadius: 0,
			clipRegions: [{ id: "a", startMs: 0, endMs: 4000, speed: 1 }],
			defaultSourceAudioTrackSettings: { mixed: { volume: 1, normalize: false } },
			sourceAudioTrackSettingsByClip: { a: { mixed: { volume: 0.2, normalize: false } } },
		} as never) as unknown as { buildNativeAudioPlan(info: DecodedVideoInfo): unknown };
		expect(exporter.buildNativeAudioPlan(videoInfo)).toMatchObject({
			audioMode: "edited-track",
			strategy: "offline-render-fallback",
		});
	});
});
