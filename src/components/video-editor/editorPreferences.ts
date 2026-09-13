import { loadAppSetting, saveAppSetting } from "../../lib/appSettings";
import { DEFAULT_ALPHA_SAFE_CANVAS_SCALE, normalizeAlphaSafeCanvasScale } from "./exportDimensions";
import {
	DEFAULT_MANUAL_ZOOM_FOCUS,
	DEFAULT_NEW_ZOOM_DURATION_MS,
	DEFAULT_NEW_ZOOM_MODE,
	type ZoomFocus,
	type ZoomMode,
} from "./types";
import {
	normalizeExportBackendPreference,
	normalizeExportMp4FrameRate,
	normalizeExportPipelineModel,
	normalizeProjectEditor,
	type ProjectEditorState,
	stripPersistedDevMotionBlurSettings,
} from "./projectPersistence";

type PersistedProjectEditorControls = Pick<
	ProjectEditorState,
	| "wallpaper"
	| "shadowIntensity"
	| "backgroundBlur"
	| "zoomMotionBlur"
	| "zoomMotionBlurTuning"
	| "zoomTemporalMotionBlur"
	| "zoomMotionBlurSampleCount"
	| "zoomMotionBlurShutterFraction"
	| "connectZooms"
	| "zoomInDurationMs"
	| "zoomInOverlapMs"
	| "zoomOutDurationMs"
	| "connectedZoomGapMs"
	| "connectedZoomDurationMs"
	| "zoomInEasing"
	| "zoomOutEasing"
	| "connectedZoomEasing"
	| "showCursor"
	| "loopCursor"
	| "cursorStyle"
	| "cursorSize"
	| "cursorSmoothing"
	| "cursorSpringStiffnessMultiplier"
	| "cursorSpringDampingMultiplier"
	| "cursorSpringMassMultiplier"
	| "cameraSpringStiffnessMultiplier"
	| "cameraSpringDampingMultiplier"
	| "cameraSpringMassMultiplier"
	| "zoomSmoothness"
	| "zoomClassicMode"
	| "cursorMotionBlur"
	| "cursorClickBounce"
	| "cursorClickBounceDuration"
	| "cursorSway"
	| "borderRadius"
	| "padding"
	| "frame"
	| "webcam"
	| "aspectRatio"
	| "exportEncodingMode"
	| "exportBackendPreference"
	| "exportPipelineModel"
	| "exportQuality"
	| "mp4FrameRate"
	| "exportFormat"
	| "gifFrameRate"
	| "gifLoop"
	| "gifSizePreset"
>;

type PersistedAlphaExportControls = {
	exportTransparentBackground: boolean;
	exportAlphaSafeCanvas: boolean;
	exportAlphaSafeCanvasScale: number;
	exportAlphaFormat: "mov" | "webm";
};

type PersistedEditorControls = PersistedProjectEditorControls & PersistedAlphaExportControls;

type PartialEditorControls = Partial<PersistedEditorControls>;

type PresetAutoCaptionSettings = ProjectEditorState["autoCaptionSettings"];

export interface EditorPresetSnapshot extends PersistedEditorControls {
	autoCaptionSettings: PresetAutoCaptionSettings;
	whisperExecutablePath: string | null;
	whisperModelPath: string | null;
}

export interface EditorPreset {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	snapshot: EditorPresetSnapshot;
}

export interface EditorPreferences extends PersistedEditorControls {
	customAspectWidth: string;
	customAspectHeight: string;
	customWallpapers: string[];
	autoApplyFreshRecordingAutoZooms: boolean;
	defaultZoomDurationMs: number;
	defaultZoomMode: ZoomMode;
	lastManualZoomFocus: ZoomFocus;
	whisperExecutablePath: string | null;
	whisperModelPath: string | null;
}

export const EDITOR_PREFERENCES_STORAGE_KEY = "recordly.editor.preferences";
export const EDITOR_PRESETS_STORAGE_KEY = "recordly.editor.presets";

const DEFAULT_EDITOR_CONTROLS = normalizeProjectEditor({});

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
	wallpaper: DEFAULT_EDITOR_CONTROLS.wallpaper,
	shadowIntensity: DEFAULT_EDITOR_CONTROLS.shadowIntensity,
	backgroundBlur: DEFAULT_EDITOR_CONTROLS.backgroundBlur,
	zoomMotionBlur: DEFAULT_EDITOR_CONTROLS.zoomMotionBlur,
	zoomMotionBlurTuning: DEFAULT_EDITOR_CONTROLS.zoomMotionBlurTuning,
	zoomTemporalMotionBlur: DEFAULT_EDITOR_CONTROLS.zoomTemporalMotionBlur,
	zoomMotionBlurSampleCount: DEFAULT_EDITOR_CONTROLS.zoomMotionBlurSampleCount,
	zoomMotionBlurShutterFraction: DEFAULT_EDITOR_CONTROLS.zoomMotionBlurShutterFraction,
	connectZooms: DEFAULT_EDITOR_CONTROLS.connectZooms,
	zoomInDurationMs: DEFAULT_EDITOR_CONTROLS.zoomInDurationMs,
	zoomInOverlapMs: DEFAULT_EDITOR_CONTROLS.zoomInOverlapMs,
	zoomOutDurationMs: DEFAULT_EDITOR_CONTROLS.zoomOutDurationMs,
	connectedZoomGapMs: DEFAULT_EDITOR_CONTROLS.connectedZoomGapMs,
	connectedZoomDurationMs: DEFAULT_EDITOR_CONTROLS.connectedZoomDurationMs,
	zoomInEasing: DEFAULT_EDITOR_CONTROLS.zoomInEasing,
	zoomOutEasing: DEFAULT_EDITOR_CONTROLS.zoomOutEasing,
	connectedZoomEasing: DEFAULT_EDITOR_CONTROLS.connectedZoomEasing,
	showCursor: DEFAULT_EDITOR_CONTROLS.showCursor,
	loopCursor: DEFAULT_EDITOR_CONTROLS.loopCursor,
	cursorStyle: DEFAULT_EDITOR_CONTROLS.cursorStyle,
	cursorSize: DEFAULT_EDITOR_CONTROLS.cursorSize,
	cursorSmoothing: DEFAULT_EDITOR_CONTROLS.cursorSmoothing,
	cursorSpringStiffnessMultiplier: DEFAULT_EDITOR_CONTROLS.cursorSpringStiffnessMultiplier,
	cursorSpringDampingMultiplier: DEFAULT_EDITOR_CONTROLS.cursorSpringDampingMultiplier,
	cursorSpringMassMultiplier: DEFAULT_EDITOR_CONTROLS.cursorSpringMassMultiplier,
	cameraSpringStiffnessMultiplier: DEFAULT_EDITOR_CONTROLS.cameraSpringStiffnessMultiplier,
	cameraSpringDampingMultiplier: DEFAULT_EDITOR_CONTROLS.cameraSpringDampingMultiplier,
	cameraSpringMassMultiplier: DEFAULT_EDITOR_CONTROLS.cameraSpringMassMultiplier,
	zoomSmoothness: DEFAULT_EDITOR_CONTROLS.zoomSmoothness,
	zoomClassicMode: DEFAULT_EDITOR_CONTROLS.zoomClassicMode,
	cursorMotionBlur: DEFAULT_EDITOR_CONTROLS.cursorMotionBlur,
	cursorClickBounce: DEFAULT_EDITOR_CONTROLS.cursorClickBounce,
	cursorClickBounceDuration: DEFAULT_EDITOR_CONTROLS.cursorClickBounceDuration,
	cursorSway: DEFAULT_EDITOR_CONTROLS.cursorSway,
	borderRadius: DEFAULT_EDITOR_CONTROLS.borderRadius,
	padding: DEFAULT_EDITOR_CONTROLS.padding,
	frame: DEFAULT_EDITOR_CONTROLS.frame,
	webcam: DEFAULT_EDITOR_CONTROLS.webcam,
	aspectRatio: DEFAULT_EDITOR_CONTROLS.aspectRatio,
	exportEncodingMode: DEFAULT_EDITOR_CONTROLS.exportEncodingMode,
	exportBackendPreference: DEFAULT_EDITOR_CONTROLS.exportBackendPreference,
	exportPipelineModel: DEFAULT_EDITOR_CONTROLS.exportPipelineModel,
	exportQuality: DEFAULT_EDITOR_CONTROLS.exportQuality,
	mp4FrameRate: DEFAULT_EDITOR_CONTROLS.mp4FrameRate,
	exportFormat: DEFAULT_EDITOR_CONTROLS.exportFormat,
	exportTransparentBackground: false,
	exportAlphaSafeCanvas: false,
	exportAlphaSafeCanvasScale: DEFAULT_ALPHA_SAFE_CANVAS_SCALE,
	exportAlphaFormat: "mov",
	gifFrameRate: DEFAULT_EDITOR_CONTROLS.gifFrameRate,
	gifLoop: DEFAULT_EDITOR_CONTROLS.gifLoop,
	gifSizePreset: DEFAULT_EDITOR_CONTROLS.gifSizePreset,
	customAspectWidth: "16",
	customAspectHeight: "9",
	customWallpapers: [],
	autoApplyFreshRecordingAutoZooms: true,
	defaultZoomDurationMs: DEFAULT_NEW_ZOOM_DURATION_MS,
	defaultZoomMode: DEFAULT_NEW_ZOOM_MODE,
	lastManualZoomFocus: DEFAULT_MANUAL_ZOOM_FOCUS,
	whisperExecutablePath: null,
	whisperModelPath: null,
};

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(min, value))
		: fallback;
}

function normalizeZoomMode(value: unknown, fallback: ZoomMode): ZoomMode {
	return value === "manual" || value === "auto" ? value : fallback;
}

function normalizeZoomFocus(value: unknown, fallback: ZoomFocus): ZoomFocus {
	if (!value || typeof value !== "object") {
		return fallback;
	}

	const raw = value as Partial<ZoomFocus>;
	return {
		cx: normalizeNumber(raw.cx, fallback.cx, 0, 1),
		cy: normalizeNumber(raw.cy, fallback.cy, 0, 1),
	};
}

function normalizeAlphaFormat(value: unknown, fallback: "mov" | "webm"): "mov" | "webm" {
	return value === "mov" || value === "webm" ? value : fallback;
}

function normalizePositiveIntegerString(value: unknown, fallback: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		return fallback;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}

	return String(parsed);
}

function normalizeCustomWallpapers(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) {
		return fallback;
	}

	return Array.from(
		new Set(
			value.filter((item): item is string => typeof item === "string" && item.length > 0),
		),
	);
}

function normalizeNullablePath(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizePresetAutoCaptionSettings(value: unknown): PresetAutoCaptionSettings {
	return normalizeProjectEditor({
		autoCaptionSettings:
			value && typeof value === "object" ? (value as PresetAutoCaptionSettings) : undefined,
	}).autoCaptionSettings;
}

function normalizeEditorPresetSnapshot(candidate: unknown): EditorPresetSnapshot {
	const normalizedPreferences = normalizeEditorPreferences(candidate);
	const raw =
		candidate && typeof candidate === "object"
			? (candidate as Partial<EditorPresetSnapshot>)
			: {};

	return {
		...normalizeEditorControls(normalizedPreferences, normalizedPreferences),
		autoCaptionSettings: normalizePresetAutoCaptionSettings(raw.autoCaptionSettings),
		whisperExecutablePath:
			normalizeNullablePath(raw.whisperExecutablePath) ??
			normalizedPreferences.whisperExecutablePath,
		whisperModelPath:
			normalizeNullablePath(raw.whisperModelPath) ?? normalizedPreferences.whisperModelPath,
	};
}

function normalizePresetName(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim().replace(/\s+/g, " ");
	return trimmed.length > 0 ? trimmed : null;
}

function normalizePresetTimestamp(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}

	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizeEditorPreset(candidate: unknown): EditorPreset | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<EditorPreset>;
	const name = normalizePresetName(raw.name);
	if (!name) {
		return null;
	}

	const timestamp = new Date().toISOString();
	const id =
		typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id : crypto.randomUUID();

	return {
		id,
		name,
		createdAt: normalizePresetTimestamp(raw.createdAt, timestamp),
		updatedAt: normalizePresetTimestamp(raw.updatedAt, timestamp),
		snapshot: normalizeEditorPresetSnapshot(raw.snapshot),
	};
}

function normalizeEditorPresets(candidates: unknown): EditorPreset[] {
	if (!Array.isArray(candidates)) {
		return [];
	}

	return candidates
		.map((item) => normalizeEditorPreset(item))
		.filter((preset): preset is EditorPreset => preset !== null)
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function serializeEditorPresetSnapshot(snapshot: EditorPresetSnapshot): string {
	return JSON.stringify(normalizeEditorPresetSnapshot(snapshot));
}

function normalizeEditorControls(
	raw: Partial<EditorPreferences>,
	fallback: EditorPreferences,
): PersistedEditorControls {
	const sanitizedRaw = stripPersistedDevMotionBlurSettings(raw);
	const candidate: PartialEditorControls = {
		wallpaper: sanitizedRaw.wallpaper ?? fallback.wallpaper,
		shadowIntensity: sanitizedRaw.shadowIntensity ?? fallback.shadowIntensity,
		backgroundBlur: sanitizedRaw.backgroundBlur ?? fallback.backgroundBlur,
		zoomMotionBlur: sanitizedRaw.zoomMotionBlur ?? fallback.zoomMotionBlur,
		connectZooms: sanitizedRaw.connectZooms ?? fallback.connectZooms,
		zoomInDurationMs: sanitizedRaw.zoomInDurationMs ?? fallback.zoomInDurationMs,
		zoomInOverlapMs: sanitizedRaw.zoomInOverlapMs ?? fallback.zoomInOverlapMs,
		zoomOutDurationMs: sanitizedRaw.zoomOutDurationMs ?? fallback.zoomOutDurationMs,
		connectedZoomGapMs: sanitizedRaw.connectedZoomGapMs ?? fallback.connectedZoomGapMs,
		connectedZoomDurationMs:
			sanitizedRaw.connectedZoomDurationMs ?? fallback.connectedZoomDurationMs,
		zoomInEasing: sanitizedRaw.zoomInEasing ?? fallback.zoomInEasing,
		zoomOutEasing: sanitizedRaw.zoomOutEasing ?? fallback.zoomOutEasing,
		connectedZoomEasing: sanitizedRaw.connectedZoomEasing ?? fallback.connectedZoomEasing,
		showCursor: sanitizedRaw.showCursor ?? fallback.showCursor,
		loopCursor: sanitizedRaw.loopCursor ?? fallback.loopCursor,
		cursorStyle: sanitizedRaw.cursorStyle ?? fallback.cursorStyle,
		cursorSize: sanitizedRaw.cursorSize ?? fallback.cursorSize,
		cursorSmoothing: sanitizedRaw.cursorSmoothing ?? fallback.cursorSmoothing,
		cursorSpringStiffnessMultiplier:
			sanitizedRaw.cursorSpringStiffnessMultiplier ??
			fallback.cursorSpringStiffnessMultiplier,
		cursorSpringDampingMultiplier:
			sanitizedRaw.cursorSpringDampingMultiplier ?? fallback.cursorSpringDampingMultiplier,
		cursorSpringMassMultiplier:
			sanitizedRaw.cursorSpringMassMultiplier ?? fallback.cursorSpringMassMultiplier,
		cameraSpringStiffnessMultiplier:
			sanitizedRaw.cameraSpringStiffnessMultiplier ??
			fallback.cameraSpringStiffnessMultiplier,
		cameraSpringDampingMultiplier:
			sanitizedRaw.cameraSpringDampingMultiplier ?? fallback.cameraSpringDampingMultiplier,
		cameraSpringMassMultiplier:
			sanitizedRaw.cameraSpringMassMultiplier ?? fallback.cameraSpringMassMultiplier,
		zoomSmoothness: sanitizedRaw.zoomSmoothness ?? fallback.zoomSmoothness,
		zoomClassicMode: sanitizedRaw.zoomClassicMode ?? fallback.zoomClassicMode,
		cursorMotionBlur: sanitizedRaw.cursorMotionBlur ?? fallback.cursorMotionBlur,
		cursorClickBounce: sanitizedRaw.cursorClickBounce ?? fallback.cursorClickBounce,
		cursorClickBounceDuration:
			sanitizedRaw.cursorClickBounceDuration ?? fallback.cursorClickBounceDuration,
		cursorSway: sanitizedRaw.cursorSway ?? fallback.cursorSway,
		borderRadius: sanitizedRaw.borderRadius ?? fallback.borderRadius,
		padding: sanitizedRaw.padding ?? fallback.padding,
		frame: sanitizedRaw.frame !== undefined ? sanitizedRaw.frame : fallback.frame,
		webcam: sanitizedRaw.webcam ?? fallback.webcam,
		aspectRatio: sanitizedRaw.aspectRatio ?? fallback.aspectRatio,
		exportEncodingMode: sanitizedRaw.exportEncodingMode ?? fallback.exportEncodingMode,
		exportBackendPreference:
			sanitizedRaw.exportBackendPreference === undefined
				? fallback.exportBackendPreference
				: normalizeExportBackendPreference(sanitizedRaw.exportBackendPreference),
		exportPipelineModel:
			sanitizedRaw.exportPipelineModel === undefined
				? fallback.exportPipelineModel
				: normalizeExportPipelineModel(sanitizedRaw.exportPipelineModel),
		exportQuality: sanitizedRaw.exportQuality ?? fallback.exportQuality,
		mp4FrameRate:
			sanitizedRaw.mp4FrameRate === undefined
				? fallback.mp4FrameRate
				: normalizeExportMp4FrameRate(sanitizedRaw.mp4FrameRate),
		exportFormat: sanitizedRaw.exportFormat ?? fallback.exportFormat,
		exportTransparentBackground: normalizeBoolean(
			sanitizedRaw.exportTransparentBackground,
			fallback.exportTransparentBackground,
		),
		exportAlphaSafeCanvas: normalizeBoolean(
			sanitizedRaw.exportAlphaSafeCanvas,
			fallback.exportAlphaSafeCanvas,
		),
		exportAlphaSafeCanvasScale:
			sanitizedRaw.exportAlphaSafeCanvasScale === undefined
				? fallback.exportAlphaSafeCanvasScale
				: normalizeAlphaSafeCanvasScale(sanitizedRaw.exportAlphaSafeCanvasScale),
		exportAlphaFormat: normalizeAlphaFormat(
			sanitizedRaw.exportAlphaFormat,
			fallback.exportAlphaFormat,
		),
		gifFrameRate: sanitizedRaw.gifFrameRate ?? fallback.gifFrameRate,
		gifLoop: sanitizedRaw.gifLoop ?? fallback.gifLoop,
		gifSizePreset: sanitizedRaw.gifSizePreset ?? fallback.gifSizePreset,
	};

	const normalized = normalizeProjectEditor(candidate);

	return {
		wallpaper: normalized.wallpaper,
		shadowIntensity: normalized.shadowIntensity,
		backgroundBlur: normalized.backgroundBlur,
		zoomMotionBlur: normalized.zoomMotionBlur,
		zoomMotionBlurTuning: normalized.zoomMotionBlurTuning,
		zoomTemporalMotionBlur: normalized.zoomTemporalMotionBlur,
		zoomMotionBlurSampleCount: normalized.zoomMotionBlurSampleCount,
		zoomMotionBlurShutterFraction: normalized.zoomMotionBlurShutterFraction,
		connectZooms: normalized.connectZooms,
		zoomInDurationMs: normalized.zoomInDurationMs,
		zoomInOverlapMs: normalized.zoomInOverlapMs,
		zoomOutDurationMs: normalized.zoomOutDurationMs,
		connectedZoomGapMs: normalized.connectedZoomGapMs,
		connectedZoomDurationMs: normalized.connectedZoomDurationMs,
		zoomInEasing: normalized.zoomInEasing,
		zoomOutEasing: normalized.zoomOutEasing,
		connectedZoomEasing: normalized.connectedZoomEasing,
		showCursor: normalized.showCursor,
		loopCursor: normalized.loopCursor,
		cursorStyle: normalized.cursorStyle,
		cursorSize: normalized.cursorSize,
		cursorSmoothing: normalized.cursorSmoothing,
		cursorSpringStiffnessMultiplier: normalized.cursorSpringStiffnessMultiplier,
		cursorSpringDampingMultiplier: normalized.cursorSpringDampingMultiplier,
		cursorSpringMassMultiplier: normalized.cursorSpringMassMultiplier,
		cameraSpringStiffnessMultiplier: normalized.cameraSpringStiffnessMultiplier,
		cameraSpringDampingMultiplier: normalized.cameraSpringDampingMultiplier,
		cameraSpringMassMultiplier: normalized.cameraSpringMassMultiplier,
		zoomSmoothness: normalized.zoomSmoothness,
		zoomClassicMode: normalized.zoomClassicMode,
		cursorMotionBlur: normalized.cursorMotionBlur,
		cursorClickBounce: normalized.cursorClickBounce,
		cursorClickBounceDuration: normalized.cursorClickBounceDuration,
		cursorSway: normalized.cursorSway,
		borderRadius: normalized.borderRadius,
		padding: normalized.padding,
		frame: normalized.frame,
		webcam: normalized.webcam,
		aspectRatio: normalized.aspectRatio,
		exportEncodingMode: normalized.exportEncodingMode,
		exportBackendPreference: normalized.exportBackendPreference,
		exportPipelineModel: normalized.exportPipelineModel,
		exportQuality: normalized.exportQuality,
		mp4FrameRate: normalized.mp4FrameRate,
		exportFormat: normalized.exportFormat,
		exportTransparentBackground:
			candidate.exportTransparentBackground ?? fallback.exportTransparentBackground,
		exportAlphaSafeCanvas: candidate.exportAlphaSafeCanvas ?? fallback.exportAlphaSafeCanvas,
		exportAlphaSafeCanvasScale:
			candidate.exportAlphaSafeCanvasScale ?? fallback.exportAlphaSafeCanvasScale,
		exportAlphaFormat: candidate.exportAlphaFormat ?? fallback.exportAlphaFormat,
		gifFrameRate: normalized.gifFrameRate,
		gifLoop: normalized.gifLoop,
		gifSizePreset: normalized.gifSizePreset,
	};
}

export function normalizeEditorPreferences(
	candidate: unknown,
	fallback: EditorPreferences = DEFAULT_EDITOR_PREFERENCES,
): EditorPreferences {
	const raw =
		candidate && typeof candidate === "object" ? (candidate as Partial<EditorPreferences>) : {};

	return {
		...normalizeEditorControls(raw, fallback),
		customAspectWidth: normalizePositiveIntegerString(
			raw.customAspectWidth,
			fallback.customAspectWidth,
		),
		customAspectHeight: normalizePositiveIntegerString(
			raw.customAspectHeight,
			fallback.customAspectHeight,
		),
		customWallpapers: normalizeCustomWallpapers(
			raw.customWallpapers,
			fallback.customWallpapers,
		),
		autoApplyFreshRecordingAutoZooms: normalizeBoolean(
			raw.autoApplyFreshRecordingAutoZooms,
			fallback.autoApplyFreshRecordingAutoZooms,
		),
		defaultZoomDurationMs: normalizeNumber(
			raw.defaultZoomDurationMs,
			fallback.defaultZoomDurationMs,
			100,
			30000,
		),
		defaultZoomMode: normalizeZoomMode(raw.defaultZoomMode, fallback.defaultZoomMode),
		lastManualZoomFocus: normalizeZoomFocus(
			raw.lastManualZoomFocus,
			fallback.lastManualZoomFocus,
		),
		whisperExecutablePath:
			normalizeNullablePath(raw.whisperExecutablePath) ?? fallback.whisperExecutablePath,
		whisperModelPath: normalizeNullablePath(raw.whisperModelPath) ?? fallback.whisperModelPath,
	};
}

export function loadEditorPreferences(): EditorPreferences {
	const persisted = loadAppSetting<unknown>(EDITOR_PREFERENCES_STORAGE_KEY);
	if (persisted !== null) {
		return normalizeEditorPreferences(persisted);
	}

	try {
		const stored = globalThis.localStorage?.getItem(EDITOR_PREFERENCES_STORAGE_KEY);
		if (!stored) {
			return DEFAULT_EDITOR_PREFERENCES;
		}

		return normalizeEditorPreferences(JSON.parse(stored));
	} catch {
		return DEFAULT_EDITOR_PREFERENCES;
	}
}

export function saveEditorPreferences(preferences: Partial<EditorPreferences>): void {
	try {
		const current = loadEditorPreferences();
		const merged = normalizeEditorPreferences({ ...current, ...preferences }, current);
		const persisted = stripPersistedDevMotionBlurSettings(merged);
		saveAppSetting(EDITOR_PREFERENCES_STORAGE_KEY, persisted);
		globalThis.localStorage?.setItem(EDITOR_PREFERENCES_STORAGE_KEY, JSON.stringify(persisted));
	} catch {
		// Ignore storage failures so editor controls still work.
	}
}

export function loadEditorPresets(): EditorPreset[] {
	const persisted = loadAppSetting<unknown>(EDITOR_PRESETS_STORAGE_KEY);
	if (persisted !== null) {
		return normalizeEditorPresets(persisted);
	}

	try {
		const stored = globalThis.localStorage?.getItem(EDITOR_PRESETS_STORAGE_KEY);
		if (!stored) {
			return [];
		}

		return normalizeEditorPresets(JSON.parse(stored));
	} catch {
		return [];
	}
}

export function saveEditorPresets(presets: EditorPreset[]): boolean {
	try {
		const normalized = normalizeEditorPresets(presets);
		const persisted = saveAppSetting(EDITOR_PRESETS_STORAGE_KEY, normalized);
		globalThis.localStorage?.setItem(EDITOR_PRESETS_STORAGE_KEY, JSON.stringify(normalized));
		return persisted || typeof globalThis.localStorage !== "undefined";
	} catch {
		// Ignore storage failures so editor controls still work.
		return false;
	}
}
