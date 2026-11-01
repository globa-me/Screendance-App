import { describe, expect, it } from "vitest";
import { normalizeProjectEditor } from "./projectPersistence";
import type { AnnotationRegion } from "./types";

describe("highlight annotation persistence", () => {
	it("keeps highlight annotations and sanitizes their style", () => {
		const editor = normalizeProjectEditor({
			annotationRegions: [
				{
					id: "annotation-1",
					startMs: 0,
					endMs: 2000,
					type: "highlight",
					content: "",
					position: { x: 10, y: 20 },
					size: { width: 30, height: 15 },
					zIndex: 1,
					highlightData: {
						shape: "marker",
						color: "not-a-color",
						strokeWidth: 500,
						fillOpacity: 4,
					},
				} as unknown as AnnotationRegion,
			],
		});

		const [region] = editor.annotationRegions;
		expect(region.type).toBe("highlight");
		expect(region.highlightData).toEqual({
			shape: "marker",
			color: "#FFD60A",
			strokeWidth: 40,
			fillOpacity: 1,
		});
	});

	it("falls back to a rectangle for unknown shapes", () => {
		const editor = normalizeProjectEditor({
			annotationRegions: [
				{
					id: "annotation-2",
					startMs: 0,
					endMs: 1000,
					type: "highlight",
					content: "",
					position: { x: 0, y: 0 },
					size: { width: 10, height: 10 },
					zIndex: 1,
					highlightData: { shape: "star" },
				} as unknown as AnnotationRegion,
			],
		});
		expect(editor.annotationRegions[0].highlightData?.shape).toBe("rectangle");
	});
});
