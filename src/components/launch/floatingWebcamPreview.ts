export function canShowFloatingWebcamPreview(
	requested: boolean,
	hudOverlayMousePassthroughSupported: boolean | null,
): boolean {
	return requested && hudOverlayMousePassthroughSupported === true;
}

export function canToggleFloatingWebcamPreview(
	hudOverlayMousePassthroughSupported: boolean | null,
): boolean {
	return hudOverlayMousePassthroughSupported !== false;
}

export type WebcamPreviewSize = "small" | "medium" | "large";

export const WEBCAM_PREVIEW_SIZES: readonly WebcamPreviewSize[] = ["small", "medium", "large"];
export const WEBCAM_PREVIEW_SIZE_PX: Record<WebcamPreviewSize, number> = {
	small: 128,
	medium: 192,
	large: 288,
};
export const WEBCAM_PREVIEW_SIZE_STORAGE_KEY = "screendance.hud.webcamPreviewSize";
const DEFAULT_WEBCAM_PREVIEW_SIZE: WebcamPreviewSize = "medium";

function isWebcamPreviewSize(value: unknown): value is WebcamPreviewSize {
	return typeof value === "string" && (WEBCAM_PREVIEW_SIZES as readonly string[]).includes(value);
}

export function nextWebcamPreviewSize(current: WebcamPreviewSize): WebcamPreviewSize {
	const index = WEBCAM_PREVIEW_SIZES.indexOf(current);
	return WEBCAM_PREVIEW_SIZES[(index + 1) % WEBCAM_PREVIEW_SIZES.length];
}

export function loadWebcamPreviewSize(storage: Pick<Storage, "getItem"> | null = safeLocalStorage()) {
	try {
		const stored = storage?.getItem(WEBCAM_PREVIEW_SIZE_STORAGE_KEY);
		return isWebcamPreviewSize(stored) ? stored : DEFAULT_WEBCAM_PREVIEW_SIZE;
	} catch {
		return DEFAULT_WEBCAM_PREVIEW_SIZE;
	}
}

export function saveWebcamPreviewSize(
	size: WebcamPreviewSize,
	storage: Pick<Storage, "setItem"> | null = safeLocalStorage(),
) {
	try {
		storage?.setItem(WEBCAM_PREVIEW_SIZE_STORAGE_KEY, size);
	} catch {
		// Preference only; ignore storage failures.
	}
}

function safeLocalStorage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}
