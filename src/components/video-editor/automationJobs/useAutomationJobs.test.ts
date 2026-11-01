import { describe, expect, it } from "vitest";
import type {
	AutomationJobRendererEvent,
	AutomationJobRendererRequest,
	JobJson,
} from "../../../../shared/jobAutomation";
import {
	type AutomationJobCallbacks,
	attachAutomationJobWorker,
	type RendererAutomationJobContext,
} from "./useAutomationJobs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function worker(callbacks: AutomationJobCallbacks) {
	let receive!: (request: AutomationJobRendererRequest) => void;
	const events: AutomationJobRendererEvent[] = [];
	const detach = attachAutomationJobWorker(
		{
			subscribe: (handler) => {
				receive = handler;
				return () => {};
			},
			report: (event) => events.push(event),
		},
		() => callbacks,
	);
	return { receive, events, detach };
}

describe("renderer job worker ownership", () => {
	it("captures separately and executes only the supplied frozen document", async () => {
		const document = { padding: 10 };
		const service = worker({
			capture: () => document,
			export: async (snapshot) => {
				expect(Object.isFrozen(snapshot)).toBe(true);
				return snapshot;
			},
			captions: async () => ({}),
		});
		service.receive({ action: "capture", requestId: "capture", kind: "export", input: {} });
		await tick();
		expect(service.events).toEqual([
			{ type: "captured", requestId: "capture", snapshot: { padding: 10 } },
		]);
		document.padding = 90;
		service.receive({
			action: "run",
			jobId: "job",
			kind: "export",
			input: {},
			snapshot: { padding: 10 },
		});
		await tick();
		expect(service.events.at(-1)).toEqual({
			type: "complete",
			jobId: "job",
			result: { padding: 10 },
		});
		service.detach();
	});
	it("does not mark cancellation complete before the actual export stops", async () => {
		let context!: RendererAutomationJobContext;
		let finish!: (result: JobJson) => void;
		const service = worker({
			capture: () => ({}),
			export: async (_snapshot, _input, ctx) => {
				context = ctx;
				return new Promise((resolve) => {
					finish = resolve;
				});
			},
			captions: async () => ({}),
		});
		service.receive({ action: "run", jobId: "job", kind: "export", input: {}, snapshot: {} });
		service.receive({ action: "cancel", jobId: "job" });
		expect(context.signal.aborted).toBe(true);
		expect(service.events).toEqual([]);
		finish({ saved: false });
		await tick();
		expect(service.events).toMatchObject([
			{ type: "error", jobId: "job", error: { code: "CANCELLED" } },
		]);
		service.detach();
	});
	it("reports interruption on unload and suppresses late successful completion", async () => {
		let finish!: (result: JobJson) => void;
		const service = worker({
			capture: () => ({}),
			export: async () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
			captions: async () => ({}),
		});
		service.receive({ action: "run", jobId: "job", kind: "export", input: {}, snapshot: {} });
		service.detach();
		finish({ saved: true });
		await tick();
		expect(service.events).toMatchObject([
			{ type: "interrupted", jobId: "job", error: { code: "WORKER_INTERRUPTED" } },
		]);
	});
	it("rejects duplicate execution without invoking the encoder twice", async () => {
		let runs = 0;
		let finish!: (result: JobJson) => void;
		const service = worker({
			capture: () => ({}),
			export: async () => {
				runs++;
				return new Promise((resolve) => {
					finish = resolve;
				});
			},
			captions: async () => ({}),
		});
		const request = {
			action: "run",
			jobId: "job",
			kind: "export",
			input: {},
			snapshot: {},
		} as const;
		service.receive(request);
		service.receive(request);
		expect(runs).toBe(1);
		expect(service.events).toEqual([]);
		finish({});
		await tick();
		service.detach();
	});
	it("forwards encoding progress and retained-output checkpoints", async () => {
		const service = worker({
			capture: () => ({}),
			export: async (_snapshot, _input, context) => {
				context.progress({ phase: "encoding", percentage: 30 });
				context.checkpoint({ pendingOutputPath: "/tmp/video.mp4" });
				context.beginCommit();
				return { outputPath: "/tmp/video.mp4" };
			},
			captions: async () => ({}),
		});
		service.receive({ action: "run", jobId: "job", kind: "export", input: {}, snapshot: {} });
		await tick();
		expect(service.events.map((event) => event.type)).toEqual([
			"progress",
			"checkpoint",
			"committing",
			"complete",
		]);
		service.detach();
	});
});
