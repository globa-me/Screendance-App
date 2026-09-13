import { describe, expect, it } from "vitest";
import {
	getWebcamCropSourceRect,
	getWebcamOverlayPixelScale,
	getWebcamOverlayPosition,
	isWebcamCropRegionDefault,
	normalizeWebcamCropRegion,
} from "./webcamOverlay";

describe("normalizeWebcamCropRegion", () => {
	it("defaults to the full webcam frame", () => {
		expect(normalizeWebcamCropRegion()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		expect(isWebcamCropRegionDefault()).toBe(true);
	});

	it("clamps crop dimensions inside the source frame", () => {
		const crop = normalizeWebcamCropRegion({ x: 0.8, y: -1, width: 0.5, height: 2 });
		expect(crop.x).toBe(0.8);
		expect(crop.y).toBe(0);
		expect(crop.width).toBeCloseTo(0.2);
		expect(crop.height).toBe(1);
	});
});

describe("getWebcamCropSourceRect", () => {
	it("converts normalized crop settings to source pixels", () => {
		expect(
			getWebcamCropSourceRect({ x: 0.25, y: 0.1, width: 0.5, height: 0.75 }, 1920, 1080),
		).toEqual({
			sx: 480,
			sy: 108,
			sw: 960,
			sh: 810,
		});
	});
});

describe("getWebcamOverlayPixelScale", () => {
	it("scales export-only pixel values from preview pixels to export pixels", () => {
		const scale = getWebcamOverlayPixelScale({
			containerWidth: 1080,
			containerHeight: 1920,
			previewWidth: 360,
			previewHeight: 640,
		});

		expect(scale).toBe(3);
	});

	it("keeps top-center margin visually consistent between preview and export", () => {
		const preview = getWebcamOverlayPosition({
			containerWidth: 360,
			containerHeight: 640,
			size: 144,
			margin: 24,
			positionPreset: "top-center",
			positionX: 0.5,
			positionY: 0,
			legacyCorner: "bottom-right",
		});
		const scale = getWebcamOverlayPixelScale({
			containerWidth: 1080,
			containerHeight: 1920,
			previewWidth: 360,
			previewHeight: 640,
		});
		const exported = getWebcamOverlayPosition({
			containerWidth: 1080,
			containerHeight: 1920,
			size: 432,
			margin: 24 * scale,
			positionPreset: "top-center",
			positionX: 0.5,
			positionY: 0,
			legacyCorner: "bottom-right",
		});

		expect(exported.x / scale).toBeCloseTo(preview.x);
		expect(exported.y / scale).toBeCloseTo(preview.y);
	});
});
