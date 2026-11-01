import { describe, expect, it } from "vitest";
import { hasUnsavedProjectChanges } from "../projectDirtyState";
import { type EditorProjectData, normalizeProjectEditor } from "../projectPersistence";
import { clipsToTrims } from "../types";
import { applyDiscoveredAudioDefaults, prepareAutomationProject } from "./prepareProject";

const minimal: EditorProjectData = {
	version: 1,
	projectId: "automation-smoke",
	videoPath: "/source.mp4",
	editor: {
		aspectRatio: "9:16",
		wallpaper: "#315efb",
		padding: { top: 48, left: 48, right: 48, bottom: 48 },
		borderRadius: 24,
		showCursor: false,
	},
};

describe("automation project preparation", () => {
	it("materializes duration-dependent clips before taking the saved baseline", () => {
		const prepared = prepareAutomationProject(minimal, 3000);
		expect(prepared.editor.clipRegions).toMatchObject([
			{ id: "clip-1", startMs: 0, endMs: 3000, speed: 1 },
		]);
		const hydrated = {
			...prepared,
			editor: {
				...prepared.editor,
				trimRegions: clipsToTrims(prepared.editor.clipRegions!, 3000),
			},
		};
		expect(hasUnsavedProjectChanges(hydrated, prepared)).toBe(false);
		expect(
			hasUnsavedProjectChanges(
				{ ...hydrated, editor: { ...hydrated.editor, wallpaper: "#ffffff" } },
				prepared,
			),
		).toBe(true);
		expect(minimal.editor.clipRegions).toBeUndefined();
	});

	it("performs legacy trim migration without retaining hidden speed regions", () => {
		const prepared = prepareAutomationProject(
			{
				...minimal,
				editor: {
					...minimal.editor,
					trimRegions: [{ id: "trim-1", startMs: 0, endMs: 500 }],
					speedRegions: [{ id: "speed-1", startMs: 1000, endMs: 2000, speed: 2 }],
				},
			},
			3000,
		);
		expect(prepared.editor.clipRegions?.[0].startMs).toBe(500);
		expect(prepared.editor.speedRegions).toEqual([]);
	});

	it("preserves explicit edited clips and is idempotent", () => {
		const project = {
			...minimal,
			editor: {
				...normalizeProjectEditor(minimal.editor),
				clipRegions: [{ id: "kept", startMs: 300, endMs: 1400, speed: 2 }],
			},
		};
		const prepared = prepareAutomationProject(project, 3000);
		expect(prepared.editor.clipRegions).toMatchObject(project.editor.clipRegions);
		expect(prepareAutomationProject(prepared, 3000)).toEqual(prepared);
		expect(() => prepareAutomationProject(minimal, Infinity)).toThrow();
	});

	it("retains an authored legacy trim covering the entire source", () => {
		const trimRegions = [{ id: "trim-all", startMs: 0, endMs: 3000 }];
		const prepared = prepareAutomationProject(
			{ ...minimal, editor: { ...minimal.editor, trimRegions } },
			3000,
		);
		expect(prepared.editor.clipRegions).toEqual([]);
		expect(prepared.editor.trimRegions).toEqual(trimRegions);
		expect(prepareAutomationProject(prepared, 3000)).toEqual(prepared);
	});
});

describe("discovered audio defaults", () => {
	it("adds only discovered defaults to the saved baseline without hiding authored edits", () => {
		const saved = prepareAutomationProject(
			{
				...minimal,
				editor: {
					...minimal.editor,
					defaultSourceAudioTrackSettings: { mixed: { volume: 0.5, normalize: true } },
				},
			},
			3000,
		);
		const hydrated = applyDiscoveredAudioDefaults(saved, "/source.mp4", ["mixed", "mic"])!;
		expect(hydrated.editor.defaultSourceAudioTrackSettings).toEqual({
			mixed: { volume: 0.5, normalize: true },
			mic: { volume: 1, normalize: false },
		});
		expect(applyDiscoveredAudioDefaults(hydrated, "/source.mp4", ["mixed", "mic"])).toBe(
			hydrated,
		);
		const current = {
			...hydrated,
			editor: {
				...hydrated.editor,
				defaultSourceAudioTrackSettings: {
					mixed: { volume: 0.8, normalize: true },
					mic: { volume: 1, normalize: false },
				},
			},
		};
		expect(hasUnsavedProjectChanges(current, hydrated)).toBe(true);
		expect(hasUnsavedProjectChanges(hydrated, hydrated)).toBe(false);
	});

	it("ignores callbacks from other sources and keeps disappearing authored settings visible", () => {
		const saved = prepareAutomationProject(
			{
				...minimal,
				editor: {
					...minimal.editor,
					defaultSourceAudioTrackSettings: { mic: { volume: 0.5, normalize: true } },
				},
			},
			3000,
		);
		expect(applyDiscoveredAudioDefaults(saved, "/old-source.mp4", ["mixed"])).toBe(saved);
		expect(
			applyDiscoveredAudioDefaults(saved, "/source.mp4", [])?.editor
				.defaultSourceAudioTrackSettings,
		).toEqual({ mic: { volume: 0.5, normalize: true } });
		const cleared = {
			...saved,
			editor: { ...saved.editor, defaultSourceAudioTrackSettings: {} },
		};
		expect(
			hasUnsavedProjectChanges(
				cleared,
				applyDiscoveredAudioDefaults(saved, "/source.mp4", []),
			),
		).toBe(true);
	});
});
