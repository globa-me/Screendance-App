import { describe, expect, it, vi } from "vitest";
import { validateEditorAutomationCommand } from "../../../../shared/editorAutomation";
import { prepareEditorAutomationMedia } from "./prepareEditorMedia";

const data = "data:image/png;base64,aW1hZ2U=";
describe("approved annotation media preparation", () => {
	it("converts an explicit local image and fills both preview/export source fields without changing caller data", async () => {
		const params = {
			expectedRevision: 7,
			operations: [
				{
					op: "region.update",
					collection: "annotationRegions",
					id: "image-1",
					changes: { imageContent: "/tmp/approved.png" },
				},
			],
		};
		const resolve = vi.fn(async () => data);
		const prepared = await prepareEditorAutomationMedia(params, resolve);
		expect(resolve).toHaveBeenCalledExactlyOnceWith("/tmp/approved.png");
		expect((prepared.operations as typeof params.operations)[0].changes).toEqual({
			imageContent: data,
			content: data,
		});
		expect(params.operations[0].changes.imageContent).toBe("/tmp/approved.png");
		expect(prepared.expectedRevision).toBe(7);
	});
	it("fails the whole preparation when an image resolver does not return usable image data", async () => {
		const params = {
			expectedRevision: 7,
			operations: [
				{ op: "settings.patch", values: { borderRadius: 32 } },
				{
					op: "region.update",
					collection: "annotationRegions",
					id: "image-1",
					changes: { imageContent: "/tmp/approved.png" },
				},
			],
		};
		await expect(
			prepareEditorAutomationMedia(params, async () => "file:///tmp/approved.png"),
		).rejects.toMatchObject({ code: "MEDIA_UNAVAILABLE" });
		expect(params.operations[0]).toEqual({
			op: "settings.patch",
			values: { borderRadius: 32 },
		});
	});
	it("never resolves remote images or arbitrary non-image files", async () => {
		const resolve = vi.fn();
		for (const source of [
			"https://example.com/image.png",
			"/private/secret.txt",
			"../outside.png",
		])
			await expect(
				prepareEditorAutomationMedia(
					{
						expectedRevision: 1,
						operations: [
							{
								op: "region.update",
								collection: "annotationRegions",
								id: "image-1",
								changes: { imageContent: source },
							},
						],
					},
					resolve,
				),
			).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		expect(resolve).not.toHaveBeenCalled();
	});
	it("embeds realistic 100 KB images in supported formats while keeping ordinary text bounded", async () => {
		for (const format of ["png", "svg+xml", "avif", "bmp"]) {
			const dataUrl = `data:image/${format};base64,${"A".repeat(140_000)}`;
			const prepared = await prepareEditorAutomationMedia(
				{
					expectedRevision: 1,
					operations: [
						{
							op: "region.update",
							collection: "annotationRegions",
							id: "image-1",
							changes: { imageContent: "/tmp/approved.png" },
						},
					],
				},
				async () => dataUrl,
			);
			expect(
				(prepared.operations as Array<{ changes: { content: string } }>)[0].changes.content,
			).toBe(dataUrl);
		}
		const patch = (content: string) => ({
			expectedRevision: 1,
			operations: [
				{
					op: "region.update",
					collection: "annotationRegions",
					id: "text-1",
					changes: { content },
				},
			],
		});
		expect(() =>
			validateEditorAutomationCommand("editor.apply", patch("a".repeat(100_000))),
		).not.toThrow();
		expect(() =>
			validateEditorAutomationCommand("editor.apply", patch("a".repeat(100_001))),
		).toThrow();
		expect(() =>
			validateEditorAutomationCommand(
				"editor.apply",
				patch(`data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}`),
			),
		).toThrow();
	});
});
