import { describe, expect, it } from "vitest";
import { normalizeProjectEditor } from "../projectPersistence";

describe("explicit persisted presentation settings", () => {
	it("preserves custom motion controls and caption fonts rather than silently choosing a preset", () => {
		const input = {
			cursorSize: 4.5,
			cursorSmoothing: 1.1,
			cursorSpringStiffnessMultiplier: 1.8,
			cursorSpringDampingMultiplier: 1.4,
			cursorSpringMassMultiplier: 0.8,
			cursorClickBounce: 1.7,
			cursorClickBounceDuration: 420,
			zoomInDurationMs: 777,
			zoomOutDurationMs: 999,
			cursorMotionBlur: 0.9,
			autoCaptionSettings: {
				...normalizeProjectEditor({}).autoCaptionSettings,
				fontFamily: "Georgia",
			},
		};
		const first = normalizeProjectEditor(input);
		const second = normalizeProjectEditor(JSON.parse(JSON.stringify(first)));
		for (const key of Object.keys(input) as Array<keyof typeof input>)
			expect(first[key]).toEqual(input[key]);
		expect(second).toEqual(first);
	});
	it("retains explicit automatic blur controls and stable normalized defaults", () => {
		const auto = normalizeProjectEditor({
			zoomMotionBlurSampleCount: null,
			zoomMotionBlurShutterFraction: null,
		});
		expect(auto.zoomMotionBlurSampleCount).toBeNull();
		expect(auto.zoomMotionBlurShutterFraction).toBeNull();
		const defaults = normalizeProjectEditor({});
		expect(normalizeProjectEditor(defaults)).toEqual(defaults);
	});
	it("retains legacy defaults and bounds malformed values", () => {
		const defaults = normalizeProjectEditor({});
		expect(defaults.cursorSize).toBe(2.5);
		expect(defaults.cursorClickBounceDuration).toBe(350);
		const invalid = normalizeProjectEditor({
			cursorSize: -4,
			cursorSpringMassMultiplier: 100,
			cursorClickBounceDuration: 99999,
		});
		expect(invalid.cursorSize).toBe(0.5);
		expect(invalid.cursorSpringMassMultiplier).toBe(3);
		expect(invalid.cursorClickBounceDuration).toBe(500);
	});
});
