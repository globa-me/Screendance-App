import { describe, expect, it } from "vitest";

import {
	canShowFloatingWebcamPreview,
	canToggleFloatingWebcamPreview,
	loadWebcamPreviewSize,
	nextWebcamPreviewSize,
	saveWebcamPreviewSize,
	WEBCAM_PREVIEW_SIZE_STORAGE_KEY,
} from "./floatingWebcamPreview";

describe("canShowFloatingWebcamPreview", () => {
	it("shows the floating preview only when it was requested and passthrough is supported", () => {
		expect(canShowFloatingWebcamPreview(true, true)).toBe(true);
		expect(canShowFloatingWebcamPreview(false, true)).toBe(false);
		expect(canShowFloatingWebcamPreview(true, false)).toBe(false);
		expect(canShowFloatingWebcamPreview(true, null)).toBe(false);
	});
});

describe("canToggleFloatingWebcamPreview", () => {
	it("keeps the toggle visible while support is unknown or available", () => {
		expect(canToggleFloatingWebcamPreview(null)).toBe(true);
		expect(canToggleFloatingWebcamPreview(true)).toBe(true);
	});

	it("hides the toggle when the platform cannot support the floating preview", () => {
		expect(canToggleFloatingWebcamPreview(false)).toBe(false);
	});
});

describe("webcam preview size preference", () => {
	it("cycles small → medium → large → small", () => {
		expect(nextWebcamPreviewSize("small")).toBe("medium");
		expect(nextWebcamPreviewSize("medium")).toBe("large");
		expect(nextWebcamPreviewSize("large")).toBe("small");
	});

	it("round-trips through storage and falls back to medium", () => {
		const data = new Map<string, string>();
		const storage = {
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => void data.set(key, value),
		};
		expect(loadWebcamPreviewSize(storage)).toBe("medium");
		saveWebcamPreviewSize("small", storage);
		expect(loadWebcamPreviewSize(storage)).toBe("small");
		data.set(WEBCAM_PREVIEW_SIZE_STORAGE_KEY, "huge");
		expect(loadWebcamPreviewSize(storage)).toBe("medium");
	});
});
