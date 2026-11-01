import { AutomationError } from "../../../../shared/automationErrors";
import { validateEditorAutomationCommand } from "../../../../shared/editorAutomation";

/** Converts only explicitly supplied image assets after the main host approved their paths. */
export async function prepareEditorAutomationMedia(
	params: Record<string, unknown>,
	resolveAsset: (source: string) => Promise<string>,
): Promise<Record<string, unknown>> {
	const prepared = structuredClone(params);
	async function image(value: Record<string, unknown>, creating: boolean): Promise<void> {
		if (creating && value.type !== "image") return;
		const source =
			typeof value.imageContent === "string"
				? value.imageContent
				: value.type === "image" && typeof value.content === "string"
					? value.content
					: undefined;
		if (!source) return;
		let resolved = source;
		if (!source.startsWith("data:image/")) {
			if (
				!/^(?:\/|file:\/\/\/)/.test(source) ||
				!/\.(?:png|jpe?g|webp|gif|avif|svg|bmp)$/i.test(source)
			)
				throw new AutomationError(
					"INVALID_PARAMS",
					"Image annotations require an absolute local image path or a data:image URL.",
				);
			resolved = await resolveAsset(source);
		}
		if (!/^data:image\/(?:png|jpeg|webp|gif|avif|svg\+xml|bmp);base64,/i.test(resolved))
			throw new AutomationError(
				"MEDIA_UNAVAILABLE",
				"Approved image could not be loaded as an image data URL.",
			);
		value.imageContent = resolved;
		value.content = resolved;
	}
	for (const operation of (prepared.operations as Array<Record<string, unknown>>) ?? []) {
		if (operation.collection !== "annotationRegions") continue;
		if (operation.op === "region.create")
			await image(operation.value as Record<string, unknown>, true);
		else if (operation.op === "region.update")
			await image(operation.changes as Record<string, unknown>, false);
		else if (operation.op === "collection.replace")
			for (const value of operation.values as Array<Record<string, unknown>>)
				await image(value, true);
	}
	// Embedded images must satisfy the same byte limits and strict shape as ordinary requests.
	return validateEditorAutomationCommand("editor.apply", prepared);
}
