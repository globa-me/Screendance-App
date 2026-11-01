import { describe, expect, it, vi } from "vitest";
import { AutomationError } from "../../../../shared/automation";
import {
	assertRecorderTransition,
	claimRecorderMutation,
	commitRecorderControlState,
	deleteOwnedCancelledRecording,
	type RecorderControlState,
	type RecorderMutation,
	RecorderResourceLease,
	RecordingFinalizationLatch,
	RecordingStartCoordinator,
	releaseRecorderMutation,
} from "./recordingControl";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((success, failure) => {
		resolve = success;
		reject = failure;
	});
	return { promise, resolve, reject };
}
const idle: RecorderControlState = {
	recording: false,
	paused: false,
	starting: false,
	countdownActive: false,
	finalizing: false,
};

describe("recording automation transitions", () => {
	it("never maps a repeated start to stop or allows configuration during capture", () => {
		expect(() => assertRecorderTransition({ ...idle, recording: true }, "start")).toThrowError(
			expect.objectContaining({ code: "ALREADY_RECORDING" }),
		);
		expect(() => assertRecorderTransition({ ...idle, recording: true }, "configure")).toThrow();
		expect(() => assertRecorderTransition(idle, "stop")).toThrowError(
			expect.objectContaining({ code: "NOT_RECORDING" }),
		);
		expect(() => assertRecorderTransition({ ...idle, finalizing: true }, "start")).toThrowError(
			expect.objectContaining({ code: "BUSY" }),
		);
	});
	it("allows countdown cancellation while refusing pause and duplicate start", () => {
		const countdown = { ...idle, starting: true, countdownActive: true };
		expect(() => assertRecorderTransition(countdown, "cancel")).not.toThrow();
		expect(() => assertRecorderTransition(countdown, "stop")).not.toThrow();
		expect(() => assertRecorderTransition(countdown, "pause")).toThrow();
		expect(() => assertRecorderTransition(countdown, "start")).toThrow();
	});
	it("does not report completion before real start callback resolves", async () => {
		const coordinator = new RecordingStartCoordinator();
		const actual = deferred<string>();
		const start = vi.fn(() => actual.promise);
		const callbacks = { delaySeconds: 0, countdown: vi.fn(), onCountdown: vi.fn(), start };
		const result = coordinator.start(callbacks);
		expect(coordinator.starting).toBe(true);
		await expect(coordinator.start(callbacks)).rejects.toMatchObject({ code: "BUSY" });
		expect(start).toHaveBeenCalledTimes(1);
		actual.resolve("capturing");
		await expect(result).resolves.toBe("capturing");
		expect(coordinator.starting).toBe(false);
	});
	it("cancels countdown even if the countdown later reports success", async () => {
		const coordinator = new RecordingStartCoordinator();
		const countdown = deferred<{ success: boolean }>();
		const start = vi.fn();
		const result = expect(
			coordinator.start({
				delaySeconds: 3,
				countdown: () => countdown.promise,
				onCountdown: vi.fn(),
				start,
			}),
		).rejects.toMatchObject({ code: "CANCELLED" });
		await coordinator.cancelCountdown(async () => ({ success: true }));
		countdown.resolve({ success: true });
		await result;
		expect(start).not.toHaveBeenCalled();
		expect(coordinator.starting).toBe(false);
		expect(coordinator.countdownActive).toBe(false);
	});
	it("surfaces start errors and releases the gate for retry", async () => {
		const coordinator = new RecordingStartCoordinator();
		await expect(
			coordinator.start({
				delaySeconds: 0,
				countdown: vi.fn(),
				onCountdown: vi.fn(),
				start: async () => {
					throw new AutomationError("START_FAILED", "Microphone unavailable");
				},
			}),
		).rejects.toMatchObject({ code: "START_FAILED" });
		expect(coordinator.starting).toBe(false);
		await expect(
			coordinator.start({
				delaySeconds: 0,
				countdown: vi.fn(),
				onCountdown: vi.fn(),
				start: async () => "retry",
			}),
		).resolves.toBe("retry");
	});
});

describe("recording finalization completion", () => {
	it("keeps stop pending through companion assembly and session handoff", async () => {
		const latch = new RecordingFinalizationLatch();
		const microphone = deferred<void>();
		const webcam = deferred<void>();
		const handoff = vi.fn();
		let completed = false;
		const result = latch.wait().then(() => {
			completed = true;
		});
		const pipeline = (async () => {
			await microphone.promise;
			await webcam.promise;
			handoff();
			latch.complete();
		})();
		microphone.resolve();
		await Promise.resolve();
		expect(completed).toBe(false);
		expect(latch.pending).toBe(true);
		webcam.resolve();
		await pipeline;
		await result;
		expect(handoff).toHaveBeenCalledTimes(1);
		expect(latch.pending).toBe(false);
	});
	it("returns finalization failures and allows subsequent sessions", async () => {
		const latch = new RecordingFinalizationLatch();
		const first = expect(latch.wait()).rejects.toMatchObject({ code: "FINALIZATION_FAILED" });
		expect(() => latch.wait()).toThrow();
		latch.fail(new AutomationError("FINALIZATION_FAILED", "Webcam write failed"));
		await first;
		const second = latch.wait();
		latch.complete();
		await expect(second).resolves.toBeUndefined();
	});
});

describe("cancelled recording cleanup", () => {
	it("deletes only the exact path owned by the started native recording", async () => {
		const remove = vi.fn(async () => ({ success: true }));
		await expect(
			deleteOwnedCancelledRecording("/recording-a.mp4", "/recording-b.mp4", remove),
		).resolves.toEqual(["/recording-b.mp4"]);
		await expect(deleteOwnedCancelledRecording(null, "/previous.mp4", remove)).resolves.toEqual(
			["/previous.mp4"],
		);
		expect(remove).not.toHaveBeenCalled();
		await expect(
			deleteOwnedCancelledRecording("/recording-a.mp4", "/recording-a.mp4", remove),
		).resolves.toEqual([]);
		expect(remove).toHaveBeenCalledWith("/recording-a.mp4");
	});
	it("reports retained files when cleanup fails", async () => {
		await expect(
			deleteOwnedCancelledRecording("/mine.mp4", "/mine.mp4", async () => {
				throw new Error("busy");
			}),
		).resolves.toEqual(["/mine.mp4"]);
	});
});

describe("retained HUD resource lifecycle", () => {
	it("releases a microphone acquired after its recording was already stopped", async () => {
		const lease = new RecorderResourceLease();
		const acquired = deferred<{ stop: () => void }>();
		const resource = { stop: vi.fn() };
		const attach = vi.fn();
		const result = lease.acquire(
			() => acquired.promise,
			(value) => value.stop(),
			attach,
		);
		lease.invalidate();
		acquired.resolve(resource);
		await expect(result).resolves.toBe(false);
		expect(resource.stop).toHaveBeenCalledTimes(1);
		expect(attach).not.toHaveBeenCalled();
	});
	it("does not let an old microphone acquisition replace a new recording's monitor", async () => {
		const lease = new RecorderResourceLease();
		const old = deferred<string>();
		const release = vi.fn();
		const attach = vi.fn();
		const oldResult = lease.acquire(() => old.promise, release, attach);
		lease.invalidate();
		await expect(lease.acquire(async () => "new", release, attach)).resolves.toBe(true);
		old.resolve("old");
		await oldResult;
		expect(attach).toHaveBeenCalledExactlyOnceWith("new");
		expect(release).toHaveBeenCalledExactlyOnceWith("old");
	});
});

describe("shared UI, tray and MCP mutation guard", () => {
	it("blocks Stop during native Cancel before native stop returns, then releases on failure", async () => {
		const lock: { current: RecorderMutation | null } = { current: null };
		const nativeStop = deferred<void>();
		const cancel = (async () => {
			expect(claimRecorderMutation(lock, "cancelling")).toBe(true);
			try {
				await nativeStop.promise;
			} finally {
				releaseRecorderMutation(lock, "cancelling");
			}
		})();
		const result = expect(cancel).rejects.toThrow("Native stop failed");
		expect(claimRecorderMutation(lock, "stopping")).toBe(false);
		expect(claimRecorderMutation(lock, "pausing")).toBe(false);
		expect(claimRecorderMutation(lock, "cancelling")).toBe(false);
		nativeStop.reject(new Error("Native stop failed"));
		await result;
		expect(claimRecorderMutation(lock, "stopping")).toBe(true);
		releaseRecorderMutation(lock, "cancelling");
		expect(lock.current).toBe("stopping");
		releaseRecorderMutation(lock, "stopping");
		expect(lock.current).toBeNull();
	});
});

describe("synchronous recorder control state", () => {
	it("permits promised pause then immediate resume before React renders", async () => {
		const state = { current: { ...idle, recording: true } };
		const dispatch = vi.fn(); // React rendering deliberately never occurs in this scenario.
		const pause = async () => {
			assertRecorderTransition(state.current, "pause");
			await Promise.resolve();
			commitRecorderControlState(state, "paused", true, dispatch);
		};
		const resume = async () => {
			assertRecorderTransition(state.current, "resume");
			await Promise.resolve();
			commitRecorderControlState(state, "paused", false, dispatch);
		};
		await pause();
		expect(state.current.paused).toBe(true);
		await resume();
		expect(state.current.paused).toBe(false);
		expect(dispatch).toHaveBeenNthCalledWith(1, true);
		expect(dispatch).toHaveBeenNthCalledWith(2, false);
	});
	it("commits countdown and completed stop before dispatch callbacks run", () => {
		const state = {
			current: { ...idle, recording: true, finalizing: true, countdownActive: true },
		};
		commitRecorderControlState(state, "countdownActive", false, () =>
			expect(state.current.countdownActive).toBe(false),
		);
		commitRecorderControlState(state, "recording", false, () =>
			expect(state.current.recording).toBe(false),
		);
		commitRecorderControlState(state, "finalizing", false, () =>
			expect(() => assertRecorderTransition(state.current, "start")).not.toThrow(),
		);
	});
});
