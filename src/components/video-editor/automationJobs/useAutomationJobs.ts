import { useEffect, useRef } from "react";
import { AutomationError, toAutomationError } from "../../../../shared/automation";
import {
	type AutomationJobProgress,
	type AutomationJobRendererEvent,
	type AutomationJobRendererRequest,
	cloneJobJson,
	freezeJobJson,
	type JobJson,
	type JobObject,
	type RendererAutomationJobKind,
} from "../../../../shared/jobAutomation";

export interface RendererAutomationJobContext {
	jobId: string;
	signal: AbortSignal;
	progress: (progress: AutomationJobProgress) => void;
	checkpoint: (checkpoint: JobObject) => void;
	beginCommit: () => void;
}
export interface AutomationJobCallbacks {
	/** Must assert media readiness, expected revision and full settings before capture. */
	capture: (kind: RendererAutomationJobKind, input: JobObject) => JobJson | Promise<JobJson>;
	/** Supplied snapshot is immutable; never substitute current React state after an await. */
	export: (
		snapshot: JobJson,
		input: JobObject,
		context: RendererAutomationJobContext,
	) => Promise<JobJson>;
	exportSave?: (
		snapshot: JobJson,
		input: JobObject,
		context: RendererAutomationJobContext,
	) => Promise<JobJson>;
	captions: (
		snapshot: JobJson,
		input: JobObject,
		context: RendererAutomationJobContext,
	) => Promise<JobJson>;
}
export interface AutomationJobTransport {
	subscribe: (handler: (request: AutomationJobRendererRequest) => void) => () => void;
	report: (event: AutomationJobRendererEvent) => void;
}

/** Transport-independent worker, also used by renderer lifecycle tests. */
export function attachAutomationJobWorker(
	transport: AutomationJobTransport,
	current: () => AutomationJobCallbacks,
): () => void {
	let disposed = false;
	const running = new Map<string, AbortController>();
	const capturing = new Set<string>();
	const report = (event: AutomationJobRendererEvent) => {
		if (!disposed) transport.report(event);
	};
	const unsubscribe = transport.subscribe((request) => {
		if (disposed) return;
		if (request.action === "cancel") {
			running
				.get(request.jobId)
				?.abort(new AutomationError("CANCELLED", "Job cancellation was requested."));
			return;
		}
		if (request.action === "capture") {
			if (capturing.has(request.requestId)) return; // The original capture owns its eventual reply.
			if (capturing.size || running.size) {
				report({
					type: "capture-error",
					requestId: request.requestId,
					error: { code: "BUSY", message: "Another renderer capture or job is pending." },
				});
				return;
			}
			void (async () => {
				capturing.add(request.requestId);
				try {
					if (running.size)
						throw new AutomationError("BUSY", "A renderer job is already running.");
					const input = freezeJobJson(cloneJobJson(request.input));
					const snapshot = freezeJobJson(
						cloneJobJson(await current().capture(request.kind, input)),
					);
					report({ type: "captured", requestId: request.requestId, snapshot });
				} catch (error) {
					report({
						type: "capture-error",
						requestId: request.requestId,
						error: toAutomationError(error),
					});
				} finally {
					capturing.delete(request.requestId);
				}
			})();
			return;
		}
		if (running.has(request.jobId)) return; // A duplicate must not settle the original run as failed.
		if (running.size || capturing.size) {
			report({
				type: "error",
				jobId: request.jobId,
				error: {
					code: "BUSY",
					message: "Another renderer job is active. The existing job was not repeated.",
				},
			});
			return;
		}
		const controller = new AbortController();
		running.set(request.jobId, controller);
		void (async () => {
			try {
				const snapshot = freezeJobJson(cloneJobJson(request.snapshot));
				const input = freezeJobJson(cloneJobJson(request.input));
				const callbacks = current();
				const callback =
					request.kind === "export"
						? callbacks.export
						: request.kind === "export.save"
							? callbacks.exportSave
							: callbacks.captions;
				if (!callback)
					throw new AutomationError(
						"JOB_UNAVAILABLE",
						"This worker cannot save retained export output.",
					);
				const context: RendererAutomationJobContext = {
					jobId: request.jobId,
					signal: controller.signal,
					progress: (progress) =>
						report({ type: "progress", jobId: request.jobId, progress }),
					checkpoint: (checkpoint) =>
						report({
							type: "checkpoint",
							jobId: request.jobId,
							checkpoint: cloneJobJson(checkpoint),
						}),
					beginCommit: () => {
						controller.signal.throwIfAborted();
						report({ type: "committing", jobId: request.jobId });
					},
				};
				const result = await callback(snapshot, input, context);
				controller.signal.throwIfAborted();
				report({ type: "complete", jobId: request.jobId, result: cloneJobJson(result) });
			} catch (error) {
				report({ type: "error", jobId: request.jobId, error: toAutomationError(error) });
			} finally {
				running.delete(request.jobId);
			}
		})();
	});
	return () => {
		if (disposed) return;
		unsubscribe();
		for (const [jobId, controller] of running) {
			controller.abort(
				new AutomationError("WORKER_INTERRUPTED", "Editor worker was unloaded."),
			);
			transport.report({
				type: "interrupted",
				jobId,
				error: {
					code: "WORKER_INTERRUPTED",
					message:
						"Editor worker unloaded before completion was confirmed. Inspect output before retrying.",
				},
			});
		}
		for (const requestId of capturing)
			transport.report({
				type: "capture-error",
				requestId,
				error: {
					code: "WORKER_INTERRUPTED",
					message: "Editor unloaded while capturing its document.",
				},
			});
		disposed = true;
	};
}

export function useAutomationJobs(options: {
	transport: AutomationJobTransport;
	callbacks: AutomationJobCallbacks;
}): void {
	const latest = useRef(options.callbacks);
	latest.current = options.callbacks;
	useEffect(
		() => attachAutomationJobWorker(options.transport, () => latest.current),
		[options.transport],
	);
}
