import { describe, expect, it } from "vitest";
import { DEFAULT_SHORTCUTS } from "../lib/shortcuts";
import {
	applyShortcutPatch,
	validateExtensionSetting,
	validateFontImport,
} from "./systemRendererValidation";

describe("system renderer validation", () => {
	it("rejects shortcut conflicts atomically while preserving unmodified bindings", () => {
		expect(() => applyShortcutPatch(DEFAULT_SHORTCUTS, { splitClip: { key: "z" } })).toThrow();
		expect(DEFAULT_SHORTCUTS.splitClip.key).toBe("c");
		expect(() =>
			applyShortcutPatch(DEFAULT_SHORTCUTS, { splitClip: { key: "tab" } }),
		).toThrow();
		expect(
			applyShortcutPatch(DEFAULT_SHORTCUTS, { splitClip: { key: "s", ctrl: true } }),
		).toMatchObject({
			splitClip: { key: "s", ctrl: true },
			addZoom: DEFAULT_SHORTCUTS.addZoom,
		});
	});
	it("accepts only Google CSS imports and rejects CSS injection or credentials", () => {
		expect(() =>
			validateFontImport(
				"https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap",
			),
		).not.toThrow();
		for (const url of [
			"http://fonts.googleapis.com/css?family=X",
			"https://evil.example/css?family=X",
			"https://user:secret@fonts.googleapis.com/css?family=X",
			"https://fonts.googleapis.com/css?family=X');body{color:red}",
			"https://fonts.googleapis.com/other?family=X",
		])
			expect(() => validateFontImport(url)).toThrow();
	});
	it("validates declared extension types and slider bounds/steps instead of coercing", () => {
		const slider = {
			id: "amount",
			label: "Amount",
			type: "slider" as const,
			defaultValue: 0,
			min: 0,
			max: 1,
			step: 0.1,
		};
		expect(() => validateExtensionSetting(slider, 0.3)).not.toThrow();
		for (const value of ["0.3", -1, 2, Infinity, 0.35])
			expect(() => validateExtensionSetting(slider, value)).toThrow();
		expect(() =>
			validateExtensionSetting(
				{ id: "on", label: "On", type: "toggle", defaultValue: false },
				"true",
			),
		).toThrow();
		expect(() =>
			validateExtensionSetting(
				{
					id: "mode",
					label: "Mode",
					type: "select",
					defaultValue: "a",
					options: [{ label: "A", value: "a" }],
				},
				"b",
			),
		).toThrow();
	});
});
