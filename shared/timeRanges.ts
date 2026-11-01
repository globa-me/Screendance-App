export type TimeRange = { startMs: number; endMs: number };

/**
 * Sanitizes a list of recording-time ranges: drops invalid entries, rounds to
 * whole milliseconds, sorts and merges overlaps. Used for webcam hidden ranges
 * that cross IPC, session manifests and project files.
 */
export function normalizeTimeRanges(value: unknown, maxRanges = 500): TimeRange[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const ranges = value
		.slice(0, maxRanges * 2)
		.flatMap((entry): TimeRange[] => {
			const startMs = (entry as Partial<TimeRange> | null)?.startMs;
			const endMs = (entry as Partial<TimeRange> | null)?.endMs;
			if (
				typeof startMs !== "number" ||
				typeof endMs !== "number" ||
				!Number.isFinite(startMs) ||
				!Number.isFinite(endMs)
			) {
				return [];
			}
			const start = Math.max(0, Math.round(startMs));
			const end = Math.round(endMs);
			return end > start ? [{ startMs: start, endMs: end }] : [];
		})
		.sort((left, right) => left.startMs - right.startMs);

	const merged: TimeRange[] = [];
	for (const range of ranges) {
		const last = merged[merged.length - 1];
		if (last && range.startMs <= last.endMs) {
			last.endMs = Math.max(last.endMs, range.endMs);
		} else {
			merged.push({ ...range });
		}
	}
	return merged.slice(0, maxRanges);
}

export function isTimeInRanges(timeMs: number, ranges: readonly TimeRange[] | undefined): boolean {
	if (!ranges || ranges.length === 0) {
		return false;
	}
	for (const range of ranges) {
		if (timeMs < range.startMs) return false;
		if (timeMs < range.endMs) return true;
	}
	return false;
}
