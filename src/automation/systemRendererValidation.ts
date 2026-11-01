import { AutomationError } from "../../shared/automation";
import { type ExtensionSettingField } from "../lib/extensions/types";
import { findConflict, SHORTCUT_ACTIONS, type ShortcutsConfig } from "../lib/shortcuts";

export function validateFontImport(value: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AutomationError("INVALID_PARAMS", "Invalid font stylesheet URL.");
	}
	if (
		Array.from(value).some((char) => char.charCodeAt(0) <= 32) ||
		/['"\\]/.test(value) ||
		url.protocol !== "https:" ||
		url.hostname !== "fonts.googleapis.com" ||
		url.port ||
		url.username ||
		url.password ||
		!/^\/css2?$/.test(url.pathname) ||
		!url.searchParams.get("family")
	) {
		throw new AutomationError(
			"INVALID_PARAMS",
			"Only an HTTPS Google Fonts CSS/CSS2 stylesheet with a family is accepted.",
		);
	}
}

export function applyShortcutPatch(current: ShortcutsConfig, patch: Partial<ShortcutsConfig>) {
	const next = { ...current, ...patch };
	for (const action of SHORTCUT_ACTIONS) {
		const conflict = findConflict(next[action], action, next);
		if (conflict)
			throw new AutomationError(
				"SHORTCUT_CONFLICT",
				`Shortcut ${action} conflicts with ${conflict.type === "fixed" ? conflict.label : conflict.action}.`,
			);
	}
	return next;
}

export function validateExtensionSetting(field: ExtensionSettingField, value: unknown) {
	let valid = false;
	switch (field.type) {
		case "toggle":
			valid = typeof value === "boolean";
			break;
		case "slider": {
			valid =
				typeof value === "number" &&
				Number.isFinite(value) &&
				value >= (field.min ?? -Number.MAX_VALUE) &&
				value <= (field.max ?? Number.MAX_VALUE);
			if (valid && field.step && typeof value === "number") {
				const steps = (value - (field.min ?? 0)) / field.step;
				valid = Math.abs(steps - Math.round(steps)) < 1e-7;
			}
			break;
		}
		case "select":
			valid =
				typeof value === "string" &&
				Boolean(field.options?.some((item) => item.value === value));
			break;
		case "color":
			valid =
				typeof value === "string" &&
				value.length <= 128 &&
				/^(#[0-9a-f]{3,8}|[a-z]+|(?:rgba?|hsla?)\([\d.% ,+/-]+\))$/i.test(value);
			break;
		case "text":
			valid = typeof value === "string" && value.length <= 4096 && !value.includes("\0");
			break;
	}
	if (!valid)
		throw new AutomationError(
			"INVALID_PARAMS",
			`Invalid value for extension setting ${field.id} (${field.type}).`,
		);
}
