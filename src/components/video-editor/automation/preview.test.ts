import { afterEach, describe, expect, it, vi } from "vitest";
import { getAutomationPreviewDimensions, seekAutomationVideo } from "./preview";
import { waitForAutomationMedia } from "./useEditorAutomation";

function fakeVideo({ currentTime = 0, duration = 10, paused = true } = {}) {
	const target = new EventTarget();
	let time = currentTime;
	return Object.assign(target, {
		duration,
		paused,
		seeking: false,
		getTime: () => time,
		setTime: (next: number) => {
			time = next;
		},
	}) as EventTarget & {
		duration: number;
		paused: boolean;
		seeking: boolean;
		getTime: () => number;
		setTime: (value: number) => void;
	};
}
function videoElement(options?: Parameters<typeof fakeVideo>[0]): HTMLVideoElement {
	const fake = fakeVideo(options);
	Object.defineProperty(fake, "currentTime", { get: fake.getTime, set: fake.setTime });
	return fake as unknown as HTMLVideoElement;
}

afterEach(() => vi.useRealTimers());

describe("automation preview", () => {
	it("preserves landscape, portrait and square project ratios within 1280px", () => {
		expect(getAutomationPreviewDimensions(16 / 9)).toEqual({ width: 1280, height: 720 });
		expect(getAutomationPreviewDimensions(9 / 16)).toEqual({ width: 720, height: 1280 });
		expect(getAutomationPreviewDimensions(1)).toEqual({ width: 1280, height: 1280 });
		expect(() => getAutomationPreviewDimensions(0)).toThrow();
	});

	it("rejects playback and source times outside the video without seeking", async () => {
		const video = videoElement();
		await expect(seekAutomationVideo(video, 10001)).rejects.toMatchObject({
			code: "INVALID_PARAMS",
		});
		await expect(seekAutomationVideo(video, Number.NaN)).rejects.toMatchObject({
			code: "INVALID_PARAMS",
		});
		Object.defineProperty(video, "paused", { value: false });
		await expect(seekAutomationVideo(video, 5000)).rejects.toMatchObject({ code: "BUSY" });
		expect(video.currentTime).toBe(0);
	});

	it("waits for seek completion and reports actual source time", async () => {
		const video = videoElement();
		const result = seekAutomationVideo(video, 5000);
		expect(video.currentTime).toBe(5);
		video.dispatchEvent(new Event("seeked"));
		await expect(result).resolves.toBe(5000);
	});

	it("times out failed seeks and removes listeners", async () => {
		vi.useFakeTimers();
		const video = videoElement();
		const remove = vi.spyOn(video, "removeEventListener");
		const result = expect(seekAutomationVideo(video, 5000)).rejects.toMatchObject({
			code: "MEDIA_NOT_READY",
		});
		await vi.advanceTimersByTimeAsync(10000);
		await result;
		expect(remove).toHaveBeenCalledTimes(2);
	});

	it("readiness uses the latest state and surfaces load failures", async () => {
		vi.useFakeTimers();
		let ready = false;
		const result = waitForAutomationMedia(() => ({ ready, error: null }), 500);
		ready = true;
		await vi.advanceTimersByTimeAsync(50);
		await expect(result).resolves.toBeUndefined();
		await expect(
			waitForAutomationMedia(() => ({ ready: true, error: "Decode failed" })),
		).rejects.toMatchObject({ code: "MEDIA_LOAD_FAILED" });
	});
});
