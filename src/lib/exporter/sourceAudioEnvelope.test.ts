import { describe, expect, it } from "vitest";
import {
	buildSourceAudioGainRanges,
	hasSourceAudioEnvelopeEdits,
	intersectSourceAudioGainRanges,
	sourceAudioDefaults,
} from "./sourceAudioEnvelope";

describe("source clip audio envelopes", () => {
	it("keeps per-clip gains independent from selected/active legacy settings", () => {
		const ranges = buildSourceAudioGainRanges(
			[{ sourceStartMs: 0, sourceEndMs: 4000, speed: 1 }],
			"mixed",
			{
				sourceAudioTrackSettings: { mixed: { volume: 0, normalize: false } },
				defaultSourceAudioTrackSettings: { mixed: { volume: 1, normalize: false } },
				clipRegions: [
					{ id: "a", startMs: 0, endMs: 2000, speed: 1 },
					{ id: "b", startMs: 2000, endMs: 4000, speed: 1 },
				],
				sourceAudioTrackSettingsByClip: {
					a: { mixed: { volume: 0.2, normalize: false } },
					b: { mixed: { volume: 0.8, normalize: false } },
				},
			},
		);
		expect(ranges).toEqual([
			{ startSec: 0, endSec: 2, gain: 0.2 },
			{ startSec: 2, endSec: 4, gain: 0.8 },
		]);
	});
	it("maps mute/gain from source coordinates through a leading trim and accelerated clip", () => {
		const slices = [
			{ sourceStartMs: 2000, sourceEndMs: 4000, speed: 1 },
			{ sourceStartMs: 4000, sourceEndMs: 8000, speed: 2 },
		];
		expect(
			buildSourceAudioGainRanges(slices, "mixed", {
				clipRegions: [
					{ id: "mute", startMs: 2000, endMs: 4000, speed: 1, muted: true },
					{ id: "fast", startMs: 4000, endMs: 6000, speed: 2 },
				],
				sourceAudioTrackSettingsByClip: {
					fast: { mixed: { volume: 0.5, normalize: false } },
				},
			}),
		).toEqual([
			{ startSec: 0, endSec: 2, gain: 0 },
			{ startSec: 2, endSec: 4, gain: 0.5 },
		]);
	});
	it("splits one speed slice at source clip boundaries rather than display-span endpoints", () => {
		expect(
			buildSourceAudioGainRanges(
				[{ sourceStartMs: 0, sourceEndMs: 6000, speed: 2 }],
				"mixed",
				{
					clipRegions: [
						{ id: "a", startMs: 0, endMs: 2000, speed: 2 },
						{ id: "b", startMs: 4000, endMs: 6000, speed: 1, muted: true },
					],
				},
			),
		).toEqual([
			{ startSec: 0, endSec: 2, gain: 1 },
			{ startSec: 2, endSec: 3, gain: 0 },
		]);
	});
	it("retains mic/system defaults separately and applies normalization only to its clip track", () => {
		const options = {
			defaultSourceAudioTrackSettings: {
				mic: { volume: 0.4, normalize: false },
				system: { volume: 0.6, normalize: false },
			},
			clipRegions: [{ id: "a", startMs: 0, endMs: 2000, speed: 1 }],
			sourceAudioTrackSettingsByClip: { a: { mic: { volume: 0.5, normalize: true } } },
		};
		const slices = [{ sourceStartMs: 0, sourceEndMs: 2000, speed: 1 }];
		expect(buildSourceAudioGainRanges(slices, "mic", options)[0].gain).toBeCloseTo(0.675);
		expect(buildSourceAudioGainRanges(slices, "system", options)[0].gain).toBe(0.6);
		expect(buildSourceAudioGainRanges(slices, "embedded", options)[0].gain).toBe(0.6);
	});
	it("intersects globally mapped envelopes across the30s chunk boundary without shifting gain", () => {
		const ranges = [
			{ startSec: 0, endSec: 29, gain: 0 },
			{ startSec: 29, endSec: 31, gain: 0.25 },
			{ startSec: 31, endSec: 60, gain: 1 },
		];
		expect(intersectSourceAudioGainRanges(28, 30, ranges)).toEqual([
			{ startSec: 29, endSec: 30, gain: 0.25 },
		]);
		expect(intersectSourceAudioGainRanges(30, 32, ranges)).toEqual([
			{ startSec: 30, endSec: 31, gain: 0.25 },
			{ startSec: 31, endSec: 32, gain: 1 },
		]);
	});
	it("forces edited audio for authored clip settings and mute but ignores stale clip IDs", () => {
		const base = { clipRegions: [{ id: "a", startMs: 0, endMs: 2000, speed: 1 }] };
		expect(
			hasSourceAudioEnvelopeEdits({
				...base,
				sourceAudioTrackSettingsByClip: { a: { mic: { volume: 0.2, normalize: false } } },
			}),
		).toBe(true);
		expect(
			hasSourceAudioEnvelopeEdits({
				...base,
				sourceAudioTrackSettingsByClip: {
					deleted: { mic: { volume: 0.2, normalize: false } },
				},
			}),
		).toBe(false);
		expect(
			hasSourceAudioEnvelopeEdits({
				...base,
				clipRegions: [{ ...base.clipRegions[0], muted: true }],
			}),
		).toBe(true);
		expect(
			hasSourceAudioEnvelopeEdits({
				defaultSourceAudioTrackSettings: { mixed: { volume: 1, normalize: true } },
			}),
		).toBe(true);
	});
	it("preserves legacy global gain fallback when no document defaults were supplied", () => {
		const options = { sourceAudioTrackSettings: { mixed: { volume: 0.3, normalize: false } } };
		expect(sourceAudioDefaults(options)).toEqual(options.sourceAudioTrackSettings);
		expect(
			buildSourceAudioGainRanges(
				[{ sourceStartMs: 0, sourceEndMs: 2000, speed: 1 }],
				"mixed",
				options,
			),
		).toEqual([{ startSec: 0, endSec: 2, gain: 0.3 }]);
	});
});
