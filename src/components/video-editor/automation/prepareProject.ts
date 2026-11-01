import { AutomationError } from "../../../../shared/automation";
import { type EditorProjectData, normalizeProjectEditor } from "../projectPersistence";
import { clipsToTrims, trimsToClips } from "../types";

/** Materialize the editor's duration-dependent migration before recording its saved baseline. */
export function prepareAutomationProject(
	project: EditorProjectData,
	durationMs: number,
): EditorProjectData {
	if (!Number.isFinite(durationMs) || durationMs <= 0)
		throw new AutomationError("MEDIA_LOAD_FAILED", "Source video has no finite duration.");
	const totalMs = Math.round(durationMs);
	const editor = normalizeProjectEditor(project.editor);
	if (editor.clipRegions.length === 0) {
		editor.clipRegions =
			editor.trimRegions.length > 0
				? trimsToClips(editor.trimRegions, totalMs)
				: [{ id: "clip-1", startMs: 0, endMs: totalMs, speed: 1 }];
		// Match the editor's existing legacy timeline bootstrap.
		editor.speedRegions = [];
	}
	if (editor.clipRegions.length > 0) {
		editor.trimRegions = clipsToTrims(editor.clipRegions, totalMs);
	}
	return { ...project, editor: normalizeProjectEditor(editor) };
}

/** Probe in an isolated element so invalid media never replaces the live document. */
export async function probeAutomationVideoDuration(videoUrl: string): Promise<number> {
	const video = document.createElement("video");
	video.preload = "metadata";
	return new Promise<number>((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timeout);
			video.removeEventListener("loadedmetadata", loaded);
			video.removeEventListener("error", failed);
			video.removeAttribute("src");
			video.load();
		};
		const loaded = () => {
			const durationMs = video.duration * 1000;
			const valid = Number.isFinite(durationMs) && durationMs > 0 && video.videoWidth > 0;
			cleanup();
			if (valid) resolve(durationMs);
			else
				reject(
					new AutomationError(
						"MEDIA_LOAD_FAILED",
						"Source has no decodable video with a finite duration.",
					),
				);
		};
		const failed = () => {
			cleanup();
			reject(
				new AutomationError("MEDIA_LOAD_FAILED", "Could not read source video metadata."),
			);
		};
		const timeout = setTimeout(() => {
			cleanup();
			reject(new AutomationError("MEDIA_NOT_READY", "Source metadata loading timed out."));
		}, 15_000);
		video.addEventListener("loadedmetadata", loaded);
		video.addEventListener("error", failed);
		video.src = videoUrl;
		video.load();
	});
}

/** Mirror neutral discovery defaults only; authored settings must remain visible to dirty checks. */
export function applyDiscoveredAudioDefaults(
	baseline: EditorProjectData | null,
	sourcePath: string | null,
	trackIds: string[],
): EditorProjectData | null {
	if (!baseline || !sourcePath || baseline.videoPath !== sourcePath) return baseline;
	const previous = baseline.editor.defaultSourceAudioTrackSettings ?? {};
	const next: NonNullable<typeof previous> = {};
	for (const id of trackIds) next[id] = previous[id] ?? { volume: 1, normalize: false };
	// If discovery temporarily removes an authored setting, retain it in the baseline
	// so the resulting loss remains dirty instead of silently acknowledging it.
	for (const [id, setting] of Object.entries(previous)) {
		if (!(id in next) && (setting.volume !== 1 || setting.normalize)) next[id] = setting;
	}
	const nextKeys = Object.keys(next);
	const previousKeys = Object.keys(previous);
	if (
		previousKeys.length === nextKeys.length &&
		nextKeys.every(
			(id) =>
				previous[id]?.volume === next[id].volume &&
				previous[id]?.normalize === next[id].normalize,
		)
	)
		return baseline;
	return { ...baseline, editor: { ...baseline.editor, defaultSourceAudioTrackSettings: next } };
}
