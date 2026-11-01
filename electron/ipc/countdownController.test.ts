import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountdownController, type CountdownState } from "./countdownController";

class MockContents extends EventEmitter {
	destroyed = false;
	loading = true;
	isDestroyed() {
		return this.destroyed;
	}
	isLoadingMainFrame() {
		return this.loading;
	}
	send = vi.fn((_channel: string, _remaining: number) => {
		if (this.destroyed) throw new Error("Object has been destroyed");
	});
	loaded() {
		this.loading = false;
		this.emit("did-finish-load");
	}
}
class MockWindow extends EventEmitter {
	destroyed = false;
	webContents = new MockContents();
	isDestroyed() {
		return this.destroyed;
	}
	close = vi.fn(() => {
		this.destroyed = true;
		this.webContents.destroyed = true;
		this.emit("closed");
	});
}
function setup(loading = true) {
	let state: CountdownState = {
		inProgress: false,
		remaining: null,
		timer: null,
		cancelled: false,
	};
	const windows: MockWindow[] = [];
	const ticks: Array<() => void> = [];
	const createWindow = vi.fn(() => {
		const window = new MockWindow();
		window.webContents.loading = loading;
		windows.push(window);
		return window;
	});
	const controller = new CountdownController({
		createWindow,
		onState: (next) => {
			state = next;
		},
		setInterval: (callback, delay) => {
			ticks.push(callback);
			return setInterval(callback, delay);
		},
	});
	return { controller, windows, ticks, createWindow, state: () => state };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("countdown lifecycle", () => {
	it("settles cancellation before the window finishes loading and ignores its late load callback", async () => {
		const { controller, windows, state } = setup();
		const result = controller.start(3);
		const lateLoad = windows[0].webContents.listeners("did-finish-load")[0];
		expect(state().inProgress).toBe(true);
		expect(controller.cancel()).toEqual({ success: true });
		await expect(result).resolves.toEqual({ success: false, cancelled: true });
		lateLoad();
		windows[0].webContents.loaded();
		expect(windows[0].webContents.send).not.toHaveBeenCalled();
		expect(state()).toEqual({
			inProgress: false,
			cancelled: true,
			remaining: null,
			timer: null,
		});
		expect(vi.getTimerCount()).toBe(0);
		expect(windows[0].webContents.listenerCount("did-finish-load")).toBe(0);
	});

	it("eagerly settles cancellation during the interval instead of waiting on a cleared callback", async () => {
		const { controller, windows, state } = setup(false);
		const result = controller.start(3);
		await vi.advanceTimersByTimeAsync(1000);
		expect(state().remaining).toBe(2);
		controller.cancel();
		await expect(result).resolves.toEqual({ success: false, cancelled: true });
		await vi.advanceTimersByTimeAsync(10000);
		expect(windows[0].webContents.send).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not let old load/timer/closed callbacks clear a restarted countdown", async () => {
		const { controller, windows, ticks, state } = setup(false);
		const oldResult = controller.start(5);
		const oldTick = ticks[0];
		const oldClosed = windows[0].listeners("closed")[0];
		controller.cancel();
		await oldResult;
		const restarted = controller.start(2);
		const newTimer = state().timer;
		oldTick();
		oldClosed();
		expect(state().timer).toBe(newTimer);
		expect(state().remaining).toBe(2);
		expect(windows[1].close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2000);
		await expect(restarted).resolves.toEqual({ success: true });
		expect(windows[0].close).toHaveBeenCalledTimes(1);
		expect(windows[1].close).toHaveBeenCalledTimes(1);
	});

	it.each([true, false])("settles a manually closed window while loading=%s", async (loading) => {
		const { controller, windows, state } = setup(loading);
		const result = controller.start(3);
		windows[0].close();
		await expect(result).resolves.toEqual({ success: false, cancelled: true });
		expect(state().inProgress).toBe(false);
		expect(state().timer).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("completes normally with one initial tick and one tick per remaining second", async () => {
		const { controller, windows, state } = setup();
		const result = controller.start(3);
		windows[0].webContents.loaded();
		expect(windows[0].webContents.send).toHaveBeenLastCalledWith("countdown-tick", 3);
		await vi.advanceTimersByTimeAsync(3000);
		await expect(result).resolves.toEqual({ success: true });
		expect(windows[0].webContents.send.mock.calls.map((call) => call[1])).toEqual([3, 2, 1]);
		expect(state()).toEqual({
			inProgress: false,
			cancelled: false,
			remaining: null,
			timer: null,
		});
		expect(windows[0].close).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects overlapping countdowns without stealing the existing owner", async () => {
		const { controller, createWindow, state } = setup(false);
		const first = controller.start(3);
		await expect(controller.start(7)).resolves.toMatchObject({ success: false });
		expect(createWindow).toHaveBeenCalledTimes(1);
		expect(state().remaining).toBe(3);
		controller.cancel();
		await first;
	});

	it("settles load failure and can immediately start a new countdown", async () => {
		const { controller, windows, state } = setup();
		const first = controller.start(3);
		windows[0].webContents.emit("did-fail-load");
		await expect(first).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining("failed to load"),
		});
		expect(state().inProgress).toBe(false);
		const second = controller.start(1);
		windows[1].webContents.loaded();
		await vi.advanceTimersByTimeAsync(1000);
		await expect(second).resolves.toEqual({ success: true });
	});
});
