import { AutomationError, type AutomationErrorData } from "./automationErrors";

export type AutomationJobKind = "export" | "export.save" | "captions.generate" | "models.download";
export type AutomationJobState =
	| "queued"
	| "running"
	| "cancelling"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "interrupted";
export type JobJson = null | boolean | number | string | JobJson[] | { [key: string]: JobJson };
export type JobObject = { [key: string]: JobJson };
export interface AutomationJobProgress {
	phase: string;
	percentage?: number;
	message?: string;
	[key: string]: JobJson | undefined;
}
export interface AutomationJobRecord {
	version: 1;
	id: string;
	kind: AutomationJobKind;
	state: AutomationJobState;
	revision: number;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	finishedAt?: string;
	cancelRequestedAt?: string;
	cancellationAllowed: boolean;
	retryOf?: string;
	input: JobObject;
	snapshot?: JobJson;
	progress: AutomationJobProgress;
	checkpoint?: JobObject;
	result?: JobJson;
	error?: AutomationErrorData;
}
export type AutomationJobView = Omit<AutomationJobRecord, "input" | "snapshot"> & {
	terminal: boolean;
};
export const JOB_TERMINAL_STATES: readonly AutomationJobState[] = [
	"succeeded",
	"failed",
	"cancelled",
	"interrupted",
];
export const JOB_KINDS: readonly AutomationJobKind[] = [
	"export",
	"export.save",
	"captions.generate",
	"models.download",
];
export function isJobTerminal(state: AutomationJobState): boolean {
	return JOB_TERMINAL_STATES.includes(state);
}

/** Bounded data-only snapshots. Reject values JSON would silently discard or coerce. */
export function cloneJobJson<T extends JobJson>(value: T, maximumBytes = 32 * 1024 * 1024): T {
	let nodes = 0;
	function validate(item: unknown, depth: number): void {
		if (++nodes > 500_000 || depth > 48)
			throw new AutomationError("INVALID_PARAMS", "Job data exceeds the structure limit.");
		if (item === null || typeof item === "string" || typeof item === "boolean") return;
		if (typeof item === "number" && Number.isFinite(item)) return;
		if (Array.isArray(item)) {
			for (const child of item) validate(child, depth + 1);
			return;
		}
		if (
			item &&
			typeof item === "object" &&
			(Object.getPrototypeOf(item) === Object.prototype ||
				Object.getPrototypeOf(item) === null)
		) {
			for (const [key, child] of Object.entries(item)) {
				if (["__proto__", "constructor", "prototype"].includes(key))
					throw new AutomationError("INVALID_PARAMS", "Unsafe job data key.");
				validate(child, depth + 1);
			}
			return;
		}
		throw new AutomationError("INVALID_PARAMS", "Jobs require finite, serializable JSON data.");
	}
	validate(value, 0);
	const encoded = JSON.stringify(value);
	if (new TextEncoder().encode(encoded).byteLength > maximumBytes)
		throw new AutomationError("INVALID_PARAMS", "Job data exceeds the byte limit.");
	return JSON.parse(encoded) as T;
}
export function freezeJobJson<T extends JobJson>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeJobJson(child);
		Object.freeze(value);
	}
	return value;
}

const empty = { type: "object", properties: {}, additionalProperties: false } as const;
const id = { type: "string", minLength: 1, maxLength: 128 } as const;
const path = { type: "string", minLength: 1, maxLength: 4096 } as const;
const settings = {
	type: "object",
	additionalProperties: false,
	properties: {
		format: { type: "string", enum: ["mp4", "gif"] },
		quality: { type: "string", enum: ["medium", "good", "high", "source"] },
		encodingMode: { type: "string", enum: ["fast", "balanced", "quality"] },
		mp4FrameRate: { type: "integer", enum: [24, 30, 60] },
		backendPreference: { type: "string", enum: ["auto", "webcodecs", "breeze"] },
		pipelineModel: { type: "string", enum: ["modern", "legacy"] },
		transparentBackground: { type: "boolean" },
		alphaSafeCanvas: { type: "boolean" },
		alphaSafeCanvasScale: { type: "number", minimum: 1.25, maximum: 2.5 },
		alphaFormat: { type: "string", enum: ["mov", "webm"] },
		gifConfig: {
			type: "object",
			additionalProperties: false,
			properties: {
				frameRate: { type: "integer", enum: [15, 20, 25, 30] },
				loop: { type: "boolean" },
				sizePreset: { type: "string", enum: ["medium", "large", "original"] },
				width: { type: "integer", minimum: 1, maximum: 16384 },
				height: { type: "integer", minimum: 1, maximum: 16384 },
			},
			required: ["frameRate", "loop", "sizePreset", "width", "height"],
		},
	},
} as const;
export const JOB_AUTOMATION_COMMANDS = [
	{
		name: "export.start",
		description:
			"Freeze the current document and export settings and start a durable export job to an explicit output path. No save dialog; existing output requires overwrite=true.",
		readOnly: false,
		destructive: true,
		inputSchema: {
			type: "object",
			properties: {
				outputPath: path,
				overwrite: { type: "boolean" },
				expectedRevision: { type: "integer", minimum: 0 },
				settings,
			},
			required: ["outputPath"],
			additionalProperties: false,
		},
	},
	{
		name: "export.save",
		description:
			"Save the retained completed output of an export job to a new explicit path without rendering again.",
		readOnly: false,
		destructive: true,
		inputSchema: {
			type: "object",
			properties: { jobId: id, outputPath: path, overwrite: { type: "boolean" } },
			required: ["jobId", "outputPath"],
			additionalProperties: false,
		},
	},
	{
		name: "captions.generate",
		description:
			"Generate caption cues for the current frozen source using the installed Whisper runtime and selected model. Returns a durable job; application must guard document revision before applying cues.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				language: { type: "string", minLength: 1, maxLength: 64 },
				modelPath: path,
				executablePath: path,
				apply: { type: "boolean" },
				expectedRevision: { type: "integer", minimum: 0 },
			},
			additionalProperties: false,
		},
	},
	{
		name: "models.list",
		description:
			"List supported managed Whisper models and installed status without downloading or acquiring microphone/camera.",
		readOnly: true,
		inputSchema: empty,
	},
	{
		name: "models.download",
		description:
			"Download the supported managed Whisper small model as a cancellable durable job.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: { modelId: { type: "string", enum: ["small"] } },
			additionalProperties: false,
		},
	},
	{
		name: "models.delete",
		description:
			"Delete only the application's managed Whisper small model. Refuses active model jobs.",
		readOnly: false,
		destructive: true,
		inputSchema: {
			type: "object",
			properties: { modelId: { type: "string", enum: ["small"] } },
			additionalProperties: false,
		},
	},
	{
		name: "jobs.list",
		description: "List application-owned jobs; ending an MCP session does not cancel them.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				limit: { type: "integer", minimum: 1, maximum: 1000 },
				state: {
					type: "string",
					enum: [
						"queued",
						"running",
						"cancelling",
						"succeeded",
						"failed",
						"cancelled",
						"interrupted",
					],
				},
				kind: { type: "string", enum: JOB_KINDS },
			},
			additionalProperties: false,
		},
	},
	{
		name: "jobs.get",
		description: "Read a durable job, progress and its terminal result or structured error.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: { jobId: id },
			required: ["jobId"],
			additionalProperties: false,
		},
	},
	{
		name: "jobs.wait",
		description:
			"Wait for a job change or terminal result for up to 60 seconds. A wait timeout leaves the job running.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				jobId: id,
				timeoutMs: { type: "integer", minimum: 0, maximum: 60000 },
				afterRevision: { type: "integer", minimum: 0 },
			},
			required: ["jobId"],
			additionalProperties: false,
		},
	},
	{
		name: "jobs.cancel",
		description:
			"Request cancellation. A running job remains cancelling until its worker actually stops; publication already in progress cannot be cancelled.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: { jobId: id },
			required: ["jobId"],
			additionalProperties: false,
		},
	},
	{
		name: "jobs.retry",
		description:
			"Create a new job from an interrupted, failed or cancelled job using its persisted frozen snapshot. Never silently repeat a successful output publication.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: { jobId: id, outputPath: path, overwrite: { type: "boolean" } },
			required: ["jobId"],
			additionalProperties: false,
		},
	},
] as const;

export type RendererAutomationJobKind = "export" | "export.save" | "captions.generate";
export type AutomationJobRendererRequest =
	| { action: "capture"; requestId: string; kind: RendererAutomationJobKind; input: JobObject }
	| {
			action: "run";
			jobId: string;
			kind: RendererAutomationJobKind;
			input: JobObject;
			snapshot: JobJson;
	  }
	| { action: "cancel"; jobId: string };
export type AutomationJobRendererEvent =
	| { type: "captured"; requestId: string; snapshot: JobJson }
	| { type: "capture-error"; requestId: string; error: AutomationErrorData }
	| { type: "progress"; jobId: string; progress: AutomationJobProgress }
	| { type: "checkpoint"; jobId: string; checkpoint: JobObject }
	| { type: "committing"; jobId: string }
	| { type: "complete"; jobId: string; result: JobJson }
	| { type: "error" | "interrupted"; jobId: string; error: AutomationErrorData };
