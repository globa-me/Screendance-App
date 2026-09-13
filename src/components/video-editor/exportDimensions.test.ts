import { describe, expect, it } from "vitest";
import {
	calculateAlphaSafeCanvasDimensions,
	calculateMp4ExportDimensions,
	calculateMp4SourceDimensions,
	normalizeAlphaSafeCanvasScale,
} from "./exportDimensions";

describe("calculateMp4SourceDimensions", () => {
	it("keeps native exports at the source dimensions", () => {
		expect(calculateMp4SourceDimensions(1920, 1080, "native")).toEqual({
			width: 1920,
			height: 1080,
		});
	});

	it("uses the rotated source bounds for 9:16 original exports", () => {
		expect(calculateMp4SourceDimensions(1920, 1080, "9:16")).toEqual({
			width: 1080,
			height: 1920,
		});
	});

	it("uses the rotated source bounds for portrait social ratios", () => {
		expect(calculateMp4SourceDimensions(1920, 1080, "4:5")).toEqual({
			width: 1080,
			height: 1350,
		});
	});

	it("keeps landscape aspect-ratio exports inside the source bounds", () => {
		expect(calculateMp4SourceDimensions(1920, 1080, "4:3")).toEqual({
			width: 1440,
			height: 1080,
		});
	});
});

describe("calculateMp4ExportDimensions", () => {
	it("normalizes odd source dimensions to even export dimensions", () => {
		const sourceDimensions = calculateMp4SourceDimensions(1919, 1079, "native");

		expect(sourceDimensions).toEqual({
			width: 1918,
			height: 1078,
		});
		expect(
			calculateMp4ExportDimensions(sourceDimensions.width, sourceDimensions.height, "source"),
		).toEqual({
			width: 1918,
			height: 1078,
		});
		expect(
			calculateMp4ExportDimensions(sourceDimensions.width, sourceDimensions.height, "high"),
		).toEqual({
			width: 1726,
			height: 970,
		});
	});

	it("scales portrait output dimensions from the aspect target", () => {
		const sourceDimensions = calculateMp4SourceDimensions(1920, 1080, "9:16");

		expect(
			calculateMp4ExportDimensions(sourceDimensions.width, sourceDimensions.height, "source"),
		).toEqual({
			width: 1080,
			height: 1920,
		});
		expect(
			calculateMp4ExportDimensions(sourceDimensions.width, sourceDimensions.height, "high"),
		).toEqual({
			width: 972,
			height: 1728,
		});
	});
});

describe("calculateAlphaSafeCanvasDimensions", () => {
	it("adds an even transparent overscan canvas around the selected export frame", () => {
		expect(calculateAlphaSafeCanvasDimensions(1080, 1920)).toEqual({
			width: 1620,
			height: 2880,
		});
	});

	it("keeps odd scaled dimensions even for video encoders", () => {
		expect(calculateAlphaSafeCanvasDimensions(1918, 1078)).toEqual({
			width: 2878,
			height: 1618,
		});
	});

	it("uses the requested safe canvas scale", () => {
		expect(calculateAlphaSafeCanvasDimensions(1080, 1920, 1.75)).toEqual({
			width: 1890,
			height: 3360,
		});
	});

	it("clamps unsafe scale values", () => {
		expect(normalizeAlphaSafeCanvasScale(Number.NaN)).toBe(1.5);
		expect(normalizeAlphaSafeCanvasScale(1)).toBe(1.25);
		expect(normalizeAlphaSafeCanvasScale(3)).toBe(2.5);
	});
});
