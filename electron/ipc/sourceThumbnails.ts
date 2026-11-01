export type SourceThumbnailRequest = {
	id: string;
	display_id?: string;
	sourceType?: "screen" | "window";
};

/**
 * Maps a capture source to the id understood by the native thumbnail helper.
 * Screens use `display:<CGDirectDisplayID>`, windows keep `window:<id>:0`.
 */
export function toNativeThumbnailId(source: SourceThumbnailRequest): string | null {
	const isWindow = source.sourceType === "window" || source.id.startsWith("window:");
	if (isWindow) {
		const match = source.id.match(/^window:(\d+)/);
		return match ? `window:${match[1]}:0` : null;
	}
	const displayId = String(source.display_id ?? "").trim();
	return /^\d+$/.test(displayId) ? `display:${displayId}` : null;
}
