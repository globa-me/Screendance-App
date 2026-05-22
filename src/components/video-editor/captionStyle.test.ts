import { describe, expect, it } from "vitest";
import { getCaptionScaledFontSize } from "./captionStyle";

describe("caption style scaling", () => {
	it("keeps the default caption size at 1920px landscape output", () => {
		expect(getCaptionScaledFontSize(30, 1920, 62, 1080)).toBe(30);
	});

	it("uses the long side for portrait exports so captions do not shrink", () => {
		expect(getCaptionScaledFontSize(30, 1080, 62, 1920)).toBe(30);
	});

	it("scales captions down with reduced portrait export quality", () => {
		expect(getCaptionScaledFontSize(30, 972, 62, 1728)).toBeCloseTo(27);
	});
});
