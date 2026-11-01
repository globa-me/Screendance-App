import { describe, expect, it, vi } from "vitest";
import type { AnnotationRegion } from "../types";
import { DEFAULT_ANNOTATION_STYLE } from "../types";
import {
	drawContentHighlights,
	getHighlightFadeAlpha,
	projectHighlightRect,
	unprojectHighlightRect,
} from "./contentHighlights";

function highlight(overrides: Partial<AnnotationRegion> = {}): AnnotationRegion {
	return {
		id: "h1",
		startMs: 1000,
		endMs: 3000,
		type: "highlight",
		content: "",
		position: { x: 25, y: 50 },
		size: { width: 10, height: 20 },
		style: { ...DEFAULT_ANNOTATION_STYLE },
		zIndex: 1,
		highlightData: { shape: "rectangle", color: "#FF453A", strokeWidth: 6, fillOpacity: 0 },
		...overrides,
	};
}

const mask = { x: 100, y: 50, width: 800, height: 450 };

describe("content highlight geometry", () => {
	it("maps source-frame percentages onto the visible video rect", () => {
		expect(projectHighlightRect(highlight(), mask)).toEqual({
			x: 300,
			y: 275,
			width: 80,
			height: 90,
		});
	});

	it("keeps the shape on the same source pixels when the crop changes", () => {
		const cropped = { ...mask, sourceCrop: { x: 0.2, y: 0.4, width: 0.5, height: 0.5 } };
		const rect = projectHighlightRect(highlight(), cropped);
		expect(rect).not.toBeNull();
		// Source x=0.25 is 0.05 into a 0.5-wide crop -> 10% of the mask width.
		expect(rect?.x).toBeCloseTo(180);
		expect(rect?.y).toBeCloseTo(50 + 0.2 * 450);
		expect(rect?.width).toBeCloseTo(160);
		expect(rect?.height).toBeCloseTo(180);
	});

	it("round-trips through unprojection", () => {
		const cropped = { ...mask, sourceCrop: { x: 0.1, y: 0.2, width: 0.6, height: 0.7 } };
		const rect = projectHighlightRect(highlight(), cropped);
		const restored = rect ? unprojectHighlightRect(rect, cropped) : null;
		expect(restored?.position.x).toBeCloseTo(25);
		expect(restored?.position.y).toBeCloseTo(50);
		expect(restored?.size.width).toBeCloseTo(10);
		expect(restored?.size.height).toBeCloseTo(20);
	});

	it("fades in and out at the region edges", () => {
		const region = highlight();
		expect(getHighlightFadeAlpha(region, 900)).toBe(0);
		expect(getHighlightFadeAlpha(region, 1000)).toBe(0);
		expect(getHighlightFadeAlpha(region, 1060)).toBeCloseTo(0.5);
		expect(getHighlightFadeAlpha(region, 2000)).toBe(1);
		expect(getHighlightFadeAlpha(region, 3001)).toBe(0);
	});
});

describe("drawContentHighlights", () => {
	function mockGraphics() {
		const calls: string[] = [];
		const graphics = {
			clear: vi.fn(() => calls.push("clear")),
			roundRect: vi.fn(() => {
				calls.push("roundRect");
				return graphics;
			}),
			ellipse: vi.fn(() => {
				calls.push("ellipse");
				return graphics;
			}),
			fill: vi.fn(() => {
				calls.push("fill");
				return graphics;
			}),
			stroke: vi.fn(() => {
				calls.push("stroke");
				return graphics;
			}),
		};
		return { graphics, calls };
	}

	it("draws only active highlights and skips other annotation types", () => {
		const { graphics, calls } = mockGraphics();
		drawContentHighlights(
			graphics as never,
			[
				highlight({
					highlightData: {
						shape: "ellipse",
						color: "#00ff00",
						strokeWidth: 4,
						fillOpacity: 0.2,
					},
				}),
				highlight({ id: "later", startMs: 5000, endMs: 6000 }),
				{ ...highlight({ id: "text" }), type: "text" },
			],
			2000,
			mask,
			1920,
		);
		expect(calls).toEqual(["clear", "ellipse", "fill", "stroke"]);
		expect(graphics.stroke).toHaveBeenCalledWith(
			expect.objectContaining({ width: 4, color: 0x00ff00, alpha: 1 }),
		);
	});

	it("draws markers as fill-only and scales stroke by stage width", () => {
		const { graphics, calls } = mockGraphics();
		drawContentHighlights(
			graphics as never,
			[
				highlight({
					highlightData: {
						shape: "marker",
						color: "#FFD60A",
						strokeWidth: 6,
						fillOpacity: 0.4,
					},
				}),
			],
			2000,
			mask,
			960,
		);
		expect(calls).toEqual(["clear", "roundRect", "fill"]);
		expect(graphics.fill).toHaveBeenCalledWith({ color: 0xffd60a, alpha: 0.4 });
	});
});

describe("drawContentHighlights editing", () => {
	it("keeps the highlight being edited visible outside its fade", () => {
		const stroke = vi.fn();
		const graphics = {
			clear: vi.fn(),
			roundRect: vi.fn(() => graphics),
			ellipse: vi.fn(() => graphics),
			fill: vi.fn(() => graphics),
			stroke: vi.fn((...args: unknown[]) => {
				stroke(...args);
				return graphics;
			}),
		};
		const region = highlight();
		drawContentHighlights(graphics as never, [region], region.startMs, mask, 1920);
		expect(stroke).not.toHaveBeenCalled();
		drawContentHighlights(graphics as never, [region], region.startMs, mask, 1920, region.id);
		expect(stroke).toHaveBeenCalledWith(expect.objectContaining({ alpha: 1 }));
	});
});
