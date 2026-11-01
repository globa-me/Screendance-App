import { z } from "zod";
import type { ProjectEditorState } from "../src/components/video-editor/projectPersistence";
import { AutomationError } from "./automationErrors";

const n = (min: number, max = Number.MAX_SAFE_INTEGER) => z.number().finite().min(min).max(max);
const ms = n(0).int();
const text = z.string().max(100_000);
const imageData = z
	.string()
	.max(8 * 1024 * 1024)
	.regex(/^data:image\/(?:png|jpeg|webp|gif|avif|svg\+xml|bmp);base64,[A-Za-z0-9+/]*={0,2}$/i);
const name = z
	.string()
	.min(1)
	.max(1000)
	.refine(
		(value) => !["__proto__", "constructor", "prototype"].includes(value),
		"Reserved identifier",
	);
const path = z
	.string()
	.min(1)
	.max(16_384)
	.refine((value) => !value.includes("\0"), "Paths must not contain NUL");
const asset = z.union([
	imageData,
	path.refine(
		(value) =>
			!value.split(/[\\/]/).includes("..") &&
			!/^[a-z][a-z0-9+.-]*:/i.test(value.replace(/^file:\/\/\//, "/")) &&
			!/url\s*\(/i.test(value),
		"Use approved local assets, catalog IDs, colors/gradients or image data URLs",
	),
]);
const focus = z.object({ cx: n(0, 1), cy: n(0, 1) }).strict();
const crop = z.object({ x: n(0, 1), y: n(0, 1), width: n(0.01, 1), height: n(0.01, 1) }).strict();
const padding = z
	.object({
		top: n(0, 100),
		right: n(0, 100),
		bottom: n(0, 100),
		left: n(0, 100),
		linked: z.boolean().optional(),
	})
	.strict();
const easing = z.enum(["recordly", "glide", "smooth", "snappy", "linear"]);
const trackSetting = z.object({ volume: n(0, 1), normalize: z.boolean() }).strict();
const trackSettings = z.record(name, trackSetting);
const captionSettings = z
	.object({
		enabled: z.boolean(),
		language: name,
		fontFamily: name,
		fontSize: n(16, 72),
		bottomOffset: n(0, 30),
		maxWidth: n(40, 95),
		maxRows: n(1, 4).int(),
		animationStyle: z.enum(["none", "fade", "rise", "pop"]),
		boxRadius: n(0, 40),
		textColor: name,
		inactiveTextColor: name,
		backgroundOpacity: n(0, 1),
	})
	.strict();
const webcam = z
	.object({
		enabled: z.boolean(),
		sourcePath: path
			.refine(
				(value) => value.startsWith("/") || value.startsWith("file:///"),
				"Use an absolute local path",
			)
			.nullable(),
		timeOffsetMs: z.number().finite().int(),
		mirror: z.boolean(),
		cropRegion: crop,
		corner: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]),
		positionPreset: z.enum([
			"top-left",
			"top-right",
			"bottom-left",
			"bottom-right",
			"top-center",
			"center-left",
			"center",
			"center-right",
			"bottom-center",
			"custom",
		]),
		positionX: n(0, 1),
		positionY: n(0, 1),
		size: n(10, 100),
		reactToZoom: z.boolean(),
		cornerRadius: n(0, 160),
		shadow: n(0, 1),
		margin: n(0, 96),
	})
	.strict();
const blurTuning = z
	.object({
		panVelocityThreshold: n(0),
		zoomVelocityThreshold: n(0),
		maxDirectionalBlurPx: n(0, 100),
		maxRadialBlurStrength: n(0, 1.5),
		panResponsePerSecond: n(1, 30),
		zoomResponsePerSecond: n(1, 30),
		zoomSafeZoneRadiusPx: n(0, 80),
	})
	.strict();
const span = { id: name, startMs: ms, endMs: ms };
const annotationStyle = z
	.object({
		color: name,
		backgroundColor: name,
		fontSize: n(1, 1000),
		fontFamily: name,
		fontWeight: z.enum(["normal", "bold"]),
		fontStyle: z.enum(["normal", "italic"]),
		textDecoration: z.enum(["none", "underline"]),
		textAlign: z.enum(["left", "center", "right"]),
		borderRadius: n(0, 1000),
	})
	.strict();
export const EDITOR_COLLECTION_SCHEMAS = {
	zoomRegions: z
		.object({
			...span,
			depth: n(1, 6).int(),
			focus,
			mode: z.enum(["auto", "manual"]).optional(),
		})
		.strict(),
	clipRegions: z
		.object({
			...span,
			speed: n(0.05, 16),
			muted: z.boolean().optional(),
			showSourceAudio: z.boolean().optional(),
		})
		.strict(),
	trimRegions: z.object(span).strict(),
	speedRegions: z
		.object({
			...span,
			speed: z.union([
				z.literal(0.25),
				z.literal(0.5),
				z.literal(0.75),
				z.literal(1.25),
				z.literal(1.5),
				z.literal(1.75),
				z.literal(2),
			]),
		})
		.strict(),
	annotationRegions: z
		.object({
			...span,
			type: z.enum(["text", "image", "figure", "blur", "highlight"]),
			content: z.union([text, imageData]),
			textContent: text.optional(),
			imageContent: asset.optional(),
			position: z.object({ x: n(0, 100), y: n(0, 100) }).strict(),
			size: z.object({ width: n(1, 200), height: n(1, 200) }).strict(),
			style: annotationStyle,
			zIndex: n(0).int(),
			trackIndex: n(0).int().optional(),
			figureData: z
				.object({
					arrowDirection: z.enum([
						"up",
						"down",
						"left",
						"right",
						"up-right",
						"up-left",
						"down-right",
						"down-left",
					]),
					color: name,
					strokeWidth: n(0, 100),
				})
				.strict()
				.optional(),
			highlightData: z
				.object({
					shape: z.enum(["rectangle", "ellipse", "marker"]),
					color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
					strokeWidth: n(1, 40),
					fillOpacity: n(0, 1),
				})
				.strict()
				.optional(),
			blurIntensity: n(0, 100).optional(),
			blurColor: name.optional(),
		})
		.strict(),
	audioRegions: z
		.object({
			...span,
			audioPath: path.refine(
				(value) => value.startsWith("/") || value.startsWith("file:///"),
				"Use an absolute local path",
			),
			volume: n(0, 1),
			normalize: z.boolean().optional(),
			trackIndex: n(0).int().optional(),
		})
		.strict(),
	autoCaptions: z
		.object({
			...span,
			text: z.string().min(1).max(100_000),
			words: z
				.array(
					z
						.object({
							text: z.string().min(1).max(10_000),
							startMs: ms,
							endMs: ms,
							leadingSpace: z.boolean().optional(),
						})
						.strict(),
				)
				.max(10000)
				.optional(),
		})
		.strict(),
} as const;
export type EditorCollection = keyof typeof EDITOR_COLLECTION_SCHEMAS;

export const editorSettingsSchema = z
	.object({
		wallpaper: asset,
		shadowIntensity: n(0, 2),
		backgroundBlur: n(0, 8),
		zoomMotionBlur: n(0, 2),
		zoomMotionBlurTuning: blurTuning,
		zoomTemporalMotionBlur: n(0, 2),
		zoomMotionBlurSampleCount: n(3, 61)
			.int()
			.refine((value) => value % 2 === 1, "Sample count must be odd")
			.nullable(),
		zoomMotionBlurShutterFraction: n(0.18, 3).nullable(),
		connectZooms: z.boolean(),
		zoomInDurationMs: n(60, 4000),
		zoomInOverlapMs: n(0, 4000),
		zoomOutDurationMs: n(60, 4000),
		connectedZoomGapMs: n(0, 5000),
		connectedZoomDurationMs: n(60, 4000),
		zoomInEasing: easing,
		zoomOutEasing: easing,
		connectedZoomEasing: easing,
		showCursor: z.boolean(),
		loopCursor: z.boolean(),
		cursorStyle: name,
		cursorSize: n(0.5, 10),
		cursorSmoothing: n(0, 2),
		cursorSpringStiffnessMultiplier: n(0.25, 3),
		cursorSpringDampingMultiplier: n(0.25, 3),
		cursorSpringMassMultiplier: n(0.25, 3),
		cameraSpringStiffnessMultiplier: n(0.25, 3),
		cameraSpringDampingMultiplier: n(0.25, 3),
		cameraSpringMassMultiplier: n(0.25, 3),
		zoomSmoothness: n(0, 1),
		zoomClassicMode: z.boolean(),
		cursorMotionBlur: n(0, 2),
		cursorClickBounce: n(0, 5),
		cursorClickBounceDuration: n(60, 500),
		cursorSway: n(0, 2),
		borderRadius: n(0, 1000),
		padding,
		frame: name.nullable(),
		cropRegion: crop,
		webcam,
		autoCaptionSettings: captionSettings,
		aspectRatio: z.string().regex(/^(native|[1-9]\d*:[1-9]\d*)$/),
		sourceAudioTrackSettingsByClip: z.record(name, trackSettings),
		defaultSourceAudioTrackSettings: trackSettings,
		exportEncodingMode: z.enum(["fast", "balanced", "quality"]),
		exportBackendPreference: z.enum(["auto", "webcodecs", "breeze"]),
		exportPipelineModel: z.enum(["modern", "legacy"]),
		exportQuality: z.enum(["medium", "good", "high", "source"]),
		mp4FrameRate: z.union([z.literal(24), z.literal(30), z.literal(60)]),
		exportFormat: z.enum(["mp4", "gif"]),
		gifFrameRate: z.union([z.literal(15), z.literal(20), z.literal(25), z.literal(30)]),
		gifLoop: z.boolean(),
		gifSizePreset: z.enum(["medium", "large", "original"]),
	})
	.strict();
export const exportPreferencesSchema = z
	.object({
		exportTransparentBackground: z.boolean(),
		exportAlphaSafeCanvas: z.boolean(),
		exportAlphaSafeCanvasScale: n(1.25, 2.5),
		exportAlphaFormat: z.enum(["mov", "webm"]),
	})
	.strict();
export const creationPreferencesSchema = z
	.object({
		autoApplyFreshRecordingAutoZooms: z.boolean(),
		defaultZoomDurationMs: n(1, 3600000).int(),
		defaultZoomMode: z.enum(["auto", "manual"]),
		lastManualZoomFocus: focus,
	})
	.strict();
export interface EditorDocumentSnapshot {
	editor: ProjectEditorState;
	exportPreferences: z.infer<typeof exportPreferencesSchema>;
	creationPreferences: z.infer<typeof creationPreferencesSchema>;
}

// Nested settings patches merge named structures; arrays have explicit collection operations.
const settingsPatch = editorSettingsSchema
	.partial()
	.extend({
		webcam: webcam
			.partial()
			.extend({ cropRegion: crop.partial().optional() })
			.strict()
			.optional(),
		padding: padding.partial().optional(),
		cropRegion: crop.partial().optional(),
		autoCaptionSettings: captionSettings.partial().optional(),
		zoomMotionBlurTuning: blurTuning.partial().optional(),
	})
	.strict();
const operations: z.ZodType[] = [
	z.object({ op: z.literal("settings.patch"), values: settingsPatch }).strict(),
	z.object({ op: z.literal("export.patch"), values: exportPreferencesSchema.partial() }).strict(),
	z
		.object({ op: z.literal("creation.patch"), values: creationPreferencesSchema.partial() })
		.strict(),
	z
		.object({ op: z.literal("clips.split"), id: name, atMs: ms, leftId: name, rightId: name })
		.strict(),
	z.object({ op: z.literal("clips.speed"), id: name, speed: n(0.05, 16) }).strict(),
];
for (const [collection, schema] of Object.entries(EDITOR_COLLECTION_SCHEMAS)) {
	let changes = (schema as z.ZodObject).omit({ id: true }).partial();
	if (collection === "zoomRegions")
		changes = changes.extend({ focus: focus.partial().optional() });
	if (collection === "annotationRegions")
		changes = changes.extend({
			position: EDITOR_COLLECTION_SCHEMAS.annotationRegions.shape.position
				.partial()
				.optional(),
			size: EDITOR_COLLECTION_SCHEMAS.annotationRegions.shape.size.partial().optional(),
			style: annotationStyle.partial().optional(),
			figureData: EDITOR_COLLECTION_SCHEMAS.annotationRegions.shape.figureData
				.unwrap()
				.partial()
				.optional(),
		});
	operations.push(
		z
			.object({
				op: z.literal("region.create"),
				collection: z.literal(collection),
				value: schema,
			})
			.strict(),
	);
	operations.push(
		z
			.object({
				op: z.literal("region.update"),
				collection: z.literal(collection),
				id: name,
				changes,
			})
			.strict(),
	);
	operations.push(
		z
			.object({ op: z.literal("region.delete"), collection: z.literal(collection), id: name })
			.strict(),
	);
	operations.push(
		z
			.object({
				op: z.literal("collection.replace"),
				collection: z.literal(collection),
				values: z.array(schema).max(10000),
			})
			.strict(),
	);
	operations.push(
		z
			.object({
				op: z.literal("collection.reorder"),
				collection: z.literal(collection),
				ids: z.array(name).max(10000),
			})
			.strict(),
	);
}
export const editorOperationSchema = z.union(operations as [z.ZodType, z.ZodType, ...z.ZodType[]]);
export interface EditorApplyParams {
	expectedRevision: number;
	expectedDocumentId?: string;
	operations: Array<Record<string, unknown>>;
}
const revision = n(0).int();
const documentId = z.string().min(1).max(256);
const schemas = {
	"editor.get": z
		.object({
			includeTelemetry: z.boolean().optional(),
			telemetryStartMs: ms.optional(),
			telemetryEndMs: ms.optional(),
			telemetryLimit: n(1, 10000).int().optional(),
		})
		.strict(),
	"editor.apply": z
		.object({
			expectedRevision: revision,
			expectedDocumentId: documentId.optional(),
			operations: z.array(editorOperationSchema).min(1).max(500),
		})
		.strict(),
	"editor.undo": z
		.object({ expectedRevision: revision, expectedDocumentId: documentId.optional() })
		.strict(),
	"editor.redo": z
		.object({ expectedRevision: revision, expectedDocumentId: documentId.optional() })
		.strict(),
	"editor.catalogs": z.object({}).strict(),
	"editor.presets": z.union([
		z.object({ action: z.literal("list") }).strict(),
		z.object({ action: z.literal("get"), id: name }).strict(),
		z
			.object({
				action: z.literal("save"),
				name: z.string().min(1).max(200),
				expectedRevision: revision,
				expectedDocumentId: documentId.optional(),
			})
			.strict(),
		z
			.object({
				action: z.literal("apply"),
				id: name,
				expectedRevision: revision,
				expectedDocumentId: documentId.optional(),
			})
			.strict(),
		z.object({ action: z.literal("delete"), id: name }).strict(),
	]),
	"editor.autoZoom": z
		.object({
			expectedRevision: revision,
			expectedDocumentId: documentId.optional(),
			replace: z.boolean().optional(),
		})
		.strict(),
	"preview.control": z
		.object({
			action: z.enum(["status", "play", "pause", "seek", "configure", "select"]),
			timeMs: ms.optional(),
			volume: n(0, 1).optional(),
			zoom: n(0.1, 4).optional(),
			collection: z
				.enum(["zoomRegions", "clipRegions", "annotationRegions", "audioRegions"])
				.optional(),
			id: name.nullable().optional(),
		})
		.strict()
		.superRefine((params, context) => {
			const allowed: Record<string, string[]> = {
				status: [],
				play: [],
				pause: [],
				seek: ["timeMs"],
				configure: ["volume", "zoom"],
				select: ["collection", "id"],
			};
			for (const key of Object.keys(params))
				if (key !== "action" && !allowed[params.action].includes(key))
					context.addIssue({
						code: "custom",
						path: [key],
						message: `Field is not supported for ${params.action}.`,
					});
			const required =
				params.action === "seek"
					? ["timeMs"]
					: params.action === "select"
						? ["collection", "id"]
						: [];
			for (const key of required)
				if (!(key in params))
					context.addIssue({
						code: "custom",
						path: [key],
						message: "Required for this action.",
					});
		}),
} as const;
export const EDITOR_AUTOMATION_COMMANDS = Object.entries(schemas).map(([command, schema]) => {
	const json = z.toJSONSchema(schema, { unrepresentable: "any" });
	// Expose union fields at the root for CLI flag discovery while retaining action-specific anyOf validation.
	const properties =
		command === "editor.presets"
			? (z.toJSONSchema(
					z.object({
						action: z.enum(["list", "get", "save", "apply", "delete"]),
						id: name.optional(),
						name: z.string().min(1).max(200).optional(),
						expectedRevision: revision.optional(),
						expectedDocumentId: documentId.optional(),
					}),
				).properties ?? {})
			: (json.properties ?? {});
	return {
		name: command as keyof typeof schemas,
		description:
			command === "editor.apply"
				? "Atomically apply typed persisted-document edits at expectedRevision. All time fields are integer milliseconds in the existing editor coordinates; clip.endMs is a display-span endpoint and source end=start+(end-start)*speed. Focus/crop use 0–1, annotations and padding use percent. Read editor.get for exact field values."
				: `${command}: shared editor document/preview operation. Mutation revisions include manual UI edits.`,
		readOnly: command === "editor.get" || command === "editor.catalogs",
		inputSchema: { ...json, type: "object" as const, properties, additionalProperties: false },
	};
});

export function validateEditorAutomationCommand(
	method: string,
	params: unknown,
): Record<string, unknown> {
	const schema = schemas[method as keyof typeof schemas];
	if (!schema) throw new AutomationError("UNKNOWN_COMMAND", "Unknown editor command.");
	const result = schema.safeParse(params);
	if (!result.success)
		throw new AutomationError("INVALID_PARAMS", "Editor command parameters are invalid.", {
			issues: result.error.issues,
		});
	return result.data as Record<string, unknown>;
}

export function collectEditorAutomationMediaPaths(params: unknown): string[] {
	const found = new Set<string>();
	function visit(value: unknown, key = "", parent?: Record<string, unknown>) {
		if (
			typeof value === "string" &&
			["sourcePath", "audioPath", "wallpaper", "imageContent", "content"].includes(key)
		) {
			if (key === "content" && parent?.type !== "image") return;
			if (value.startsWith("file://")) {
				try {
					found.add(decodeURIComponent(new URL(value).pathname));
				} catch {
					throw new AutomationError("INVALID_PARAMS", "Invalid file URL.");
				}
			} else if (value.startsWith("/") && !/^\/wallpapers\/[A-Za-z0-9._-]+$/.test(value))
				found.add(value);
		} else if (Array.isArray(value)) value.forEach((item) => visit(item));
		else if (value && typeof value === "object")
			for (const [childKey, child] of Object.entries(value))
				visit(child, childKey, value as Record<string, unknown>);
	}
	visit(params);
	return [...found];
}
