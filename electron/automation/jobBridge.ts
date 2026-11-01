import { randomUUID } from "node:crypto";
import type { BrowserWindow, IpcMainEvent } from "electron";
import { ipcMain } from "electron";
import { AutomationError } from "../../shared/automation";
import {
	type AutomationJobRendererEvent,
	cloneJobJson,
	type JobJson,
	type JobObject,
	type RendererAutomationJobKind,
} from "../../shared/jobAutomation";
import type { AutomationJobContext } from "./jobs";

export class AutomationJobBridge {
	private ready = new Set<number>();
	private watched = new Map<
		number,
		{ contents: BrowserWindow["webContents"]; lost: () => void; destroyed: () => void }
	>();
	private closed = false;
	private captures = new Map<
		string,
		{
			sender: number;
			resolve: (value: JobJson) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private runs = new Map<
		string,
		{
			sender: number;
			ctx: AutomationJobContext;
			resolve: (value: JobJson) => void;
			reject: (error: Error) => void;
			chain: Promise<void>;
			cleanup: () => void;
		}
	>();
	constructor(
		private options: {
			getEditor: () => BrowserWindow | null;
			createEditor: () => BrowserWindow;
			interrupt: (id: string, error: Error) => void;
		},
	) {
		ipcMain.on("automation:jobs-ready", this.onReady);
		ipcMain.on("automation:job-event", this.onEvent);
	}
	private watch(editor: BrowserWindow): void {
		const contents = editor.webContents;
		const id = contents.id;
		if (this.watched.has(id)) return;
		const lost = () => this.failSender(id);
		const destroyed = () => {
			lost();
			this.unwatch(id);
		};
		this.watched.set(id, { contents, lost, destroyed });
		contents.on("did-start-loading", lost);
		contents.on("render-process-gone", lost);
		contents.once("destroyed", destroyed);
	}
	private unwatch(id: number): void {
		const watched = this.watched.get(id);
		if (!watched) return;
		watched.contents.removeListener("did-start-loading", watched.lost);
		watched.contents.removeListener("render-process-gone", watched.lost);
		watched.contents.removeListener("destroyed", watched.destroyed);
		this.watched.delete(id);
	}
	private onReady = (event: IpcMainEvent) => {
		const editor = this.options.getEditor();
		if (
			!editor ||
			editor.isDestroyed() ||
			editor.webContents.id !== event.sender.id ||
			this.closed
		)
			return;
		this.watch(editor);
		this.ready.add(event.sender.id);
	};
	private failSender(sender: number) {
		this.ready.delete(sender);
		const error = new AutomationError(
			"WORKER_INTERRUPTED",
			"The editor worker closed or reloaded; inspect the durable job before retrying.",
		);
		for (const [id, capture] of this.captures)
			if (capture.sender === sender) {
				clearTimeout(capture.timer);
				this.captures.delete(id);
				capture.reject(error);
			}
		for (const [id, run] of this.runs)
			if (run.sender === sender) {
				this.runs.delete(id);
				run.cleanup();
				this.options.interrupt(id, error);
				run.reject(error);
			}
	}
	private async editor(signal?: AbortSignal) {
		if (this.closed) throw new AutomationError("APP_CLOSING", "Job bridge is closed.");
		signal?.throwIfAborted();
		const editor = this.options.getEditor() ?? this.options.createEditor();
		const id = editor.webContents.id;
		this.watch(editor);
		const deadline = Date.now() + 30000;
		while (!this.ready.has(id)) {
			signal?.throwIfAborted();
			if (this.closed || editor.isDestroyed())
				throw new AutomationError("EDITOR_CLOSED", "Editor worker is unavailable.");
			if (Date.now() > deadline)
				throw new AutomationError(
					"EDITOR_NOT_READY",
					"Editor did not register its job worker.",
				);
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
		signal?.throwIfAborted();
		if (this.closed || editor.isDestroyed())
			throw new AutomationError("EDITOR_CLOSED", "Editor worker is unavailable.");
		return editor;
	}
	async capture(kind: RendererAutomationJobKind, input: JobObject): Promise<JobJson> {
		const editor = await this.editor();
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.captures.delete(requestId);
				reject(new AutomationError("TIMEOUT", "Snapshot capture timed out."));
			}, 35000);
			this.captures.set(requestId, { sender: editor.webContents.id, resolve, reject, timer });
			try {
				editor.webContents.send("automation:job-request", {
					action: "capture",
					requestId,
					kind,
					input,
				});
			} catch (error) {
				clearTimeout(timer);
				this.captures.delete(requestId);
				reject(error);
			}
		});
	}
	async run(ctx: AutomationJobContext): Promise<JobJson> {
		if (this.runs.has(ctx.jobId))
			throw new AutomationError("BUSY", "This job already owns a renderer worker.");
		const editor = await this.editor(ctx.signal);
		if (this.runs.has(ctx.jobId))
			throw new AutomationError("BUSY", "This job already owns a renderer worker.");
		return new Promise((resolve, reject) => {
			const cancel = () => {
				if (!editor.isDestroyed()) {
					try {
						editor.webContents.send("automation:job-request", {
							action: "cancel",
							jobId: ctx.jobId,
						});
					} catch {
						this.failSender(editor.webContents.id);
					}
				}
			};
			ctx.signal.addEventListener("abort", cancel, { once: true });
			this.runs.set(ctx.jobId, {
				sender: editor.webContents.id,
				ctx,
				resolve,
				reject,
				chain: Promise.resolve(),
				cleanup: () => ctx.signal.removeEventListener("abort", cancel),
			});
			try {
				editor.webContents.send("automation:job-request", {
					action: "run",
					jobId: ctx.jobId,
					kind: ctx.kind,
					input: ctx.input,
					snapshot: ctx.snapshot,
				});
			} catch (error) {
				this.runs.delete(ctx.jobId);
				ctx.signal.removeEventListener("abort", cancel);
				reject(error);
			}
		});
	}
	private onEvent = (event: IpcMainEvent, message: AutomationJobRendererEvent) => {
		if (!message || typeof message !== "object" || this.closed) return;
		if (message.type === "captured" || message.type === "capture-error") {
			const capture = this.captures.get(message.requestId);
			if (!capture || capture.sender !== event.sender.id) return;
			this.captures.delete(message.requestId);
			clearTimeout(capture.timer);
			if (message.type === "captured") {
				try {
					capture.resolve(cloneJobJson(message.snapshot));
				} catch (error) {
					capture.reject(error as Error);
				}
			} else if (
				message.error &&
				typeof message.error.code === "string" &&
				typeof message.error.message === "string"
			)
				capture.reject(
					new AutomationError(
						message.error.code,
						message.error.message,
						message.error.details,
					),
				);
			else
				capture.reject(
					new AutomationError(
						"INVALID_RESPONSE",
						"Snapshot worker returned an invalid error.",
					),
				);
			return;
		}
		if (
			!["progress", "checkpoint", "committing", "complete", "error", "interrupted"].includes(
				message.type,
			)
		)
			return;
		const run = this.runs.get(message.jobId);
		if (!run || run.sender !== event.sender.id) return;
		run.chain = run.chain
			.then(async () => {
				if (this.runs.get(message.jobId) !== run) return;
				if (message.type === "progress") run.ctx.progress(message.progress);
				else if (message.type === "checkpoint")
					await run.ctx.checkpoint(message.checkpoint);
				else if (message.type === "committing")
					return; // Only main may authorize external publication.
				else {
					this.runs.delete(message.jobId);
					run.cleanup();
					if (message.type === "complete") run.resolve(cloneJobJson(message.result));
					else if (
						message.error &&
						typeof message.error.code === "string" &&
						typeof message.error.message === "string"
					) {
						const error = new AutomationError(
							message.error.code,
							message.error.message,
							message.error.details,
						);
						if (message.type === "interrupted")
							this.options.interrupt(message.jobId, error);
						run.reject(error);
					} else
						run.reject(
							new AutomationError(
								"INVALID_RESPONSE",
								"Job worker returned an invalid error.",
							),
						);
				}
			})
			.catch((error) => {
				this.runs.delete(message.jobId);
				run.cleanup();
				run.reject(error);
			});
	};
	close() {
		if (this.closed) return;
		this.closed = true;
		ipcMain.removeListener("automation:jobs-ready", this.onReady);
		ipcMain.removeListener("automation:job-event", this.onEvent);
		for (const id of [...this.watched.keys()]) {
			this.failSender(id);
			this.unwatch(id);
		}
	}
}
