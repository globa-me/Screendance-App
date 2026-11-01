import type { Graphics } from "pixi.js";
import {
	type AnnotationRegion,
	BASE_PREVIEW_WIDTH,
	DEFAULT_HIGHLIGHT_DATA,
	type HighlightData,
} from "../types";
import type { CursorViewportRect } from "./cursorViewport";

/**
 * Content highlights are annotations anchored to the recorded content rather
 * than to the output canvas. Their `position`/`size` are percentages of the
 * full source video frame (like cursor telemetry), so they stay on the same
 * on-screen element through zooms, camera motion and later crop changes.
 *
 * Every renderer draws them inside its camera container (below the cursor),
 * which applies the zoom transform for free.
 */

export const HIGHLIGHT_FADE_MS = 120;

export interface HighlightRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function isContentHighlight(annotation: Pick<AnnotationRegion, "type">): boolean {
	return annotation.type === "highlight";
}

export function resolveHighlightData(annotation: AnnotationRegion): HighlightData {
	return { ...DEFAULT_HIGHLIGHT_DATA, ...(annotation.highlightData ?? {}) };
}

/**
 * Projects a highlight from source-video percentages onto the stage using the
 * visible (cropped) video rect.
 */
export function projectHighlightRect(
	annotation: Pick<AnnotationRegion, "position" | "size">,
	maskRect: CursorViewportRect,
): HighlightRect | null {
	const crop = maskRect.sourceCrop ?? { x: 0, y: 0, width: 1, height: 1 };
	if (crop.width <= 0 || crop.height <= 0 || maskRect.width <= 0 || maskRect.height <= 0) {
		return null;
	}

	const sourceX = annotation.position.x / 100;
	const sourceY = annotation.position.y / 100;
	const sourceWidth = annotation.size.width / 100;
	const sourceHeight = annotation.size.height / 100;

	return {
		x: maskRect.x + ((sourceX - crop.x) / crop.width) * maskRect.width,
		y: maskRect.y + ((sourceY - crop.y) / crop.height) * maskRect.height,
		width: (sourceWidth / crop.width) * maskRect.width,
		height: (sourceHeight / crop.height) * maskRect.height,
	};
}

/**
 * Inverse of {@link projectHighlightRect}: converts a stage-space rect back to
 * source-video percentages.
 */
export function unprojectHighlightRect(
	rect: HighlightRect,
	maskRect: CursorViewportRect,
): { position: { x: number; y: number }; size: { width: number; height: number } } | null {
	const crop = maskRect.sourceCrop ?? { x: 0, y: 0, width: 1, height: 1 };
	if (maskRect.width <= 0 || maskRect.height <= 0) {
		return null;
	}

	return {
		position: {
			x: (crop.x + ((rect.x - maskRect.x) / maskRect.width) * crop.width) * 100,
			y: (crop.y + ((rect.y - maskRect.y) / maskRect.height) * crop.height) * 100,
		},
		size: {
			width: (rect.width / maskRect.width) * crop.width * 100,
			height: (rect.height / maskRect.height) * crop.height * 100,
		},
	};
}

/** Opacity multiplier for a short fade at the start and end of a highlight. */
export function getHighlightFadeAlpha(
	annotation: Pick<AnnotationRegion, "startMs" | "endMs">,
	timeMs: number,
): number {
	if (timeMs < annotation.startMs || timeMs > annotation.endMs) {
		return 0;
	}
	const duration = Math.max(0, annotation.endMs - annotation.startMs);
	const fadeMs = Math.min(HIGHLIGHT_FADE_MS, duration / 4);
	if (fadeMs <= 0) {
		return 1;
	}
	const fadeIn = (timeMs - annotation.startMs) / fadeMs;
	const fadeOut = (annotation.endMs - timeMs) / fadeMs;
	return Math.max(0, Math.min(1, fadeIn, fadeOut));
}

function parseHexColor(color: string): number {
	const normalized = color.trim().replace(/^#/, "");
	const expanded =
		normalized.length === 3
			? normalized
					.split("")
					.map((char) => char + char)
					.join("")
			: normalized.slice(0, 6);
	const parsed = Number.parseInt(expanded, 16);
	return Number.isFinite(parsed) ? parsed : 0xfacc15;
}

/**
 * Redraws all highlights active at `timeMs` into `graphics`. `stageWidth` is
 * used to scale stroke widths, which are authored at the 1920px preview base.
 */
export function drawContentHighlights(
	graphics: Graphics,
	annotations: AnnotationRegion[] | undefined,
	timeMs: number,
	maskRect: CursorViewportRect | null | undefined,
	stageWidth: number,
): void {
	graphics.clear();
	if (!annotations || annotations.length === 0 || !maskRect) {
		return;
	}

	const strokeScale = stageWidth > 0 ? stageWidth / BASE_PREVIEW_WIDTH : 1;
	const active = annotations
		.filter(isContentHighlight)
		.map((annotation) => ({ annotation, alpha: getHighlightFadeAlpha(annotation, timeMs) }))
		.filter((entry) => entry.alpha > 0)
		.sort((left, right) => left.annotation.zIndex - right.annotation.zIndex);

	for (const { annotation, alpha } of active) {
		const rect = projectHighlightRect(annotation, maskRect);
		if (!rect || rect.width <= 0 || rect.height <= 0) {
			continue;
		}
		const data = resolveHighlightData(annotation);
		const color = parseHexColor(data.color);
		const strokeWidth = Math.max(0.5, data.strokeWidth * strokeScale);
		const fillAlpha = Math.max(0, Math.min(1, data.fillOpacity)) * alpha;

		switch (data.shape) {
			case "ellipse": {
				graphics.ellipse(
					rect.x + rect.width / 2,
					rect.y + rect.height / 2,
					rect.width / 2,
					rect.height / 2,
				);
				if (fillAlpha > 0) graphics.fill({ color, alpha: fillAlpha });
				graphics.stroke({ width: strokeWidth, color, alpha, alignment: 0.5 });
				break;
			}
			case "marker": {
				const radius = Math.min(rect.height / 2, 6 * strokeScale);
				graphics.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
				graphics.fill({ color, alpha: fillAlpha });
				break;
			}
			default: {
				const radius = Math.min(rect.width / 2, rect.height / 2, 8 * strokeScale);
				graphics.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
				if (fillAlpha > 0) graphics.fill({ color, alpha: fillAlpha });
				graphics.stroke({ width: strokeWidth, color, alpha, alignment: 0.5 });
				break;
			}
		}
	}
}
