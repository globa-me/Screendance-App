import { describe, expect, it } from "vitest";

import { toNativeThumbnailId } from "./sourceThumbnails";

describe("toNativeThumbnailId", () => {
	it("keeps the CoreGraphics window id for window sources", () => {
		expect(toNativeThumbnailId({ id: "window:4512:0", sourceType: "window" })).toBe(
			"window:4512:0",
		);
		expect(toNativeThumbnailId({ id: "window:77:3" })).toBe("window:77:0");
	});

	it("maps screens to their display id, including fallback screen ids", () => {
		expect(
			toNativeThumbnailId({ id: "screen:fallback:1", display_id: "1", sourceType: "screen" }),
		).toBe("display:1");
		expect(toNativeThumbnailId({ id: "screen:0:0", display_id: "69733382" })).toBe(
			"display:69733382",
		);
	});

	it("skips sources without a usable native id", () => {
		expect(toNativeThumbnailId({ id: "window:abc", sourceType: "window" })).toBeNull();
		expect(toNativeThumbnailId({ id: "screen:0:0", display_id: "" })).toBeNull();
	});
});
