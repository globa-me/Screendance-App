import { AutomationError } from "../../../../shared/automation";
import type { CursorTelemetryPoint, ZoomRegion } from "../types";

export interface AutomationPreviewOptions {
	width: number;
	height: number;
	timeMs: number;
	strict: boolean;
	zoomRegions: ZoomRegion[];
	cursorTelemetry: CursorTelemetryPoint[];
}

export function getAutomationPreviewDimensions(aspectRatio: number): {
	width: number;
	height: number;
} {
	if (!Number.isFinite(aspectRatio) || aspectRatio <= 0)
		throw new AutomationError("INVALID_STATE", "Preview aspect ratio is invalid.");
	return aspectRatio >= 1
		? { width: 1280, height: Math.max(1, Math.round(1280 / aspectRatio)) }
		: { width: Math.max(1, Math.round(1280 * aspectRatio)), height: 1280 };
}

/** Seek a paused source element with a bounded wait and listener cleanup. */
export async function seekAutomationVideo(
	video: HTMLVideoElement,
	timeMs: unknown,
): Promise<number> {
	if (
		typeof timeMs !== "number" ||
		!Number.isFinite(timeMs) ||
		timeMs < 0 ||
		timeMs > video.duration * 1000
	) {
		throw new AutomationError(
			"INVALID_PARAMS",
			"timeMs must be within the source video duration.",
		);
	}
	if (!video.paused)
		throw new AutomationError("BUSY", "Pause playback before rendering a preview.");
	const targetSeconds = Math.min(timeMs / 1000, Math.max(0, video.duration - 0.001));
	if (video.seeking || Math.abs(video.currentTime - targetSeconds) > 0.000001) {
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timeout);
				video.removeEventListener("seeked", done);
				video.removeEventListener("error", failed);
			};
			const done = () => {
				cleanup();
				resolve();
			};
			const failed = () => {
				cleanup();
				reject(new AutomationError("MEDIA_LOAD_FAILED", "Video seek failed."));
			};
			const timeout = setTimeout(() => {
				cleanup();
				reject(new AutomationError("MEDIA_NOT_READY", "Video seek timed out."));
			}, 10_000);
			video.addEventListener("seeked", done);
			video.addEventListener("error", failed);
			video.currentTime = targetSeconds;
		});
	}
	return video.currentTime * 1000;
}
