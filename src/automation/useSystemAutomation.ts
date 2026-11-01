import { useEffect, useRef } from "react";
import { AutomationError } from "../../shared/automation";
import {
	isSystemAutomationCommand,
	parseSystemAutomationParams,
} from "../../shared/systemAutomation";
import {
	loadEditorPreferences,
	saveEditorPreferences,
} from "../components/video-editor/editorPreferences";
import { toFileUrl } from "../components/video-editor/projectPersistence";
import { useI18n } from "../contexts/I18nContext";
import { useShortcuts } from "../contexts/ShortcutsContext";
import { useTheme } from "../contexts/ThemeContext";
import { type AppLocale, SUPPORTED_LOCALES } from "../i18n/config";
import {
	addCustomFont,
	generateFontId,
	getCustomFonts,
	loadAllCustomFonts,
	removeCustomFont,
} from "../lib/customFonts";
import { extensionHost } from "../lib/extensions";
import type { ExtensionInfo } from "../lib/extensions/types";
import { FIXED_SHORTCUTS, type ShortcutsConfig } from "../lib/shortcuts";
import { getAvailableWallpapers } from "../lib/wallpapers";
import {
	applyShortcutPatch,
	validateExtensionSetting,
	validateFontImport,
} from "./systemRendererValidation";

const SETTINGS_EVENT = "screendance:automation-settings";
const SHORTCUT_STORAGE = "screendance.automation.shortcuts";
export const ASSETS_CHANGED_EVENT = "screendance:assets-changed";

/** One narrow provider-backed system adapter in each renderer; never evaluates caller code. */
export function useSystemAutomation() {
	const theme = useTheme();
	const locale = useI18n();
	const shortcuts = useShortcuts();
	const latest = useRef({ theme, locale, shortcuts });
	latest.current = { theme, locale, shortcuts };
	const handling = useRef(false);
	useEffect(() => {
		let extensionSync: Promise<void> = Promise.resolve();
		const synchronizeExtensions = (extensions: ExtensionInfo[]) => {
			extensionSync = extensionSync
				.catch(() => undefined)
				.then(async () => {
					await extensionHost.autoActivateBuiltins();
					await extensionHost.syncConfiguredExtensions(extensions);
				});
			return extensionSync;
		};
		const onSettings = (event: Event) => {
			const detail = (event as CustomEvent).detail as {
				theme?: "light" | "dark" | "system";
				locale?: AppLocale;
			};
			if (detail.theme) latest.current.theme.setPreference(detail.theme);
			if (detail.locale) latest.current.locale.setLocale(detail.locale);
		};
		const onStorage = (event: StorageEvent) => {
			if (
				event.key === "recordly.theme" &&
				["light", "dark", "system"].includes(event.newValue ?? "")
			)
				latest.current.theme.setPreference(event.newValue as "light" | "dark" | "system");
			if (
				event.key === "recordly.locale" &&
				(SUPPORTED_LOCALES as readonly string[]).includes(event.newValue ?? "")
			)
				latest.current.locale.setLocale(event.newValue as AppLocale);
			if (event.key === SHORTCUT_STORAGE && event.newValue) {
				try {
					const parsed = parseSystemAutomationParams(
						"shortcuts.set",
						JSON.parse(event.newValue),
					);
					latest.current.shortcuts.setShortcuts(
						applyShortcutPatch(
							latest.current.shortcuts.shortcuts,
							parsed.bindings as Partial<ShortcutsConfig>,
						),
					);
				} catch {
					/* Ignore corrupt unrelated storage messages. */
				}
			}
			if (event.key === "recordly_custom_fonts")
				void loadAllCustomFonts().catch(() => {
					/* Individual font failures are already reported by the font loader. */
				});
			if (
				event.key === "recordly_custom_fonts" ||
				event.key === "recordly.editor.preferences"
			)
				window.dispatchEvent(new CustomEvent(ASSETS_CHANGED_EVENT));
		};
		window.addEventListener(SETTINGS_EVENT, onSettings);
		window.addEventListener("storage", onStorage);
		const cleanupSync = window.electronAPI.onSystemAutomationSync((payload) => {
			void (async () => {
				try {
					if (payload.settings) {
						const settings = parseSystemAutomationParams(
							"settings.set",
							payload.settings,
						);
						window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: settings }));
					}
					if (typeof payload.hudCaptureProtection === "boolean")
						window.dispatchEvent(
							new CustomEvent("screendance:hud-settings", {
								detail: { captureProtection: payload.hudCaptureProtection },
							}),
						);
					if (payload.shortcuts) {
						const params = parseSystemAutomationParams("shortcuts.set", {
							bindings: payload.shortcuts,
						});
						latest.current.shortcuts.setShortcuts(
							applyShortcutPatch(
								latest.current.shortcuts.shortcuts,
								params.bindings as Partial<ShortcutsConfig>,
							),
						);
					}
					if (Array.isArray(payload.extensions))
						await synchronizeExtensions(payload.extensions as ExtensionInfo[]);
					if (payload.extensionSetting) {
						const setting = parseSystemAutomationParams(
							"extensions.settings.set",
							payload.extensionSetting,
						);
						if (
							JSON.stringify(
								extensionHost.getExtensionSetting(
									setting.id as string,
									setting.settingId as string,
								),
							) !== JSON.stringify(setting.value)
						)
							extensionHost.setExtensionSetting(
								setting.id as string,
								setting.settingId as string,
								setting.value,
							);
					}
					if (payload.assetsChanged) {
						await loadAllCustomFonts();
						window.dispatchEvent(new CustomEvent(ASSETS_CHANGED_EVENT));
					}
				} catch (error) {
					console.warn("Could not synchronize application settings:", error);
				}
			})();
		});
		const cleanup = window.electronAPI.onSystemAutomationRequest((request) => {
			void (async () => {
				if (handling.current) {
					window.electronAPI.sendAutomationResponse({
						id: request.id,
						error: { code: "BUSY", message: "Another system command is running." },
					});
					return;
				}
				handling.current = true;
				try {
					let params: Record<string, unknown>;
					if ((request.method as string) === "extensions.sync") params = request.params;
					else {
						if (!isSystemAutomationCommand(request.method))
							throw new AutomationError(
								"UNKNOWN_COMMAND",
								"Unknown renderer system command.",
							);
						try {
							params = parseSystemAutomationParams(request.method, request.params);
						} catch {
							throw new AutomationError(
								"INVALID_PARAMS",
								"Invalid system command parameters.",
							);
						}
					}
					let result: unknown;
					const current = latest.current;
					switch (request.method as string) {
						case "settings.get":
							result = {
								theme: current.theme.preference,
								resolvedTheme: current.theme.theme,
								locale: current.locale.locale,
								supportedLocales: SUPPORTED_LOCALES,
							};
							break;
						case "settings.set": {
							window.dispatchEvent(
								new CustomEvent(SETTINGS_EVENT, { detail: params }),
							);
							result = {
								theme: params.theme ?? current.theme.preference,
								locale: params.locale ?? current.locale.locale,
							};
							break;
						}
						case "shortcuts.get":
							result = {
								bindings: current.shortcuts.shortcuts,
								fixed: FIXED_SHORTCUTS,
							};
							break;
						case "shortcuts.set": {
							const config = applyShortcutPatch(
								current.shortcuts.shortcuts,
								params.bindings as Partial<ShortcutsConfig>,
							);
							const response = await window.electronAPI.saveShortcuts(config);
							if (!response.success)
								throw new AutomationError(
									"SAVE_FAILED",
									"Could not save shortcuts.",
								);
							current.shortcuts.setShortcuts(config);
							localStorage.setItem(
								SHORTCUT_STORAGE,
								JSON.stringify({ bindings: config }),
							);
							result = { bindings: config };
							break;
						}
						case "fonts.list":
							result = { fonts: getCustomFonts() };
							break;
						case "fonts.add": {
							validateFontImport(params.importUrl as string);
							const fonts = await addCustomFont({
								id: generateFontId(params.name as string),
								name: params.name as string,
								fontFamily: params.fontFamily as string,
								importUrl: params.importUrl as string,
							});
							if (JSON.stringify(getCustomFonts()) !== JSON.stringify(fonts))
								throw new AutomationError(
									"SAVE_FAILED",
									"Could not persist the font registration.",
								);
							result = { fonts };
							window.dispatchEvent(new CustomEvent(ASSETS_CHANGED_EVENT));
							break;
						}
						case "fonts.remove": {
							if (!getCustomFonts().some((font) => font.id === params.id))
								throw new AutomationError(
									"NOT_FOUND",
									"Custom font is not registered.",
								);
							const fonts = removeCustomFont(params.id as string);
							if (JSON.stringify(getCustomFonts()) !== JSON.stringify(fonts))
								throw new AutomationError(
									"SAVE_FAILED",
									"Could not persist font removal.",
								);
							result = { fonts };
							window.dispatchEvent(new CustomEvent(ASSETS_CHANGED_EVENT));
							break;
						}
						case "wallpapers.list":
							result = {
								builtin: await getAvailableWallpapers(),
								custom: loadEditorPreferences().customWallpapers,
								extensions: extensionHost.getContributedWallpapers(),
							};
							break;
						case "wallpapers.add":
						case "wallpapers.remove": {
							const value = (params.path as string).startsWith("file:")
								? (params.path as string)
								: toFileUrl(params.path as string);
							const custom = loadEditorPreferences().customWallpapers;
							const next =
								request.method === "wallpapers.add"
									? [...new Set([...custom, value])]
									: custom.filter(
											(item) => item !== value && item !== params.path,
										);
							saveEditorPreferences({ customWallpapers: next });
							if (
								JSON.stringify(loadEditorPreferences().customWallpapers) !==
								JSON.stringify(next)
							)
								throw new AutomationError(
									"SAVE_FAILED",
									"Could not save custom wallpapers.",
								);
							window.dispatchEvent(new CustomEvent(ASSETS_CHANGED_EVENT));
							result = { custom: next };
							break;
						}
						case "extensions.sync": {
							await synchronizeExtensions(params.extensions as ExtensionInfo[]);
							result = {
								activeExtensions: extensionHost
									.getActiveExtensions()
									.map((item) => item.manifest.id),
							};
							break;
						}
						case "extensions.settings.get":
						case "extensions.settings.set": {
							await extensionHost.autoActivateBuiltins();
							await extensionSync;
							const panels = extensionHost
								.getSettingsPanels()
								.filter((item) => item.extensionId === params.id);
							const fields = panels.flatMap((item) => item.panel.fields);
							if (request.method === "extensions.settings.set") {
								const field = fields.find((item) => item.id === params.settingId);
								if (!field)
									throw new AutomationError(
										"NOT_FOUND",
										"Enable the extension and use one of its declared setting fields.",
									);
								validateExtensionSetting(field, params.value);
								extensionHost.setExtensionSetting(
									params.id as string,
									field.id,
									params.value,
								);
							}
							result = {
								id: params.id,
								panels,
								values: Object.fromEntries(
									fields.map((field) => [
										field.id,
										extensionHost.getExtensionSetting(
											params.id as string,
											field.id,
										) ?? field.defaultValue,
									]),
								),
							};
							break;
						}
						default:
							throw new AutomationError(
								"UNKNOWN_COMMAND",
								"System command does not belong to the renderer.",
							);
					}
					window.electronAPI.sendAutomationResponse({ id: request.id, result });
				} catch (error) {
					window.electronAPI.sendAutomationResponse({
						id: request.id,
						error: {
							code: error instanceof AutomationError ? error.code : "SYSTEM_ERROR",
							message: error instanceof Error ? error.message : String(error),
						},
					});
				} finally {
					handling.current = false;
				}
			})();
		});
		window.electronAPI.automationSystemReady();
		return () => {
			cleanup();
			cleanupSync();
			window.removeEventListener(SETTINGS_EVENT, onSettings);
			window.removeEventListener("storage", onStorage);
		};
	}, []);
}
