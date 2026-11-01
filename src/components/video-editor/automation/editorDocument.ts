import { AutomationError } from "../../../../shared/automation";
import {
	creationPreferencesSchema,
	EDITOR_COLLECTION_SCHEMAS,
	type EditorApplyParams,
	type EditorCollection,
	type EditorDocumentSnapshot,
	editorSettingsSchema,
	exportPreferencesSchema,
	validateEditorAutomationCommand,
} from "../../../../shared/editorAutomation";
import { type ClipRegion, clipsToTrims, getClipSourceEndMs, trimsToClips } from "../types";

const clone = <T>(value: T): T => structuredClone(value);
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function merge(
	target: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		if (["__proto__", "constructor", "prototype"].includes(key))
			throw new AutomationError("INVALID_PARAMS", "Reserved property.");
		result[key] =
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			target[key] &&
			typeof target[key] === "object" &&
			!Array.isArray(target[key])
				? merge(target[key] as Record<string, unknown>, value as Record<string, unknown>)
				: clone(value);
	}
	return result;
}

/** Shares the source-preserving clip split with UI; child settings follow their media. */
export function splitDocumentClip(
	snapshot: EditorDocumentSnapshot,
	id: string,
	atMs: number,
	leftId: string,
	rightId: string,
): void {
	const clip = snapshot.editor.clipRegions.find((item) => item.id === id);
	if (!clip) throw new AutomationError("ID_NOT_FOUND", `Clip ${id} does not exist.`);
	if (atMs <= clip.startMs || atMs >= clip.endMs)
		throw new AutomationError(
			"INVALID_PARAMS",
			"Split time must be strictly inside the clip's display span.",
		);
	if (
		leftId === rightId ||
		snapshot.editor.clipRegions.some(
			(item) => item.id !== id && [leftId, rightId].includes(item.id),
		)
	)
		throw new AutomationError("DUPLICATE_ID", "Split IDs must be unique.");
	const sourceSplit = Math.round(clip.startMs + (atMs - clip.startMs) * clip.speed);
	const children: ClipRegion[] = [
		{ ...clip, id: leftId, endMs: atMs },
		{ ...clip, id: rightId, startMs: sourceSplit, endMs: sourceSplit + clip.endMs - atMs },
	];
	snapshot.editor.clipRegions = snapshot.editor.clipRegions.flatMap((item) =>
		item.id === id ? children : [item],
	);
	const audio = snapshot.editor.sourceAudioTrackSettingsByClip?.[id];
	if (audio) {
		const settings = { ...snapshot.editor.sourceAudioTrackSettingsByClip };
		delete settings[id];
		settings[leftId] = clone(audio);
		settings[rightId] = clone(audio);
		snapshot.editor.sourceAudioTrackSettingsByClip = settings;
	}
}

export function validateEditorDocument(
	snapshot: EditorDocumentSnapshot,
	sourceDurationMs: number,
): void {
	const { autoFullTrackClipId: _id, autoFullTrackClipEndMs: _end, ...settings } = snapshot.editor;
	for (const key of Object.keys(EDITOR_COLLECTION_SCHEMAS))
		delete (settings as unknown as Record<string, unknown>)[key];
	const check = editorSettingsSchema.safeParse(settings);
	if (!check.success)
		throw new AutomationError("INVALID_DOCUMENT", "Document settings are invalid.", {
			issues: check.error.issues,
		});
	for (const schema of [exportPreferencesSchema, creationPreferencesSchema]) {
		const parsed = schema.safeParse(
			schema === exportPreferencesSchema
				? snapshot.exportPreferences
				: snapshot.creationPreferences,
		);
		if (!parsed.success)
			throw new AutomationError("INVALID_DOCUMENT", "Document preferences are invalid.", {
				issues: parsed.error.issues,
			});
	}
	for (const [collection, schema] of Object.entries(EDITOR_COLLECTION_SCHEMAS)) {
		const values = snapshot.editor[collection as EditorCollection];
		const ids = new Set<string>();
		for (const value of values) {
			const parsed = schema.safeParse(value);
			if (!parsed.success)
				throw new AutomationError("INVALID_DOCUMENT", `Invalid ${collection} entry.`, {
					issues: parsed.error.issues,
				});
			if (ids.has(value.id))
				throw new AutomationError(
					"DUPLICATE_ID",
					`Duplicate ${collection} ID: ${value.id}`,
				);
			ids.add(value.id);
			if (value.startMs >= value.endMs)
				throw new AutomationError(
					"INVALID_RANGE",
					`${value.id}: startMs must be less than endMs.`,
				);
			if (
				["clipRegions", "trimRegions", "speedRegions", "autoCaptions"].includes(collection)
			) {
				const end =
					collection === "clipRegions"
						? getClipSourceEndMs(value as ClipRegion)
						: value.endMs;
				if (end > sourceDurationMs + 1)
					throw new AutomationError(
						"INVALID_RANGE",
						`${value.id} exceeds source duration.`,
						{ sourceDurationMs },
					);
			}
			if (collection === "autoCaptions") {
				const cue = value as (typeof snapshot.editor.autoCaptions)[number];
				for (const word of cue.words ?? [])
					if (
						word.startMs < cue.startMs ||
						word.endMs > cue.endMs ||
						word.startMs >= word.endMs
					)
						throw new AutomationError(
							"INVALID_RANGE",
							`${value.id}: word timing lies outside its cue.`,
						);
			}
		}
	}
	for (const rect of [snapshot.editor.cropRegion, snapshot.editor.webcam.cropRegion])
		if (rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001)
			throw new AutomationError(
				"INVALID_RANGE",
				"Crop must fit inside normalized source bounds.",
			);
	if (
		snapshot.editor.padding.linked &&
		![
			snapshot.editor.padding.right,
			snapshot.editor.padding.bottom,
			snapshot.editor.padding.left,
		].every((value) => value === snapshot.editor.padding.top)
	)
		throw new AutomationError(
			"INVALID_PARAMS",
			"Linked padding sides must be equal, or set linked:false.",
		);
	if (snapshot.editor.zoomInOverlapMs > snapshot.editor.zoomInDurationMs)
		throw new AutomationError("INVALID_RANGE", "Zoom overlap cannot exceed zoom-in duration.");
	if (snapshot.editor.webcam.enabled && !snapshot.editor.webcam.sourcePath)
		throw new AutomationError("INVALID_PARAMS", "Enable webcam only with a sourcePath.");
}

export function applyEditorOperations(
	current: EditorDocumentSnapshot,
	params: EditorApplyParams,
	sourceDurationMs: number,
): EditorDocumentSnapshot {
	const validated = validateEditorAutomationCommand(
		"editor.apply",
		params,
	) as unknown as EditorApplyParams;
	const next = clone(current);
	let clipsChanged = false;
	for (const operation of validated.operations) {
		if (operation.op === "settings.patch")
			next.editor = merge(
				next.editor as unknown as Record<string, unknown>,
				operation.values as Record<string, unknown>,
			) as unknown as typeof next.editor;
		else if (operation.op === "export.patch")
			next.exportPreferences = { ...next.exportPreferences, ...(operation.values as object) };
		else if (operation.op === "creation.patch")
			next.creationPreferences = merge(
				next.creationPreferences,
				operation.values as Record<string, unknown>,
			) as typeof next.creationPreferences;
		else if (operation.op === "clips.split") {
			splitDocumentClip(
				next,
				operation.id as string,
				operation.atMs as number,
				operation.leftId as string,
				operation.rightId as string,
			);
			clipsChanged = true;
		} else if (operation.op === "clips.speed") {
			const clip = next.editor.clipRegions.find((item) => item.id === operation.id);
			if (!clip)
				throw new AutomationError("ID_NOT_FOUND", `Clip ${operation.id} does not exist.`);
			const previousSpeed = clip.speed;
			const previousEnd = clip.endMs;
			clip.speed = operation.speed as number;
			clip.endMs = Math.round(
				clip.startMs + ((previousEnd - clip.startMs) * previousSpeed) / clip.speed,
			);
			for (const zoom of next.editor.zoomRegions)
				if (zoom.startMs >= clip.startMs && zoom.startMs < previousEnd) {
					zoom.startMs = Math.round(
						clip.startMs + ((zoom.startMs - clip.startMs) * previousSpeed) / clip.speed,
					);
					zoom.endMs = Math.round(
						clip.startMs + ((zoom.endMs - clip.startMs) * previousSpeed) / clip.speed,
					);
				}
			clipsChanged = true;
		} else {
			const collection = operation.collection as EditorCollection;
			const values = next.editor[collection] as unknown as Array<
				Record<string, unknown> & { id: string }
			>;
			const index = values.findIndex((item) => item.id === operation.id);
			if (operation.op === "region.create") {
				const value = operation.value as (typeof values)[number];
				if (values.some((item) => item.id === value.id))
					throw new AutomationError("DUPLICATE_ID", `ID ${value.id} already exists.`);
				values.push(clone(value));
			} else if (operation.op === "collection.replace")
				(next.editor as unknown as Record<string, unknown>)[collection] = clone(
					operation.values,
				);
			else if (operation.op === "collection.reorder") {
				const ids = operation.ids as string[];
				if (
					ids.length !== values.length ||
					new Set(ids).size !== ids.length ||
					ids.some((id) => !values.some((item) => item.id === id))
				)
					throw new AutomationError(
						"INVALID_PARAMS",
						"Reorder must contain every current ID exactly once.",
					);
				(next.editor as unknown as Record<string, unknown>)[collection] = ids.map(
					(id) => values.find((item) => item.id === id)!,
				);
			} else {
				if (index < 0)
					throw new AutomationError(
						"ID_NOT_FOUND",
						`ID ${operation.id} does not exist in ${collection}.`,
					);
				if (operation.op === "region.update") {
					const changes = operation.changes as Record<string, unknown>;
					if (
						collection === "annotationRegions" &&
						values[index].type === "image" &&
						typeof changes.content === "string" &&
						!changes.content.startsWith("data:image/") &&
						changes.imageContent === undefined &&
						changes.type === undefined
					)
						throw new AutomationError(
							"INVALID_PARAMS",
							"Use imageContent when updating an image annotation source so its local file can be approved and embedded.",
						);
					values[index] = merge(values[index], changes) as (typeof values)[number];
				} else if (operation.op === "region.delete") {
					const removed = values[index];
					values.splice(index, 1);
					if (collection === "clipRegions") {
						for (const domain of [
							"zoomRegions",
							"annotationRegions",
							"speedRegions",
							"audioRegions",
						] as const)
							next.editor[domain] = next.editor[domain].filter(
								(item) =>
									item.endMs <= (removed.startMs as number) ||
									item.startMs >= (removed.endMs as number),
							) as never;
						if (next.editor.sourceAudioTrackSettingsByClip)
							delete next.editor.sourceAudioTrackSettingsByClip[removed.id];
					}
				}
			}
			if (collection === "trimRegions") {
				next.editor.clipRegions = trimsToClips(next.editor.trimRegions, sourceDurationMs);
				next.editor.speedRegions = [];
				clipsChanged = true;
			}
			if (collection === "clipRegions") clipsChanged = true;
		}
	}
	if (clipsChanged) {
		next.editor.trimRegions = clipsToTrims(next.editor.clipRegions, sourceDurationMs);
		next.editor.autoFullTrackClipId = null;
		next.editor.autoFullTrackClipEndMs = null;
	}
	validateEditorDocument(next, sourceDurationMs);
	return next;
}

/** One document history serves UI edits and automation, including scene and export controls. */
export class EditorDocumentController {
	private current: EditorDocumentSnapshot | null = null;
	private context = "";
	private past: EditorDocumentSnapshot[] = [];
	private future: EditorDocumentSnapshot[] = [];
	revision = 0;
	reset(): void {
		this.current = null;
		this.past = [];
		this.future = [];
		this.context = "";
		this.revision += 1;
	}
	observe(snapshot: EditorDocumentSnapshot, context: string): void {
		if (!this.current || this.context !== context) {
			this.current = clone(snapshot);
			this.context = context;
			this.past = [];
			this.future = [];
			this.revision += 1;
			return;
		}
		if (stable(this.current) === stable(snapshot)) return;
		this.record(snapshot);
	}
	private record(next: EditorDocumentSnapshot): void {
		if (this.current) this.past.push(clone(this.current));
		if (this.past.length > 100) this.past.shift();
		this.current = clone(next);
		this.future = [];
		this.revision += 1;
	}
	get snapshot(): EditorDocumentSnapshot {
		if (!this.current) throw new AutomationError("MEDIA_NOT_READY", "No document is loaded.");
		return clone(this.current);
	}
	get history() {
		return {
			canUndo: this.past.length > 0,
			canRedo: this.future.length > 0,
			undoEntries: this.past.length,
			redoEntries: this.future.length,
		};
	}
	assertRevision(expectedRevision: number): void {
		if (expectedRevision !== this.revision)
			throw new AutomationError(
				"REVISION_CONFLICT",
				"The editor changed; read editor.get and retry with its revision.",
				{ expectedRevision, actualRevision: this.revision },
			);
	}
	apply(params: EditorApplyParams, durationMs: number): EditorDocumentSnapshot {
		this.assertRevision(params.expectedRevision);
		const next = applyEditorOperations(this.snapshot, params, durationMs);
		if (stable(this.current) !== stable(next)) this.record(next);
		return this.snapshot;
	}
	undo(expectedRevision: number): EditorDocumentSnapshot {
		this.assertRevision(expectedRevision);
		const previous = this.past.pop();
		if (!previous)
			throw new AutomationError("NOTHING_TO_UNDO", "No document change can be undone.");
		this.future.push(this.snapshot);
		this.current = previous;
		this.revision += 1;
		return this.snapshot;
	}
	redo(expectedRevision: number): EditorDocumentSnapshot {
		this.assertRevision(expectedRevision);
		const next = this.future.pop();
		if (!next)
			throw new AutomationError("NOTHING_TO_REDO", "No document change can be redone.");
		this.past.push(this.snapshot);
		this.current = next;
		this.revision += 1;
		return this.snapshot;
	}
}
