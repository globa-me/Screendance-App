import { AutomationError, type AutomationErrorData } from "./automationErrors";

export { AutomationError, type AutomationErrorData, toAutomationError } from "./automationErrors";

import { validateCommandSchema } from "./automationJsonSchema";
import { EDITOR_AUTOMATION_COMMANDS, validateEditorAutomationCommand } from "./editorAutomation";
import { JOB_AUTOMATION_COMMANDS } from "./jobAutomation";
import {
	isSystemAutomationCommand,
	parseSystemAutomationParams,
	SYSTEM_AUTOMATION_COMMANDS,
} from "./systemAutomation";
/** Versioned command contract shared by the desktop host, CLI and MCP adapter. */
export const AUTOMATION_PROTOCOL_VERSION = 1 as const;
export const AUTOMATION_MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
export const AUTOMATION_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

interface AutomationPropertySchema {
	type: "string" | "number" | "integer" | "boolean";
	description?: string;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	enum?: readonly string[];
}
interface AutomationInputSchema {
	type: "object";
	properties: Record<string, AutomationPropertySchema>;
	required?: readonly string[];
	additionalProperties: false;
}
interface AutomationCommandDefinition {
	name: string;
	description: string;
	readOnly: boolean;
	destructive?: boolean;
	inputSchema: {
		type?: string | readonly string[];
		properties?: Record<string, unknown>;
		[key: string]: unknown;
	};
}
const emptySchema = { type: "object", properties: {}, additionalProperties: false } as const;
const deviceIdSchema = { type: "string", minLength: 1, maxLength: 512 } as const;

export const AUTOMATION_COMMANDS = [
	...EDITOR_AUTOMATION_COMMANDS,
	...JOB_AUTOMATION_COMMANDS,
	...SYSTEM_AUTOMATION_COMMANDS,
	{
		name: "app.status",
		description: "Read application and recording status.",
		readOnly: true,
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "app.capabilities",
		description: "List implemented commands and current automation limits.",
		readOnly: true,
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "project.open",
		description:
			"Open a saved .scrdance or .recordly project. Refuses unsaved edits or active recording/export.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					minLength: 1,
					maxLength: 4096,
					description: "Absolute local project path.",
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	{
		name: "video.open",
		description:
			"Import a local video using the editor's normal defaults and last preset. Refuses unsaved edits or active recording/export.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					minLength: 1,
					maxLength: 4096,
					description: "Absolute local video path.",
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	{
		name: "project.inspect",
		description:
			"Read the live editor document, preferences relevant to export, dirty state and readiness.",
		readOnly: true,
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "preview.render",
		description:
			"Seek the live editor preview to a source time and save its composed preview as PNG. Refuses playback/export; fails rather than overwriting an existing output.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				timeMs: {
					type: "number",
					minimum: 0,
					maximum: Number.MAX_SAFE_INTEGER,
					description: "Source media time in milliseconds (not post-edit output time).",
				},
				outputPath: {
					type: "string",
					minLength: 1,
					maxLength: 4096,
					description: "Absolute path for a new .png file.",
				},
			},
			required: ["timeMs", "outputPath"],
			additionalProperties: false,
		},
	},
	{
		name: "sources.list",
		description: "List available screens and windows for capture with their exact source IDs.",
		readOnly: true,
		inputSchema: emptySchema,
	},
	{
		name: "sources.select",
		description:
			"Select an available capture source by its exact sourceId. Refuses active recording.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				sourceId: {
					...deviceIdSchema,
					description: "Exact capture source ID returned by sources.list.",
				},
			},
			required: ["sourceId"],
			additionalProperties: false,
		},
	},
	{
		name: "devices.list",
		description:
			"List microphone and camera devices and their exact IDs. Available details depend on macOS permissions.",
		readOnly: true,
		inputSchema: emptySchema,
	},
	{
		name: "permissions.status",
		description: "Read macOS screen, accessibility, microphone and camera permission states.",
		readOnly: true,
		inputSchema: emptySchema,
	},
	{
		name: "permissions.request",
		description:
			"Request a macOS permission or open its system settings. The user must grant access in macOS.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				kind: { type: "string", enum: ["screen", "accessibility", "microphone", "camera"] },
			},
			required: ["kind"],
			additionalProperties: false,
		},
	},
	{
		name: "recording.status",
		description: "Read recorder phase, settings and finalization state.",
		readOnly: true,
		inputSchema: emptySchema,
	},
	{
		name: "recording.configure",
		description:
			"Update only supplied recording settings while idle; use devices.list for device IDs. No setting is toggled implicitly.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				microphoneEnabled: { type: "boolean" },
				microphoneDeviceId: deviceIdSchema,
				systemAudioEnabled: { type: "boolean" },
				webcamEnabled: { type: "boolean" },
				webcamDeviceId: deviceIdSchema,
				countdownSeconds: {
					type: "integer",
					minimum: 0,
					maximum: 10,
					description: "Recording countdown in seconds (0 disables the countdown).",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "recording.start",
		description:
			"Start recording the selected source using the configured audio, camera and countdown settings. Refuses if already recording.",
		readOnly: false,
		inputSchema: emptySchema,
	},
	{
		name: "recording.pause",
		description: "Pause an active recording. Refuses when the recorder is not recording.",
		readOnly: false,
		inputSchema: emptySchema,
	},
	{
		name: "recording.resume",
		description: "Resume a paused recording. Refuses when the recorder is not paused.",
		readOnly: false,
		inputSchema: emptySchema,
	},
	{
		name: "recording.adjust",
		description:
			"macOS, paused only: switch the capture source and/or turn the microphone or webcam on, off or to another device without ending the take. A new source is letterboxed into the original frame. Resume afterwards.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				sourceId: {
					...deviceIdSchema,
					description: "Exact capture source ID returned by sources.list.",
				},
				microphoneEnabled: { type: "boolean" },
				microphoneDeviceId: deviceIdSchema,
				webcamEnabled: { type: "boolean" },
				webcamDeviceId: deviceIdSchema,
			},
			additionalProperties: false,
		},
	},
	{
		name: "recording.stop",
		description:
			"Stop the recording and wait for audio, webcam and cursor finalization before returning the recording result. This can take time.",
		readOnly: false,
		inputSchema: emptySchema,
	},
	{
		name: "recording.cancel",
		description:
			"Cancel the active recording and discard its current take. This action loses the unsaved recording.",
		readOnly: false,
		destructive: true,
		inputSchema: emptySchema,
	},
	{
		name: "recording.recover",
		description:
			"Attempt recovery of a recoverable recording after a failed recording or finalization.",
		readOnly: false,
		inputSchema: emptySchema,
	},
	{
		name: "project.list",
		description: "List saved projects from the application's project library.",
		readOnly: true,
		inputSchema: emptySchema,
	},
	{
		name: "project.save",
		description:
			"Save the live project to its current path, or Save As to an explicit .scrdance/.recordly path. A different existing file requires overwrite=true.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					minLength: 1,
					maxLength: 4096,
					description:
						"Optional absolute Save As path. Omit to save the current project.",
				},
				overwrite: {
					type: "boolean",
					description:
						"Explicit permission to replace a different existing project file (default false).",
				},
			},
			additionalProperties: false,
		},
	},
] as const satisfies readonly AutomationCommandDefinition[];

export type AutomationCommand = (typeof AUTOMATION_COMMANDS)[number]["name"];
export type AutomationParams = Record<string, unknown>;

export interface AutomationRequest {
	id: string;
	method: AutomationCommand;
	params: AutomationParams;
}

export type AutomationResponse =
	| { id: string; result: unknown; error?: never }
	| { id: string; error: AutomationErrorData; result?: never };

export interface AutomationEndpoint {
	protocolVersion: typeof AUTOMATION_PROTOCOL_VERSION;
	socketPath: string;
	token: string;
	pid: number;
}

/** Strict external validation; persistence normalizers must not replace this. */
export function validateAutomationRequest(value: unknown): AutomationRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AutomationError("INVALID_REQUEST", "Expected a command object.");
	}
	const request = value as Record<string, unknown>;
	if (typeof request.id !== "string" || !request.id || request.id.length > 128) {
		throw new AutomationError(
			"INVALID_REQUEST",
			"A nonempty request id of at most 128 characters is required.",
		);
	}
	const command = AUTOMATION_COMMANDS.find((item) => item.name === request.method);
	if (!command) throw new AutomationError("UNKNOWN_COMMAND", "Unknown automation command.");
	const params = request.params === undefined ? {} : request.params;
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new AutomationError("INVALID_PARAMS", "params must be an object.");
	}
	if (EDITOR_AUTOMATION_COMMANDS.some((item) => item.name === command.name))
		return {
			id: request.id,
			method: command.name,
			params: validateEditorAutomationCommand(command.name, params),
		};
	if (isSystemAutomationCommand(command.name)) {
		try {
			return {
				id: request.id,
				method: command.name,
				params: parseSystemAutomationParams(command.name, params),
			};
		} catch (error) {
			throw new AutomationError("INVALID_PARAMS", "System command parameters are invalid.", {
				issues:
					error && typeof error === "object" && "issues" in error
						? error.issues
						: undefined,
			});
		}
	}
	if (JOB_AUTOMATION_COMMANDS.some((item) => item.name === command.name)) {
		const error = validateCommandSchema(
			params,
			command.inputSchema as unknown as Record<string, unknown>,
		);
		if (error) throw new AutomationError("INVALID_PARAMS", error);
		return { id: request.id, method: command.name, params: { ...params } };
	}

	const data = params as AutomationParams;
	const schema = command.inputSchema as unknown as AutomationInputSchema;
	if (Object.keys(data).some((key) => !Object.keys(schema.properties).includes(key))) {
		throw new AutomationError("INVALID_PARAMS", `Unexpected parameters for ${command.name}.`);
	}
	for (const key of schema.required ?? []) {
		if (!Object.keys(data).includes(key)) {
			throw new AutomationError("INVALID_PARAMS", `${key} is required for ${command.name}.`);
		}
	}
	for (const [key, value] of Object.entries(data)) {
		const property = schema.properties[key];
		let valid = false;
		if (property.type === "string") {
			valid =
				typeof value === "string" &&
				!!value.trim() &&
				!value.includes("\0") &&
				value.length >= (property.minLength ?? 1) &&
				value.length <= (property.maxLength ?? 4096) &&
				(!property.enum || property.enum.includes(value));
		} else if (property.type === "boolean") valid = typeof value === "boolean";
		else if (property.type === "number" || property.type === "integer") {
			valid =
				typeof value === "number" &&
				Number.isFinite(value) &&
				(property.type !== "integer" || Number.isSafeInteger(value)) &&
				value >= (property.minimum ?? -Number.MAX_SAFE_INTEGER) &&
				value <= (property.maximum ?? Number.MAX_SAFE_INTEGER);
		}
		if (!valid)
			throw new AutomationError(
				"INVALID_PARAMS",
				`Invalid ${key} for ${command.name}; expected ${property.type}${property.enum ? ` (${property.enum.join(", ")})` : ""}.`,
			);
	}
	return { id: request.id, method: command.name, params: { ...data } };
}
