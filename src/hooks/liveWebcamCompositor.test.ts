import { describe, expect, it } from "vitest";
import { HiddenRangeTracker } from "./liveWebcamCompositor";

describe("HiddenRangeTracker", () => {
	it("records off spans and closes an open span at the end", () => {
		const tracker = new HiddenRangeTracker();
		tracker.hide(1000);
		tracker.show(2500);
		tracker.hide(4000);
		expect(tracker.isHidden).toBe(true);
		expect(tracker.finish(6000)).toEqual([
			{ startMs: 1000, endMs: 2500 },
			{ startMs: 4000, endMs: 6000 },
		]);
	});

	it("ignores repeated hide/show calls and empty spans", () => {
		const tracker = new HiddenRangeTracker();
		tracker.show(100);
		tracker.hide(500);
		tracker.hide(900);
		tracker.show(500);
		expect(tracker.finish(1000)).toEqual([]);
	});

	it("merges a span that starts where the previous one ended", () => {
		const tracker = new HiddenRangeTracker();
		tracker.hide(0);
		tracker.show(1000);
		tracker.hide(1000);
		tracker.show(1500);
		expect(tracker.finish(2000)).toEqual([{ startMs: 0, endMs: 1500 }]);
	});
});
