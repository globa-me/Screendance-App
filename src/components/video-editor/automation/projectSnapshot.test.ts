import { describe, expect, it } from "vitest";
import { hasUnsavedProjectChanges } from "../projectDirtyState";
import {
	createProjectData,
	normalizeProjectEditor,
	type ProjectEditorState,
	stripPersistedDevMotionBlurSettings,
} from "../projectPersistence";
import { buildPersistedEditorState } from "./projectSnapshot";

// The explicit live-state fields passed by VideoEditor, independently of loaded normalization.
const liveFields = [
	"wallpaper",
	"shadowIntensity",
	"backgroundBlur",
	"zoomMotionBlur",
	"zoomMotionBlurTuning",
	"zoomTemporalMotionBlur",
	"zoomMotionBlurSampleCount",
	"zoomMotionBlurShutterFraction",
	"connectZooms",
	"zoomInDurationMs",
	"zoomInOverlapMs",
	"zoomOutDurationMs",
	"connectedZoomGapMs",
	"connectedZoomDurationMs",
	"zoomInEasing",
	"zoomOutEasing",
	"connectedZoomEasing",
	"showCursor",
	"loopCursor",
	"cursorStyle",
	"cursorSize",
	"cursorSmoothing",
	"cursorSpringStiffnessMultiplier",
	"cursorSpringDampingMultiplier",
	"cursorSpringMassMultiplier",
	"cameraSpringStiffnessMultiplier",
	"cameraSpringDampingMultiplier",
	"cameraSpringMassMultiplier",
	"zoomSmoothness",
	"zoomClassicMode",
	"cursorMotionBlur",
	"cursorClickBounce",
	"cursorClickBounceDuration",
	"cursorSway",
	"borderRadius",
	"padding",
	"frame",
	"cropRegion",
	"webcam",
	"zoomRegions",
	"trimRegions",
	"clipRegions",
	"speedRegions",
	"annotationRegions",
	"audioRegions",
	"autoCaptions",
	"autoCaptionSettings",
	"aspectRatio",
	"exportEncodingMode",
	"exportBackendPreference",
	"exportPipelineModel",
	"exportQuality",
	"mp4FrameRate",
	"exportFormat",
	"gifFrameRate",
	"gifLoop",
	"gifSizePreset",
	"sourceAudioTrackSettingsByClip",
	"defaultSourceAudioTrackSettings",
] as const satisfies readonly (keyof ProjectEditorState)[];

function liveEditorState(loaded: ProjectEditorState): Partial<ProjectEditorState> {
	return Object.fromEntries(liveFields.map((field) => [field, loaded[field]]));
}

describe("persisted editor snapshot shape", () => {
	it("compares a normalized loaded baseline with the explicit live state without false dirty", () => {
		const loaded = normalizeProjectEditor({
			wallpaper: "#315efb",
			aspectRatio: "9:16",
			padding: { top: 48, left: 48, right: 48, bottom: 48 },
			borderRadius: 24,
			showCursor: false,
			clipRegions: [{ id: "clip-1", startMs: 0, endMs: 3000, speed: 1 }],
			defaultSourceAudioTrackSettings: { mixed: { volume: 1, normalize: false } },
		});
		const live = liveEditorState(loaded);
		expect(live).not.toHaveProperty("autoFullTrackClipId");
		// Reproduce the old asymmetry so this test cannot pass using two copies of one shape.
		expect(
			hasUnsavedProjectChanges(
				createProjectData("/source.mp4", stripPersistedDevMotionBlurSettings(live)),
				createProjectData("/source.mp4", stripPersistedDevMotionBlurSettings(loaded)),
			),
		).toBe(true);
		const baseline = createProjectData("/source.mp4", buildPersistedEditorState(loaded));
		const current = createProjectData("/source.mp4", buildPersistedEditorState(live));
		expect(hasUnsavedProjectChanges(current, baseline)).toBe(false);
		expect(
			hasUnsavedProjectChanges(
				createProjectData(
					"/source.mp4",
					buildPersistedEditorState({ ...live, borderRadius: 32 }),
				),
				baseline,
			),
		).toBe(true);
	});

	it("preserves nondefault full-track provenance and authored settings verbatim", () => {
		const input = {
			autoFullTrackClipId: "clip-7",
			autoFullTrackClipEndMs: 3000,
			wallpaper: "#123456",
			shadowIntensity: 0.12345,
		};
		expect(buildPersistedEditorState(input)).toEqual(input);
		const changed = buildPersistedEditorState({ ...input, autoFullTrackClipEndMs: 4000 });
		expect(
			hasUnsavedProjectChanges(
				createProjectData("/source.mp4", changed),
				createProjectData("/source.mp4", buildPersistedEditorState(input)),
			),
		).toBe(true);
	});
});
