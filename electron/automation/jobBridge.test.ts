import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationError } from "../../shared/automation";
import type {
	AutomationJobRendererEvent,
	AutomationJobRendererRequest,
} from "../../shared/jobAutomation";
import type { AutomationJobContext } from "./jobs";

const mocks = vi.hoisted(() => ({ listeners: new Map<string, (...args: unknown[]) => void>() }));
vi.mock("electron", () => ({
	ipcMain: {
		on: (name: string, listener: (...args: unknown[]) => void) =>
			mocks.listeners.set(name, listener),
		removeListener: (name: string) => mocks.listeners.delete(name),
	},
}));

import { AutomationJobBridge } from "./jobBridge";

let editor: ReturnType<typeof makeWindow>;
let bridge: AutomationJobBridge;
let interrupt: ReturnType<typeof vi.fn>;
const makeWindow = (id = 22) => ({
	webContents: Object.assign(new EventEmitter(), { id, send: vi.fn() }),
	isDestroyed: () => false,
});
function ready(sender = editor.webContents) {
	mocks.listeners.get("automation:jobs-ready")!({ sender });
}
function event(message: AutomationJobRendererEvent, sender = editor.webContents) {
	mocks.listeners.get("automation:job-event")!({ sender }, message);
}
function context(signal = new AbortController().signal): AutomationJobContext {
	return {
		jobId: "job",
		kind: "export",
		input: { outputPath: "/tmp/export.mp4" },
		snapshot: { padding: 1 },
		signal,
		progress: vi.fn(),
		checkpoint: vi.fn(async () => {}),
		beginCommit: vi.fn(),
	};
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
	mocks.listeners.clear();
	editor = makeWindow();
	interrupt = vi.fn();
	bridge = new AutomationJobBridge({
		getEditor: () => editor as unknown as BrowserWindow,
		createEditor: () => editor as unknown as BrowserWindow,
		interrupt,
	});
});
afterEach(() => {
	bridge.close();
	vi.useRealTimers();
});

describe("trusted renderer job bridge", () => {
	it("ignores forged readiness and capture replies", async () => {
		vi.useFakeTimers();
		ready(makeWindow(99).webContents);
		const captured = bridge.capture("export", {});
		await vi.advanceTimersByTimeAsync(40);
		expect(editor.webContents.send).not.toHaveBeenCalled();
		ready();
		await vi.advanceTimersByTimeAsync(40);
		const request = editor.webContents.send.mock.calls[0][1] as Extract<
			AutomationJobRendererRequest,
			{ action: "capture" }
		>;
		event(
			{ type: "captured", requestId: request.requestId, snapshot: { forged: true } },
			makeWindow(99).webContents,
		);
		event({ type: "captured", requestId: request.requestId, snapshot: { padding: 10 } });
		await expect(captured).resolves.toEqual({ padding: 10 });
	});
	it("times out a capture and ignores its late response", async () => {
		vi.useFakeTimers();
		ready();
		const capture = bridge.capture("export", {});
		const rejected = expect(capture).rejects.toMatchObject({ code: "TIMEOUT" });
		await vi.advanceTimersByTimeAsync(0);
		const request = editor.webContents.send.mock.calls[0][1] as Extract<
			AutomationJobRendererRequest,
			{ action: "capture" }
		>;
		await vi.advanceTimersByTimeAsync(35000);
		await rejected;
		event({ type: "captured", requestId: request.requestId, snapshot: {} });
	});
	it("serializes checkpoint persistence before resolving a completed worker", async () => {
		ready();
		const ctx = context();
		let persisted!: () => void;
		(ctx.checkpoint as ReturnType<typeof vi.fn>).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					persisted = resolve;
				}),
		);
		const run = bridge.run(ctx);
		await tick();
		event({
			type: "checkpoint",
			jobId: "job",
			checkpoint: { tempFilePath: "/tmp/retained.mp4" },
		});
		event({ type: "complete", jobId: "job", result: { tempFilePath: "/tmp/retained.mp4" } });
		let complete = false;
		void run.then(() => {
			complete = true;
		});
		await tick();
		expect(complete).toBe(false);
		persisted();
		await expect(run).resolves.toEqual({ tempFilePath: "/tmp/retained.mp4" });
	});
	it("keeps a running job pending after cancellation until the renderer actually exits", async () => {
		ready();
		const controller = new AbortController();
		const run = bridge.run(context(controller.signal));
		await tick();
		controller.abort(new AutomationError("CANCELLED", "cancelled"));
		expect(editor.webContents.send.mock.calls.at(-1)?.[1]).toEqual({
			action: "cancel",
			jobId: "job",
		});
		let complete = false;
		void run.catch(() => {
			complete = true;
		});
		await tick();
		expect(complete).toBe(false);
		event({
			type: "error",
			jobId: "job",
			error: { code: "CANCELLED", message: "Encoder exited" },
		});
		await expect(run).rejects.toMatchObject({ code: "CANCELLED" });
	});
	it("ignores a forged job completion and renderer commit request", async () => {
		ready();
		const ctx = context();
		const run = bridge.run(ctx);
		await tick();
		event(
			{ type: "complete", jobId: "job", result: { forged: true } },
			makeWindow(99).webContents,
		);
		event({ type: "committing", jobId: "job" });
		event({ type: "progress", jobId: "job", progress: { phase: "rendering", percentage: 30 } });
		event({ type: "complete", jobId: "job", result: { tempFilePath: "/managed/export.mp4" } });
		await expect(run).resolves.toEqual({ tempFilePath: "/managed/export.mp4" });
		expect(ctx.beginCommit).not.toHaveBeenCalled();
		expect(ctx.progress).toHaveBeenCalledWith({ phase: "rendering", percentage: 30 });
	});
	it.each([
		"did-start-loading",
		"render-process-gone",
		"destroyed",
	])("interrupts a job on %s and never accepts a late success", async (lifecycle) => {
		ready();
		const run = bridge.run(context());
		const rejected = expect(run).rejects.toMatchObject({ code: "WORKER_INTERRUPTED" });
		await tick();
		editor.webContents.emit(lifecycle);
		await rejected;
		expect(interrupt).toHaveBeenCalledWith(
			"job",
			expect.objectContaining({ code: "WORKER_INTERRUPTED" }),
		);
		event({ type: "complete", jobId: "job", result: {} });
	});
	it("invalidates readiness even when a reload precedes the first job", async () => {
		vi.useFakeTimers();
		ready();
		editor.webContents.emit("did-start-loading");
		const run = bridge.run(context());
		await vi.advanceTimersByTimeAsync(40);
		expect(editor.webContents.send).not.toHaveBeenCalled();
		ready();
		await vi.advanceTimersByTimeAsync(40);
		event({ type: "complete", jobId: "job", result: {} });
		await run;
	});
	it("cancels promptly during initial worker readiness without sending a stale run", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const run = bridge.run(context(controller.signal));
		const rejected = expect(run).rejects.toThrow("cancelled");
		controller.abort(new Error("cancelled"));
		await vi.advanceTimersByTimeAsync(40);
		await rejected;
		expect(editor.webContents.send).not.toHaveBeenCalled();
	});
	it("cleans scoped requests when sending fails and removes lifecycle listeners on close", async () => {
		ready();
		editor.webContents.send.mockImplementationOnce(() => {
			throw new Error("Send failed");
		});
		await expect(bridge.capture("export", {})).rejects.toThrow("Send failed");
		editor.webContents.send.mockImplementationOnce(() => {
			throw new Error("Send failed");
		});
		await expect(bridge.run(context())).rejects.toThrow("Send failed");
		bridge.close();
		expect(mocks.listeners.size).toBe(0);
		expect(editor.webContents.listenerCount("did-start-loading")).toBe(0);
		expect(editor.webContents.listenerCount("render-process-gone")).toBe(0);
		await expect(bridge.capture("export", {})).rejects.toMatchObject({ code: "APP_CLOSING" });
	});
	it("does not cancel an existing worker when a second caller retries its same job id", async () => {
		ready();
		const run = bridge.run(context());
		await tick();
		await expect(bridge.run(context())).rejects.toMatchObject({ code: "BUSY" });
		event({ type: "complete", jobId: "job", result: { saved: true } });
		await expect(run).resolves.toEqual({ saved: true });
	});
});
