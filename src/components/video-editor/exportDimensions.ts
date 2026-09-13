import type { ExportQuality } from "@/lib/exporter";
import { type AspectRatio, getAspectRatioValue } from "@/utils/aspectRatioUtils";

function normalizeEvenDimension(value: number): number {
	return Math.max(2, Math.floor(value / 2) * 2);
}

function normalizeEvenDimensionUp(value: number): number {
	return Math.max(2, Math.ceil(value / 2) * 2);
}

function fitAspectRatioWithinBounds(
	maxWidth: number,
	maxHeight: number,
	aspectRatioValue: number,
): { width: number; height: number } {
	const safeMaxWidth = normalizeEvenDimension(maxWidth);
	const safeMaxHeight = normalizeEvenDimension(maxHeight);
	const safeAspectRatio =
		Number.isFinite(aspectRatioValue) && aspectRatioValue > 0 ? aspectRatioValue : 16 / 9;

	if (safeMaxWidth / safeMaxHeight > safeAspectRatio) {
		const height = safeMaxHeight;
		const width = normalizeEvenDimension(height * safeAspectRatio);
		return { width: Math.min(width, safeMaxWidth), height };
	}

	const width = safeMaxWidth;
	const height = normalizeEvenDimension(width / safeAspectRatio);
	return { width, height: Math.min(height, safeMaxHeight) };
}

export function calculateMp4SourceDimensions(
	sourceWidth: number,
	sourceHeight: number,
	aspectRatio: AspectRatio,
): { width: number; height: number } {
	const safeSourceWidth = normalizeEvenDimension(sourceWidth);
	const safeSourceHeight = normalizeEvenDimension(sourceHeight);
	const sourceAspectRatio = safeSourceHeight > 0 ? safeSourceWidth / safeSourceHeight : 16 / 9;
	const aspectRatioValue = getAspectRatioValue(aspectRatio, sourceAspectRatio);

	if (aspectRatio === "native") {
		return { width: safeSourceWidth, height: safeSourceHeight };
	}

	const longSide = Math.max(safeSourceWidth, safeSourceHeight);
	const shortSide = Math.min(safeSourceWidth, safeSourceHeight);
	const maxWidth = aspectRatioValue >= 1 ? longSide : shortSide;
	const maxHeight = aspectRatioValue >= 1 ? shortSide : longSide;

	return fitAspectRatioWithinBounds(maxWidth, maxHeight, aspectRatioValue);
}

export function calculateMp4ExportDimensions(
	baseWidth: number,
	baseHeight: number,
	quality: ExportQuality,
): { width: number; height: number } {
	if (quality === "source") {
		return {
			width: normalizeEvenDimension(baseWidth),
			height: normalizeEvenDimension(baseHeight),
		};
	}

	const qualityScale = quality === "medium" ? 0.6 : quality === "good" ? 0.75 : 0.9;
	return {
		width: normalizeEvenDimension(baseWidth * qualityScale),
		height: normalizeEvenDimension(baseHeight * qualityScale),
	};
}

export const DEFAULT_ALPHA_SAFE_CANVAS_SCALE = 1.5;
export const MIN_ALPHA_SAFE_CANVAS_SCALE = 1.25;
export const MAX_ALPHA_SAFE_CANVAS_SCALE = 2.5;

export function normalizeAlphaSafeCanvasScale(scale: number): number {
	if (!Number.isFinite(scale)) {
		return DEFAULT_ALPHA_SAFE_CANVAS_SCALE;
	}

	return Math.min(MAX_ALPHA_SAFE_CANVAS_SCALE, Math.max(MIN_ALPHA_SAFE_CANVAS_SCALE, scale));
}

export function calculateAlphaSafeCanvasDimensions(
	baseWidth: number,
	baseHeight: number,
	scale = DEFAULT_ALPHA_SAFE_CANVAS_SCALE,
): { width: number; height: number } {
	const safeScale = normalizeAlphaSafeCanvasScale(scale);
	return {
		width: normalizeEvenDimensionUp(baseWidth * safeScale),
		height: normalizeEvenDimensionUp(baseHeight * safeScale),
	};
}
