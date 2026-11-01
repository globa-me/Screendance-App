import { describe, expect, it } from "vitest";
import { isTimeInRanges, normalizeTimeRanges } from "./timeRanges";

describe("normalizeTimeRanges", () => {
	it("drops invalid entries, sorts and merges overlaps", () => {
		expect(
			normalizeTimeRanges([
				{ startMs: 5000, endMs: 6000 },
				{ startMs: 0, endMs: 1000.4 },
				{ startMs: 900, endMs: 1500 },
				{ startMs: 3000, endMs: 3000 },
				{ startMs: "x", endMs: 4 },
				null,
			]),
		).toEqual([
			{ startMs: 0, endMs: 1500 },
			{ startMs: 5000, endMs: 6000 },
		]);
	});

	it("returns an empty list for non-arrays", () => {
		expect(normalizeTimeRanges(undefined)).toEqual([]);
		expect(normalizeTimeRanges({ startMs: 0, endMs: 1 })).toEqual([]);
	});
});

describe("isTimeInRanges", () => {
	const ranges = [
		{ startMs: 1000, endMs: 2000 },
		{ startMs: 4000, endMs: 5000 },
	];

	it("treats ranges as half-open", () => {
		expect(isTimeInRanges(999, ranges)).toBe(false);
		expect(isTimeInRanges(1000, ranges)).toBe(true);
		expect(isTimeInRanges(1999, ranges)).toBe(true);
		expect(isTimeInRanges(2000, ranges)).toBe(false);
		expect(isTimeInRanges(4500, ranges)).toBe(true);
		expect(isTimeInRanges(4500, [])).toBe(false);
	});
});
