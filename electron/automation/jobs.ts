import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AutomationError, toAutomationError } from "../../shared/automation";
import {
	type AutomationJobKind,
	type AutomationJobProgress,
	type AutomationJobRecord,
	type AutomationJobState,
	type AutomationJobView,
	cloneJobJson,
	freezeJobJson,
	isJobTerminal,
	JOB_KINDS,
	type JobJson,
	type JobObject,
} from "../../shared/jobAutomation";

export interface AutomationJobContext {
	jobId: string;
	kind: AutomationJobKind;
	input: JobObject;
	snapshot?: JobJson;
	signal: AbortSignal;
	progress: (progress: AutomationJobProgress) => void;
	checkpoint: (checkpoint: JobObject) => Promise<void>;
	beginCommit: () => void;
}
export type AutomationJobRunner = (context: AutomationJobContext) => Promise<JobJson>;
const validId = /^[a-f0-9-]{36}$/;
const ACTIVE_STATES: AutomationJobState[] = ["queued", "running", "cancelling"];

/** Durable desktop-owned work. No transport or client connection owns a job. */
export class AutomationJobManager {
	private records = new Map<string, AutomationJobRecord>();
	private runners = new Map<AutomationJobKind, AutomationJobRunner>();
	private controllers = new Map<string, AbortController>();
	private executions = new Map<string, Promise<void>>();
	private writes = new Map<string, Promise<void>>();
	private listeners = new Set<() => void>();
	private progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private ready = false;
	private closed = false;
	private pumping = false;
	private initialising: Promise<void> | null = null;
	readonly diagnostics: string[] = [];
	constructor(private options: { directory: string; maxConcurrent?: number }) {
		if (!path.isAbsolute(options.directory))
			throw new AutomationError("INVALID_PARAMS", "Job directory must be absolute.");
		if (
			!Number.isInteger(options.maxConcurrent ?? 1) ||
			(options.maxConcurrent ?? 1) < 1 ||
			(options.maxConcurrent ?? 1) > 16
		)
			throw new AutomationError("INVALID_PARAMS", "Invalid job concurrency.");
	}
	async initialize(): Promise<void> {
		if (this.ready) return;
		if (this.initialising) return this.initialising;
		this.initialising = this.load();
		try {
			await this.initialising;
			this.ready = true;
		} finally {
			this.initialising = null;
		}
	}
	private async load(): Promise<void> {
		await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
		const directory = await fs.lstat(this.options.directory);
		if (
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			(process.getuid && directory.uid !== process.getuid())
		)
			throw new AutomationError(
				"ACCESS_DENIED",
				"Jobs directory must be a directory owned by the current user.",
			);
		await fs.chmod(this.options.directory, 0o700);
		const files = await fs.readdir(this.options.directory);
		if (files.length > 10000)
			throw new AutomationError("JOB_LIMIT", "Jobs directory contains too many entries.");
		for (const file of files) {
			if (!/^job-[a-f0-9-]{36}\.json$/.test(file)) continue;
			try {
				const fullPath = path.join(this.options.directory, file);
				const metadata = await fs.lstat(fullPath);
				if (
					!metadata.isFile() ||
					metadata.isSymbolicLink() ||
					metadata.size > 64 * 1024 * 1024 ||
					(process.getuid && metadata.uid !== process.getuid())
				)
					throw new Error("Invalid job file");
				const record = JSON.parse(
					await fs.readFile(fullPath, "utf8"),
				) as AutomationJobRecord;
				if (
					record.version !== 1 ||
					!validId.test(record.id) ||
					file !== `job-${record.id}.json` ||
					!JOB_KINDS.includes(record.kind) ||
					![...ACTIVE_STATES, "succeeded", "failed", "cancelled", "interrupted"].includes(
						record.state,
					) ||
					!Number.isSafeInteger(record.revision) ||
					record.revision < 1 ||
					!record.input ||
					typeof record.input !== "object" ||
					Array.isArray(record.input)
				)
					throw new Error("Invalid job record");
				this.records.set(
					record.id,
					cloneJobJson(
						record as unknown as JobJson,
						64 * 1024 * 1024,
					) as unknown as AutomationJobRecord,
				);
				if (!isJobTerminal(record.state)) {
					record.state = "interrupted";
					record.error = {
						code: "APP_RESTARTED",
						message:
							"The application restarted before this job completed. Inspect existing outputs before explicitly retrying.",
					};
					record.cancellationAllowed = false;
					record.finishedAt = new Date().toISOString();
					this.records.set(record.id, record);
					this.touch(record);
					await this.persist(record);
				}
			} catch {
				this.diagnostics.push(`Could not load ${file}; no work was replayed.`);
			}
		}
	}
	registerRunner(kind: AutomationJobKind, runner: AutomationJobRunner): void {
		if (this.closed) throw new AutomationError("APP_CLOSING", "Job manager is closed.");
		this.runners.set(kind, runner);
		this.pump();
	}
	async create(options: {
		kind: AutomationJobKind;
		input: JobObject;
		snapshot?: JobJson;
		retryOf?: string;
	}): Promise<AutomationJobView> {
		await this.initialize();
		if (this.closed) throw new AutomationError("APP_CLOSING", "Job manager is closed.");
		if (!JOB_KINDS.includes(options.kind))
			throw new AutomationError("INVALID_PARAMS", "Unknown job kind.");
		if (!this.runners.has(options.kind))
			throw new AutomationError(
				"JOB_UNAVAILABLE",
				"No worker is registered for this job kind.",
			);
		if (this.records.size >= 10000)
			throw new AutomationError("JOB_LIMIT", "Job history limit reached.");
		const now = new Date().toISOString();
		const record: AutomationJobRecord = {
			version: 1,
			id: randomUUID(),
			kind: options.kind,
			state: "queued",
			revision: 1,
			createdAt: now,
			updatedAt: now,
			cancellationAllowed: true,
			input: cloneJobJson(options.input),
			progress: { phase: "queued" },
			...(options.snapshot === undefined ? {} : { snapshot: cloneJobJson(options.snapshot) }),
			...(options.retryOf ? { retryOf: options.retryOf } : {}),
		};
		await this.persist(record);
		this.records.set(record.id, record);
		this.emit();
		this.pump();
		return this.view(record);
	}
	get(id: string): AutomationJobView {
		return this.view(this.record(id));
	}
	getRecord(id: string): AutomationJobRecord {
		return cloneJobJson(
			this.record(id) as unknown as JobJson,
			64 * 1024 * 1024,
		) as unknown as AutomationJobRecord;
	}
	/** Main-only acknowledgement: a retained terminal export was published by another job. */
	async consumeArtifact(
		id: string,
		artifactPath: string,
		publishedPath: string,
		consumedBy: string,
	): Promise<void> {
		const record = this.record(id);
		if (!isJobTerminal(record.state) || record.checkpoint?.artifactPath !== artifactPath)
			throw new AutomationError(
				"INVALID_JOB_STATE",
				"The retained export no longer matches this job.",
			);
		record.checkpoint = cloneJobJson({
			...record.checkpoint,
			retained: false,
			publishedPath,
			consumedBy,
		});
		this.touch(record);
		await this.persist(record);
		this.emit();
	}
	list(
		options: { limit?: number; state?: AutomationJobState; kind?: AutomationJobKind } = {},
	): AutomationJobView[] {
		return [...this.records.values()]
			.filter(
				(record) =>
					(!options.state || record.state === options.state) &&
					(!options.kind || record.kind === options.kind),
			)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, Math.max(1, Math.min(1000, options.limit ?? 100)))
			.map((record) => {
				const view = this.view(record);
				delete view.result;
				return view;
			});
	}
	async wait(
		id: string,
		options: { timeoutMs?: number; afterRevision?: number } = {},
	): Promise<AutomationJobView> {
		const timeout = Math.max(0, Math.min(60000, options.timeoutMs ?? 30000));
		const changed = () => {
			const record = this.record(id);
			return (
				isJobTerminal(record.state) ||
				(options.afterRevision !== undefined && record.revision > options.afterRevision)
			);
		};
		if (changed() || timeout === 0) return this.get(id);
		return new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				this.listeners.delete(onChange);
				resolve(this.get(id));
			};
			const onChange = () => {
				if (changed()) finish();
			};
			const timer = setTimeout(finish, timeout);
			this.listeners.add(onChange);
			if (changed()) finish();
		});
	}
	async cancel(id: string): Promise<AutomationJobView> {
		const record = this.record(id);
		if (isJobTerminal(record.state) || record.state === "cancelling") return this.view(record);
		if (!record.cancellationAllowed)
			throw new AutomationError(
				"NOT_CANCELLABLE",
				"Output publication has started; wait for the final job result.",
			);
		record.cancelRequestedAt = new Date().toISOString();
		if (record.state === "queued") {
			record.state = "cancelled";
			record.finishedAt = record.cancelRequestedAt;
			record.cancellationAllowed = false;
			record.progress = { phase: "cancelled" };
		} else {
			record.state = "cancelling";
			record.progress = { ...record.progress, phase: "cancelling" };
		}
		this.touch(record);
		this.controllers
			.get(id)
			?.abort(new AutomationError("CANCELLED", "Job cancellation was requested."));
		await this.persist(record);
		this.emit();
		this.pump();
		return this.view(record);
	}
	async retry(
		id: string,
		changes: { input?: JobObject; snapshot?: JobJson } = {},
	): Promise<AutomationJobView> {
		const previous = this.record(id);
		if (!["failed", "cancelled", "interrupted"].includes(previous.state))
			throw new AutomationError(
				"INVALID_JOB_STATE",
				"Only a failed, cancelled or interrupted job can be retried.",
			);
		return this.create({
			kind: previous.kind,
			input: changes.input ?? previous.input,
			snapshot: changes.snapshot ?? previous.snapshot,
			retryOf: previous.id,
		});
	}
	async interrupt(
		id: string,
		error: unknown = new AutomationError(
			"WORKER_INTERRUPTED",
			"The job worker exited before confirming completion.",
		),
	): Promise<AutomationJobView> {
		const record = this.record(id);
		if (isJobTerminal(record.state)) return this.view(record);
		record.state = "interrupted";
		record.error = toAutomationError(error);
		record.cancellationAllowed = false;
		record.finishedAt = new Date().toISOString();
		this.touch(record);
		this.controllers
			.get(id)
			?.abort(new AutomationError("WORKER_INTERRUPTED", record.error.message));
		await this.persist(record);
		this.emit();
		return this.view(record);
	}
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await Promise.all(
			[...this.records.values()]
				.filter((record) => !isJobTerminal(record.state))
				.map((record) =>
					this.interrupt(
						record.id,
						new AutomationError(
							"APP_CLOSING",
							"Application closed before worker completion was confirmed.",
						),
					),
				),
		);
		for (const timer of this.progressTimers.values()) clearTimeout(timer);
		this.progressTimers.clear();
		await Promise.allSettled(this.writes.values());
		this.emit();
	}
	private record(id: string): AutomationJobRecord {
		const record = this.records.get(id);
		if (!record) throw new AutomationError("JOB_NOT_FOUND", "Unknown job id.");
		return record;
	}
	private view(record: AutomationJobRecord): AutomationJobView {
		const { input: _input, snapshot: _snapshot, ...rest } = record;
		return {
			...(cloneJobJson(rest as unknown as JobJson, 64 * 1024 * 1024) as unknown as Omit<
				AutomationJobRecord,
				"input" | "snapshot"
			>),
			terminal: isJobTerminal(record.state),
		};
	}
	private touch(record: AutomationJobRecord): void {
		record.revision += 1;
		record.updatedAt = new Date().toISOString();
	}
	private emit(): void {
		for (const listener of [...this.listeners]) listener();
	}
	private persist(record: AutomationJobRecord): Promise<void> {
		const json = JSON.stringify(record);
		if (Buffer.byteLength(json) > 64 * 1024 * 1024)
			return Promise.reject(
				new AutomationError(
					"JOB_TOO_LARGE",
					"Job record exceeds the durable storage limit.",
				),
			);
		const target = path.join(this.options.directory, `job-${record.id}.json`);
		const next = (this.writes.get(record.id) ?? Promise.resolve())
			.catch(() => undefined)
			.then(async () => {
				const temporary = `${target}.${randomUUID()}.tmp`;
				try {
					const file = await fs.open(temporary, "wx", 0o600);
					try {
						await file.writeFile(json, "utf8");
						await file.sync();
					} finally {
						await file.close();
					}
					await fs.rename(temporary, target);
					const directory = await fs.open(this.options.directory, "r");
					try {
						await directory.sync();
					} finally {
						await directory.close();
					}
				} finally {
					await fs.rm(temporary, { force: true }).catch(() => undefined);
				}
			});
		this.writes.set(record.id, next);
		return next;
	}
	private pump(): void {
		if (!this.ready || this.closed || this.pumping) return;
		this.pumping = true;
		void (async () => {
			try {
				for (const record of this.records.values()) {
					if (this.closed || this.executions.size >= (this.options.maxConcurrent ?? 1))
						break;
					const runner = this.runners.get(record.kind);
					if (record.state !== "queued" || !runner) continue;
					const execution = this.execute(record, runner);
					this.executions.set(record.id, execution);
					void execution.finally(() => {
						this.executions.delete(record.id);
						this.pump();
					});
				}
			} finally {
				this.pumping = false;
			}
		})();
	}
	private async execute(record: AutomationJobRecord, runner: AutomationJobRunner): Promise<void> {
		const controller = new AbortController();
		this.controllers.set(record.id, controller);
		try {
			record.state = "running";
			record.startedAt = new Date().toISOString();
			record.progress = { phase: "starting" };
			this.touch(record);
			await this.persist(record);
			this.emit();
			if (isJobTerminal(record.state)) return;
			controller.signal.throwIfAborted();
			const mutable = () => !isJobTerminal(record.state);
			const result = await runner({
				jobId: record.id,
				kind: record.kind,
				input: freezeJobJson(cloneJobJson(record.input)),
				...(record.snapshot === undefined
					? {}
					: { snapshot: freezeJobJson(cloneJobJson(record.snapshot)) }),
				signal: controller.signal,
				progress: (progress) => {
					if (!mutable()) return;
					if (
						!progress ||
						typeof progress.phase !== "string" ||
						progress.phase.length > 256 ||
						(progress.percentage !== undefined &&
							(!Number.isFinite(progress.percentage) ||
								progress.percentage < 0 ||
								progress.percentage > 100))
					)
						throw new AutomationError("INVALID_PROGRESS", "Invalid job progress.");
					record.progress = cloneJobJson(
						progress as JobObject,
						128 * 1024,
					) as AutomationJobProgress;
					this.touch(record);
					this.emit();
					if (!this.progressTimers.has(record.id))
						this.progressTimers.set(
							record.id,
							setTimeout(() => {
								this.progressTimers.delete(record.id);
								void this.persist(record).catch(() => undefined);
							}, 250),
						);
				},
				checkpoint: async (checkpoint) => {
					if (!mutable()) return;
					record.checkpoint = cloneJobJson({
						...(record.checkpoint ?? {}),
						...checkpoint,
					});
					this.touch(record);
					await this.persist(record);
					this.emit();
				},
				beginCommit: () => {
					if (controller.signal.aborted || !mutable())
						throw new AutomationError(
							"CANCELLED",
							"Job no longer owns output publication.",
						);
					record.cancellationAllowed = false;
					this.touch(record);
					this.emit();
				},
			});
			if (isJobTerminal(record.state)) return;
			if (controller.signal.aborted) {
				record.state = "cancelled";
				record.progress = { phase: "cancelled" };
			} else {
				record.result = cloneJobJson(result);
				record.state = "succeeded";
				record.progress = { phase: "complete", percentage: 100 };
			}
		} catch (error) {
			if (isJobTerminal(record.state)) return;
			record.state = controller.signal.aborted ? "cancelled" : "failed";
			record.error = toAutomationError(error);
			record.progress = { phase: record.state };
		} finally {
			this.controllers.delete(record.id);
			const timer = this.progressTimers.get(record.id);
			if (timer) clearTimeout(timer);
			this.progressTimers.delete(record.id);
			if (!isJobTerminal(record.state)) record.state = "interrupted";
			record.finishedAt ??= new Date().toISOString();
			record.cancellationAllowed = false;
			this.touch(record);
			try {
				await this.persist(record);
			} catch {
				record.state = "interrupted";
				record.error = {
					code: "JOB_PERSIST_FAILED",
					message:
						"Worker finished but its outcome could not be durably recorded. Inspect any output before retrying.",
				};
			}
			this.emit();
		}
	}
}
