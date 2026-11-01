import { describe, expect, it } from "vitest";
import type { EditorDocumentSnapshot } from "../../../../shared/editorAutomation";
import {
	collectEditorAutomationMediaPaths,
	EDITOR_AUTOMATION_COMMANDS,
	validateEditorAutomationCommand,
} from "../../../../shared/editorAutomation";
import { normalizeProjectEditor } from "../projectPersistence";
import { getClipSourceEndMs } from "../types";
import { EditorDocumentController, validateEditorDocument } from "./editorDocument";

function document(): EditorDocumentSnapshot {
	return {
		editor: normalizeProjectEditor({
			clipRegions: [{ id: "clip-1", startMs: 0, endMs: 6000, speed: 1 }],
		}),
		exportPreferences: {
			exportTransparentBackground: false,
			exportAlphaSafeCanvas: false,
			exportAlphaSafeCanvasScale: 1.5,
			exportAlphaFormat: "mov",
		},
		creationPreferences: {
			autoApplyFreshRecordingAutoZooms: false,
			defaultZoomDurationMs: 4000,
			defaultZoomMode: "auto",
			lastManualZoomFocus: { cx: 0.5, cy: 0.5 },
		},
	};
}
function controller(snapshot = document()) {
	const value = new EditorDocumentController();
	value.observe(snapshot, "video-1");
	return value;
}

describe("strict atomic editor document operations", () => {
	it("publishes discoverable preset union fields while retaining strict per-action requirements", () => {
		const schema = EDITOR_AUTOMATION_COMMANDS.find(
			(command) => command.name === "editor.presets",
		)!.inputSchema;
		expect(schema.additionalProperties).toBe(false);
		expect(Object.keys(schema.properties)).toEqual([
			"action",
			"id",
			"name",
			"expectedRevision",
			"expectedDocumentId",
		]);
		expect(schema.anyOf).toHaveLength(5);
		expect(
			validateEditorAutomationCommand("editor.presets", {
				action: "apply",
				id: "preset-1",
				expectedRevision: 3,
			}),
		).toMatchObject({ id: "preset-1" });
		expect(() =>
			validateEditorAutomationCommand("editor.presets", { action: "apply", id: "preset-1" }),
		).toThrow();
		expect(() =>
			validateEditorAutomationCommand("editor.presets", { action: "list", id: "preset-1" }),
		).toThrow();
	});
	it("accepts bounded document identity only on document mutation commands while retaining required revision", () => {
		const documentId = "6a265b71-3d35-43dd-b3ac-8f198c48ccef:4";
		const requests: Array<[string, Record<string, unknown>]> = [
			[
				"editor.apply",
				{ operations: [{ op: "settings.patch", values: { borderRadius: 24 } }] },
			],
			["editor.undo", {}],
			["editor.redo", {}],
			["editor.autoZoom", { replace: true }],
			["editor.presets", { action: "save", name: "Presentation" }],
			["editor.presets", { action: "apply", id: "preset-1" }],
		];
		for (const [method, params] of requests) {
			expect(
				validateEditorAutomationCommand(method, {
					...params,
					expectedRevision: 4,
					expectedDocumentId: documentId,
				}),
			).toMatchObject({ expectedDocumentId: documentId });
			expect(() =>
				validateEditorAutomationCommand(method, {
					...params,
					expectedDocumentId: documentId,
				}),
			).toThrow();
			for (const invalidId of ["", "a".repeat(257), 4, null])
				expect(() =>
					validateEditorAutomationCommand(method, {
						...params,
						expectedRevision: 4,
						expectedDocumentId: invalidId,
					}),
				).toThrow();
		}
		for (const [method, params] of [
			["editor.get", {}],
			["editor.catalogs", {}],
			["preview.control", { action: "status" }],
			["editor.presets", { action: "list" }],
			["editor.presets", { action: "get", id: "preset-1" }],
			["editor.presets", { action: "delete", id: "preset-1" }],
		] as const)
			expect(() =>
				validateEditorAutomationCommand(method, {
					...params,
					expectedDocumentId: documentId,
				}),
			).toThrow();
	});

	it("validates preview actions before invoking playback and accepts explicit null selection", () => {
		for (const params of [
			{ action: "seek" },
			{ action: "play", timeMs: 10 },
			{ action: "select", collection: "clipRegions" },
		])
			expect(() => validateEditorAutomationCommand("preview.control", params)).toThrow();
		expect(
			validateEditorAutomationCommand("preview.control", {
				action: "select",
				collection: "clipRegions",
				id: null,
			}),
		).toMatchObject({ id: null });
	});
	it("merges partial nested region settings atomically without resetting existing fields", () => {
		const initial = document();
		initial.editor.zoomRegions = [
			{ id: "zoom-1", startMs: 500, endMs: 1500, depth: 2, focus: { cx: 0.5, cy: 0.7 } },
		];
		const value = controller(initial);
		const next = value.apply(
			{
				expectedRevision: value.revision,
				operations: [
					{
						op: "region.update",
						collection: "zoomRegions",
						id: "zoom-1",
						changes: { focus: { cx: 0.2 } },
					},
				],
			},
			6000,
		);
		expect(next.editor.zoomRegions[0].focus).toEqual({ cx: 0.2, cy: 0.7 });
	});

	it("accepts existing normalized defaults without coercion", () => {
		expect(() => validateEditorDocument(document(), 6000)).not.toThrow();
	});
	it("rejects an entire batch when its last operation is invalid, leaving revision/history untouched", () => {
		const value = controller();
		const original = value.snapshot;
		const revision = value.revision;
		expect(() =>
			value.apply(
				{
					expectedRevision: revision,
					operations: [
						{ op: "settings.patch", values: { borderRadius: 32 } },
						{
							op: "region.update",
							collection: "clipRegions",
							id: "clip-1",
							changes: { endMs: 8000 },
						},
					],
				},
				6000,
			),
		).toThrowError(expect.objectContaining({ code: "INVALID_RANGE" }));
		expect(value.snapshot).toEqual(original);
		expect(value.revision).toBe(revision);
		expect(value.history.undoEntries).toBe(0);
	});
	it.each([
		{ op: "settings.patch", values: { borderRadius: "24" } },
		{ op: "settings.patch", values: { padding: { typo: 20 } } },
		{ op: "settings.patch", values: { cursorSpringMassMultiplier: -1 } },
		{ op: "export.patch", values: { exportAlphaFormat: "mp4" } },
	])("rejects malformed external values before normalization: %j", (operation) => {
		const value = controller();
		expect(() =>
			value.apply({ expectedRevision: value.revision, operations: [operation] }, 6000),
		).toThrowError(expect.objectContaining({ code: "INVALID_PARAMS" }));
		expect(value.history.undoEntries).toBe(0);
	});
	it("rejects unknown/duplicate IDs and incomplete reorders", () => {
		const value = controller();
		const revision = value.revision;
		expect(() =>
			value.apply(
				{
					expectedRevision: revision,
					operations: [{ op: "region.delete", collection: "clipRegions", id: "missing" }],
				},
				6000,
			),
		).toThrowError(expect.objectContaining({ code: "ID_NOT_FOUND" }));
		expect(() =>
			value.apply(
				{
					expectedRevision: revision,
					operations: [
						{
							op: "region.create",
							collection: "clipRegions",
							value: { id: "clip-1", startMs: 0, endMs: 2000, speed: 1 },
						},
					],
				},
				6000,
			),
		).toThrowError(expect.objectContaining({ code: "DUPLICATE_ID" }));
		expect(() =>
			value.apply(
				{
					expectedRevision: revision,
					operations: [{ op: "collection.reorder", collection: "clipRegions", ids: [] }],
				},
				6000,
			),
		).toThrow();
	});
	it("checks crop, range and caption word cross-field constraints", () => {
		const value = controller();
		const revision = value.revision;
		expect(() =>
			value.apply(
				{
					expectedRevision: revision,
					operations: [
						{ op: "settings.patch", values: { cropRegion: { x: 0.8, width: 0.4 } } },
					],
				},
				6000,
			),
		).toThrowError(expect.objectContaining({ code: "INVALID_RANGE" }));
		expect(() =>
			value.apply(
				{
					expectedRevision: revision,
					operations: [
						{
							op: "collection.replace",
							collection: "autoCaptions",
							values: [
								{
									id: "cue-1",
									startMs: 1000,
									endMs: 2000,
									text: "Hello",
									words: [{ text: "Hello", startMs: 1000, endMs: 2100 }],
								},
							],
						},
					],
				},
				6000,
			),
		).toThrowError(expect.objectContaining({ code: "INVALID_RANGE" }));
	});
	it("rejects prototype properties without polluting ordinary objects", () => {
		const value = controller();
		const operation = JSON.parse(
			'{"op":"settings.patch","values":{"__proto__":{"polluted":true}}}',
		);
		expect(() =>
			value.apply({ expectedRevision: value.revision, operations: [operation] }, 6000),
		).toThrow();
		expect({}).not.toHaveProperty("polluted");
	});
});

describe("shared full-document history and revision conflicts", () => {
	it("reverses one atomic scene/webcam/caption/audio/export/default batch in one undo", () => {
		const value = controller();
		const before = value.snapshot;
		const after = value.apply(
			{
				expectedRevision: value.revision,
				operations: [
					{
						op: "settings.patch",
						values: {
							wallpaper: "#123456",
							borderRadius: 40,
							cropRegion: { x: 0.1, width: 0.8 },
							webcam: {
								enabled: true,
								sourcePath: "/tmp/camera.mov",
								timeOffsetMs: -120,
								mirror: false,
							},
							autoCaptionSettings: { textColor: "#ffaa00", fontFamily: "Georgia" },
							defaultSourceAudioTrackSettings: {
								mixed: { volume: 0.4, normalize: true },
							},
						},
					},
					{
						op: "collection.replace",
						collection: "autoCaptions",
						values: [{ id: "cue-1", startMs: 1000, endMs: 2000, text: "Hello" }],
					},
					{
						op: "export.patch",
						values: { exportTransparentBackground: true, exportAlphaFormat: "webm" },
					},
					{
						op: "creation.patch",
						values: { defaultZoomMode: "manual", defaultZoomDurationMs: 2500 },
					},
				],
			},
			6000,
		);
		expect(value.history.undoEntries).toBe(1);
		expect(value.undo(value.revision)).toEqual(before);
		expect(value.redo(value.revision)).toEqual(after);
	});
	it("manual UI observations invalidate stale requests and preserve the user's changes", () => {
		const value = controller();
		const revision = value.revision;
		const manual = value.snapshot;
		manual.editor.shadowIntensity = 0.2;
		value.observe(manual, "video-1");
		expect(() =>
			value.apply(
				{
					expectedRevision: revision,
					operations: [{ op: "settings.patch", values: { borderRadius: 40 } }],
				},
				6000,
			),
		).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
		expect(value.snapshot.editor.shadowIntensity).toBe(0.2);
		expect(value.undo(value.revision).editor.shadowIntensity).toBe(
			document().editor.shadowIntensity,
		);
	});
	it("changing projects resets undo while retaining monotonic revisions", () => {
		const value = controller();
		value.apply(
			{
				expectedRevision: value.revision,
				operations: [{ op: "settings.patch", values: { borderRadius: 40 } }],
			},
			6000,
		);
		const previous = value.revision;
		value.observe(document(), "video-2");
		expect(value.revision).toBeGreaterThan(previous);
		expect(value.history.canUndo).toBe(false);
	});
});

describe("clip media continuity", () => {
	it("splits a fast clip without losing/duplicating source time or audio settings", () => {
		const snapshot = document();
		snapshot.editor.clipRegions = [
			{ id: "clip-1", startMs: 0, endMs: 3000, speed: 2, muted: true, showSourceAudio: true },
		];
		snapshot.editor.sourceAudioTrackSettingsByClip = {
			"clip-1": { mic: { volume: 0.4, normalize: true } },
		};
		const value = controller(snapshot);
		const after = value.apply(
			{
				expectedRevision: value.revision,
				operations: [
					{
						op: "clips.split",
						id: "clip-1",
						atMs: 1500,
						leftId: "left",
						rightId: "right",
					},
				],
			},
			6000,
		);
		const [left, right] = after.editor.clipRegions;
		expect(left.endMs).toBe(1500);
		expect(right.startMs).toBe(getClipSourceEndMs(left));
		expect(getClipSourceEndMs(right)).toBe(6000);
		expect(left.showSourceAudio && right.showSourceAudio && left.muted && right.muted).toBe(
			true,
		);
		expect(after.editor.sourceAudioTrackSettingsByClip?.left).toEqual(
			after.editor.sourceAudioTrackSettingsByClip?.right,
		);
		expect(after.editor.sourceAudioTrackSettingsByClip).not.toHaveProperty("clip-1");
	});
	it("speed changes preserve source extent and scale in-clip zoom spans", () => {
		const snapshot = document();
		snapshot.editor.zoomRegions = [
			{ id: "zoom-1", startMs: 1000, endMs: 2000, depth: 2, focus: { cx: 0.5, cy: 0.5 } },
		];
		const value = controller(snapshot);
		const after = value.apply(
			{
				expectedRevision: value.revision,
				operations: [{ op: "clips.speed", id: "clip-1", speed: 2 }],
			},
			6000,
		);
		expect(getClipSourceEndMs(after.editor.clipRegions[0])).toBe(6000);
		expect(after.editor.clipRegions[0].endMs).toBe(3000);
		expect(after.editor.zoomRegions[0]).toMatchObject({ startMs: 500, endMs: 1000 });
	});
});

describe("editor command discovery and media preflight", () => {
	it("publishes strict schemas and collects only explicit local media references", () => {
		expect(EDITOR_AUTOMATION_COMMANDS.map((command) => command.name)).toContain("editor.apply");
		expect(
			collectEditorAutomationMediaPaths({
				operations: [
					{
						op: "settings.patch",
						values: { wallpaper: "#123456", webcam: { sourcePath: "/tmp/camera.mov" } },
					},
					{
						op: "region.create",
						collection: "audioRegions",
						value: { audioPath: "file:///tmp/voice.wav" },
					},
				],
			}),
		).toEqual(["/tmp/camera.mov", "/tmp/voice.wav"]);
		expect(() =>
			validateEditorAutomationCommand("editor.apply", {
				expectedRevision: 1,
				operations: [
					{
						op: "settings.patch",
						values: { wallpaper: "https://example.com/private.png" },
					},
				],
			}),
		).toThrow();
	});
});
