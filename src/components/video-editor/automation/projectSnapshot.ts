import {
	type ProjectEditorState,
	stripPersistedDevMotionBlurSettings,
} from "../projectPersistence";

/** Use one payload shape for loaded baselines, live dirty checks and saves. */
export function buildPersistedEditorState<T extends Partial<ProjectEditorState>>(editor: T) {
	return stripPersistedDevMotionBlurSettings({
		...editor,
		autoFullTrackClipId: editor.autoFullTrackClipId ?? null,
		autoFullTrackClipEndMs: editor.autoFullTrackClipEndMs ?? null,
	});
}
