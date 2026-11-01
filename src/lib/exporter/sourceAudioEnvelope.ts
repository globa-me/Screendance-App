import { SOURCE_AUDIO_NORMALIZE_GAIN } from "@/components/video-editor/audio/audioTypes";
import {
	type ClipRegion,
	getClipSourceEndMs,
	type SourceAudioTrackSettings,
} from "@/components/video-editor/types";

export interface SourceAudioEnvelopeOptions {
	/** Legacy global fallback; explicit document defaults take precedence. */
	sourceAudioTrackSettings?: SourceAudioTrackSettings;
	defaultSourceAudioTrackSettings?: SourceAudioTrackSettings;
	sourceAudioTrackSettingsByClip?: Record<string, SourceAudioTrackSettings>;
	clipRegions?: ClipRegion[];
}
export interface SourceAudioTimelineSlice {
	sourceStartMs: number;
	sourceEndMs: number;
	speed: number;
}
export interface SourceAudioGainRange {
	startSec: number;
	endSec: number;
	gain: number;
}
export type SourceAudioEnvelopeTrack = "mixed" | "system" | "mic" | "embedded";

export function sourceAudioDefaults(options: SourceAudioEnvelopeOptions): SourceAudioTrackSettings {
	return options.defaultSourceAudioTrackSettings ?? options.sourceAudioTrackSettings ?? {};
}
export function resolveSourceAudioGain(
	settings: SourceAudioTrackSettings,
	track: SourceAudioEnvelopeTrack,
): number {
	const setting = track === "embedded" ? (settings.mixed ?? settings.system) : settings[track];
	if (!setting) return 1;
	const gain = setting.volume * (setting.normalize ? SOURCE_AUDIO_NORMALIZE_GAIN : 1);
	return Number.isFinite(gain) ? Math.max(0, Math.min(2, gain)) : 1;
}
export function hasSourceAudioEnvelopeEdits(options: SourceAudioEnvelopeOptions): boolean {
	const nonDefault = (settings: SourceAudioTrackSettings) =>
		Object.values(settings).some(
			(setting) =>
				Math.abs((setting?.volume ?? 1) - 1) > 0.0005 || Boolean(setting?.normalize),
		);
	return (
		nonDefault(sourceAudioDefaults(options)) ||
		(options.clipRegions ?? []).some(
			(clip) =>
				Boolean(clip.muted) ||
				nonDefault(options.sourceAudioTrackSettingsByClip?.[clip.id] ?? {}),
		)
	);
}

/** Map source-anchored clip controls through trims/speed into output coordinates once. */
export function buildSourceAudioGainRanges(
	slices: SourceAudioTimelineSlice[],
	track: SourceAudioEnvelopeTrack,
	options: SourceAudioEnvelopeOptions,
): SourceAudioGainRange[] {
	const clips = [...(options.clipRegions ?? [])].sort((a, b) => a.startMs - b.startMs);
	const defaults = sourceAudioDefaults(options);
	const result: SourceAudioGainRange[] = [];
	let outputMs = 0;
	for (const slice of slices) {
		const boundaries = new Set([slice.sourceStartMs, slice.sourceEndMs]);
		for (const clip of clips)
			for (const point of [clip.startMs, getClipSourceEndMs(clip)])
				if (point > slice.sourceStartMs && point < slice.sourceEndMs) boundaries.add(point);
		const sorted = [...boundaries].sort((a, b) => a - b);
		for (let index = 0; index < sorted.length - 1; index++) {
			const start = sorted[index],
				end = sorted[index + 1];
			const midpoint = (start + end) / 2;
			const clip = clips.find(
				(entry) => midpoint >= entry.startMs && midpoint < getClipSourceEndMs(entry),
			);
			const settings = clip
				? { ...defaults, ...(options.sourceAudioTrackSettingsByClip?.[clip.id] ?? {}) }
				: defaults;
			const gain = clip?.muted ? 0 : resolveSourceAudioGain(settings, track);
			const startSec = (outputMs + (start - slice.sourceStartMs) / slice.speed) / 1000;
			const endSec = (outputMs + (end - slice.sourceStartMs) / slice.speed) / 1000;
			const previous = result[result.length - 1];
			if (previous && previous.gain === gain && Math.abs(previous.endSec - startSec) < 1e-9)
				previous.endSec = endSec;
			else result.push({ startSec, endSec, gain });
		}
		outputMs += (slice.sourceEndMs - slice.sourceStartMs) / slice.speed;
	}
	return result;
}

/** Intersections keep source envelopes independent from audio overlays and chunk boundaries. */
export function intersectSourceAudioGainRanges(
	startSec: number,
	endSec: number,
	ranges: SourceAudioGainRange[] | undefined,
	fallbackGain = 1,
): SourceAudioGainRange[] {
	if (!ranges) return [{ startSec, endSec, gain: fallbackGain }];
	return ranges.flatMap((range) => {
		const start = Math.max(startSec, range.startSec),
			end = Math.min(endSec, range.endSec);
		return range.gain > 0 && end > start
			? [{ startSec: start, endSec: end, gain: range.gain }]
			: [];
	});
}
