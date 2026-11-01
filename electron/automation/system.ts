import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, clipboard, shell } from "electron";
import { AutomationError } from "../../shared/automation";
import {
	isSystemAutomationCommand,
	parseSystemAutomationParams,
	SYSTEM_AUTOMATION_COMMANDS,
} from "../../shared/systemAutomation";
import { USER_DATA_PATH } from "../appPaths";
import {
	discoverExtensions,
	getExtension,
	getExtensionsDirectory,
	getRegisteredExtensions,
	installExtensionFromPath,
	setExtensionStatus,
	uninstallExtension,
} from "../extensions/extensionLoader";
import {
	downloadAndInstallExtension,
	getMarketplaceExtension,
	searchMarketplace,
} from "../extensions/extensionMarketplace";
import { clearAppLogs, getLogFilePath } from "../ipc/logging";
import {
	getProjectsDir,
	persistRecordingsDirectorySetting,
	rememberApprovedLocalReadPath,
} from "../ipc/project/manager";
import { lastNativeCaptureDiagnostics } from "../ipc/state";
import type { SelectedSource } from "../ipc/types";
import { getRecordingsDir } from "../ipc/utils";
import {
	checkForAppUpdates,
	deferUpdateReminder,
	dismissUpdateToast,
	downloadAvailableUpdate,
	getCurrentUpdateToastPayload,
	getUpdaterLogPath,
	getUpdateStatusSummary,
	installDownloadedUpdateNow,
	isAutoUpdateFeatureEnabled,
	previewUpdateToast,
	skipAvailableUpdateVersion,
	type UpdateToastPayload,
} from "../updater";
import { requireLocalFile } from "./files";

export interface SystemAutomationOptions {
	renderer: (method: string, params: Record<string, unknown>) => Promise<unknown>;
	safeIdle: (operation: string) => Promise<void> | void;
	openWindow: (kind: "editor" | "recorder" | "sources") => Promise<unknown> | unknown;
	quit: () => void;
	renameProject: (name: string) => Promise<unknown>;
	getMainWindow: () => BrowserWindow | null;
	sendUpdate?: (channel: "update-toast-state", payload: UpdateToastPayload | null) => boolean;
	broadcastSystem?: (payload: Record<string, unknown>) => void;
}

async function localDirectory(value: unknown): Promise<string> {
	if (typeof value !== "string" || !path.isAbsolute(value))
		throw new AutomationError("INVALID_PARAMS", "An absolute local directory is required.");
	try {
		const resolved = await fs.realpath(value);
		if (!(await fs.stat(resolved)).isDirectory()) throw new Error("Not a directory");
		return resolved;
	} catch {
		throw new AutomationError("INVALID_PATH", "Directory does not exist or is not accessible.");
	}
}

function serializeExtension(info: ReturnType<typeof getRegisteredExtensions>[number]) {
	return {
		manifest: info.manifest,
		status: info.status,
		path: info.path,
		error: info.error,
		builtin: Boolean(info.builtin),
	};
}

async function assertExtensionTree(source: string) {
	let files = 0;
	let bytes = 0;
	async function visit(directory: string) {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (++files > 10000)
				throw new AutomationError(
					"INVALID_EXTENSION",
					"Extension contains too many files.",
				);
			const filename = path.join(directory, entry.name);
			const stat = await fs.lstat(filename);
			if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
				throw new AutomationError(
					"INVALID_EXTENSION",
					"Extension folders may not contain symlinks or special files.",
				);
			if (stat.isDirectory()) await visit(filename);
			else {
				bytes += stat.size;
				if (bytes > 512 * 1024 * 1024)
					throw new AutomationError("INVALID_EXTENSION", "Extension exceeds 512 MiB.");
			}
		}
	}
	await visit(source);
}

/** Bounded log catalog access; a caller can never request arbitrary filesystem paths. */
export async function readSystemLog(logPath: string, maxBytes: number) {
	if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536)
		throw new AutomationError("INVALID_PARAMS", "Log tails must be between 1 and 65536 bytes.");
	let file: Awaited<ReturnType<typeof fs.open>>;
	try {
		file = await fs.open(logPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { id: "updater", text: "", bytes: 0, truncated: false, exists: false };
		throw new AutomationError(
			"ACCESS_DENIED",
			"The updater log is unavailable or is a symlink.",
		);
	}
	try {
		const stat = await file.stat();
		if (!stat.isFile())
			throw new AutomationError("ACCESS_DENIED", "The updater log is not a regular file.");
		const start = Math.max(0, stat.size - maxBytes);
		const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
		const text = buffer
			.subarray(0, bytesRead)
			.toString("utf8")
			.replace(/(authorization\s*[:=]\s*)(?:bearer|basic)\s+\S+/gi, "$1[redacted]")
			.replace(
				/((?:token|password|authorization|api[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi,
				"$1[redacted]",
			);
		return { id: "updater", text, bytes: bytesRead, truncated: start > 0, exists: true };
	} finally {
		await file.close();
	}
}

export function createSystemAutomation(options: SystemAutomationOptions) {
	let mutating = false;
	async function syncExtensions() {
		await options.safeIdle("extensions.sync");
		const extensions = getRegisteredExtensions().map(serializeExtension);
		const runtime = (await options.renderer("extensions.sync", { extensions })) as {
			activeExtensions?: string[];
		};
		options.broadcastSystem?.({ extensions });
		const warnings = extensions
			.filter(
				(item) =>
					item.status === "active" &&
					!runtime?.activeExtensions?.includes(item.manifest.id),
			)
			.map(
				(item) =>
					`Extension ${item.manifest.id} is configured active but did not activate in the current renderer.`,
			);
		return { extensions, runtime, warnings };
	}
	return {
		async dispatch(method: string, raw: unknown = {}): Promise<unknown> {
			if (!isSystemAutomationCommand(method))
				throw new AutomationError("UNKNOWN_COMMAND", "Unknown system automation command.");
			let params: Record<string, unknown>;
			try {
				params = parseSystemAutomationParams(method, raw);
			} catch (error) {
				throw new AutomationError(
					"INVALID_PARAMS",
					error instanceof Error ? error.message : "Invalid system command parameters.",
				);
			}
			const mutation = !SYSTEM_AUTOMATION_COMMANDS.find((command) => command.name === method)
				?.readOnly;
			if (mutation && mutating)
				throw new AutomationError("BUSY", "Another system mutation is running.");
			if (mutation) mutating = true;
			try {
				switch (method) {
					case "app.windows":
						return {
							windows: BrowserWindow.getAllWindows()
								.filter((window) => !window.isDestroyed())
								.map((window) => ({
									id: window.id,
									title: window.getTitle(),
									focused: window.isFocused(),
									visible: window.isVisible(),
									minimized: window.isMinimized(),
									maximized: window.isMaximized(),
									bounds: window.getBounds(),
								})),
						};
					case "app.window": {
						const window = BrowserWindow.fromId(params.id as number);
						if (!window || window.isDestroyed())
							throw new AutomationError(
								"WINDOW_NOT_FOUND",
								"Application window does not exist.",
							);
						if (params.action === "close") await options.safeIdle("app.window.close");
						switch (params.action) {
							case "show":
								window.show();
								break;
							case "focus":
								window.show();
								window.focus();
								break;
							case "hide":
								window.hide();
								break;
							case "minimize":
								window.minimize();
								break;
							case "maximize":
								window.maximize();
								break;
							case "restore":
								window.restore();
								break;
							case "close":
								window.close();
								break;
						}
						return { id: params.id, action: params.action };
					}
					case "app.open":
						return options.openWindow(
							params.window as "editor" | "recorder" | "sources",
						);
					case "app.quit":
						await options.safeIdle(method);
						options.quit();
						return { scheduled: true };
					case "settings.directories.get":
						return {
							userData: USER_DATA_PATH,
							recordingsPath: await getRecordingsDir(),
							projectsPath: await getProjectsDir(),
							extensionsPath: getExtensionsDirectory(),
						};
					case "settings.hud.get": {
						const hud = await import("../windows");
						return {
							captureProtection: hud.getHudOverlayCaptureProtection().enabled,
							mousePassthroughSupported: hud.isHudOverlayMousePassthroughSupported(),
						};
					}
					case "settings.hud.set": {
						await options.safeIdle(method);
						const hud = await import("../windows");
						const result = hud.setHudOverlayCaptureProtection(
							params.captureProtection as boolean,
						);
						options.broadcastSystem?.({ hudCaptureProtection: result.enabled });
						return { captureProtection: result.enabled };
					}
					case "settings.directories.set": {
						await options.safeIdle(method);
						const recordingsPath = await localDirectory(params.recordingsPath);
						await fs.access(recordingsPath, constants.W_OK);
						await persistRecordingsDirectorySetting(recordingsPath);
						return {
							recordingsPath,
							projectsPath: await getProjectsDir(),
							existingMediaMoved: false,
						};
					}
					case "extensions.list":
						return {
							directory: getExtensionsDirectory(),
							extensions: getRegisteredExtensions().map(serializeExtension),
						};
					case "extensions.discover":
						await options.safeIdle(method);
						await discoverExtensions();
						return syncExtensions();
					case "extensions.install": {
						await options.safeIdle(method);
						const source = await localDirectory(params.path);
						const extensionRoot = await fs
							.realpath(getExtensionsDirectory())
							.catch((error: NodeJS.ErrnoException) => {
								if (error.code === "ENOENT")
									return path.resolve(getExtensionsDirectory());
								throw error;
							});
						if (
							source === extensionRoot ||
							source.startsWith(`${extensionRoot}${path.sep}`)
						)
							throw new AutomationError(
								"INVALID_PATH",
								"Install from a separate source folder, not the live extensions directory.",
							);
						const manifestPath = path.join(source, "recordly-extension.json");
						const manifestStat = await fs.lstat(manifestPath);
						if (
							!manifestStat.isFile() ||
							manifestStat.isSymbolicLink() ||
							manifestStat.size > 65536
						)
							throw new AutomationError(
								"INVALID_EXTENSION",
								"Invalid extension manifest.",
							);
						let manifest: { id?: unknown };
						try {
							manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
						} catch {
							throw new AutomationError(
								"INVALID_EXTENSION",
								"Extension manifest is not valid JSON.",
							);
						}
						if (
							!manifest ||
							typeof manifest.id !== "string" ||
							!/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.id)
						)
							throw new AutomationError("INVALID_EXTENSION", "Invalid extension id.");
						const existing = getExtension(manifest.id);
						if (existing?.builtin)
							throw new AutomationError(
								"ACCESS_DENIED",
								"Built-in extensions cannot be replaced.",
							);
						const target = path.join(extensionRoot, manifest.id);
						const targetStat = await fs
							.lstat(target)
							.catch((error: NodeJS.ErrnoException) => {
								if (error.code === "ENOENT") return null;
								throw error;
							});
						if (
							targetStat?.isSymbolicLink() ||
							(targetStat && !targetStat.isDirectory())
						)
							throw new AutomationError(
								"INVALID_PATH",
								"Installed extension target is not a regular directory.",
							);
						if ((existing || targetStat) && params.overwrite !== true)
							throw new AutomationError(
								"OUTPUT_EXISTS",
								"Extension is already installed; set overwrite=true to replace it.",
							);
						await assertExtensionTree(source);
						const result = await installExtensionFromPath(source);
						if (!result)
							throw new AutomationError(
								"INVALID_EXTENSION",
								"Extension manifest or entry point failed validation.",
							);
						await syncExtensions();
						return { extension: serializeExtension(result) };
					}
					case "extensions.uninstall": {
						await options.safeIdle(method);
						const extension = getExtension(params.id as string);
						if (!extension)
							throw new AutomationError("NOT_FOUND", "Extension is not installed.");
						if (extension.builtin)
							throw new AutomationError(
								"ACCESS_DENIED",
								"Built-in extensions cannot be removed.",
							);
						const expected = path.join(
							path.resolve(getExtensionsDirectory()),
							extension.manifest.id,
						);
						if (path.resolve(extension.path) !== expected)
							throw new AutomationError(
								"ACCESS_DENIED",
								"Extension path is outside its managed directory.",
							);
						const stat = await fs
							.lstat(expected)
							.catch((error: NodeJS.ErrnoException) => {
								if (error.code === "ENOENT") return null;
								throw error;
							});
						if (stat?.isSymbolicLink())
							throw new AutomationError(
								"ACCESS_DENIED",
								"Extension directory became a symlink.",
							);
						if (!(await uninstallExtension(params.id as string)))
							throw new AutomationError(
								"EXTENSION_FAILED",
								"Could not uninstall extension.",
							);
						return syncExtensions();
					}
					case "extensions.setEnabled": {
						await options.safeIdle(method);
						if (!getExtension(params.id as string))
							throw new AutomationError("NOT_FOUND", "Extension is not installed.");
						if (
							!(await setExtensionStatus(
								params.id as string,
								params.enabled ? "active" : "disabled",
							))
						)
							throw new AutomationError(
								"EXTENSION_FAILED",
								"Could not change extension status.",
							);
						return syncExtensions();
					}
					case "extensions.marketplace.search":
						return searchMarketplace(params);
					case "extensions.marketplace.get":
						return getMarketplaceExtension(params.id as string);
					case "extensions.marketplace.install": {
						await options.safeIdle(method);
						const extensionId = params.id as string;
						const existing = getExtension(extensionId);
						if (existing?.builtin)
							throw new AutomationError(
								"ACCESS_DENIED",
								"Built-in extensions cannot be replaced.",
							);
						if (existing && params.overwrite !== true)
							throw new AutomationError(
								"OUTPUT_EXISTS",
								"Extension is already installed; set overwrite=true to replace it.",
							);
						const targetStat = await fs
							.lstat(path.join(getExtensionsDirectory(), extensionId))
							.catch((error: NodeJS.ErrnoException) => {
								if (error.code === "ENOENT") return null;
								throw error;
							});
						if (
							targetStat?.isSymbolicLink() ||
							(targetStat && !targetStat.isDirectory())
						)
							throw new AutomationError(
								"INVALID_PATH",
								"Extension target is not a regular directory.",
							);
						if (targetStat && params.overwrite !== true)
							throw new AutomationError(
								"OUTPUT_EXISTS",
								"Extension directory already exists; set overwrite=true to replace it.",
							);
						const catalog = await getMarketplaceExtension(extensionId);
						if (!catalog || catalog.id !== extensionId)
							throw new AutomationError(
								"NOT_FOUND",
								"The selected marketplace extension is unavailable.",
							);
						const installed = await downloadAndInstallExtension(
							extensionId,
							catalog.downloadUrl,
						);
						if (!installed.success)
							throw new AutomationError(
								"EXTENSION_FAILED",
								installed.error ?? "Marketplace installation failed.",
							);
						if (
							params.enabled !== false &&
							!(await setExtensionStatus(extensionId, "active"))
						)
							throw new AutomationError(
								"EXTENSION_FAILED",
								"Extension installed but could not be enabled.",
							);
						return syncExtensions();
					}
					case "updates.status":
						return {
							enabled: isAutoUpdateFeatureEnabled(),
							status: getUpdateStatusSummary(),
							notification: getCurrentUpdateToastPayload(),
						};
					case "updates.check":
						await checkForAppUpdates(options.getMainWindow, { manual: false });
						return {
							enabled: isAutoUpdateFeatureEnabled(),
							status: getUpdateStatusSummary(),
						};
					case "updates.download":
						return downloadAvailableUpdate(options.sendUpdate, {
							installAfterDownload: false,
						});
					case "updates.install": {
						await options.safeIdle(method);
						if (getUpdateStatusSummary().status !== "ready")
							throw new AutomationError(
								"UPDATE_NOT_READY",
								"No downloaded update is ready to install.",
							);
						setTimeout(() => {
							void Promise.resolve(options.safeIdle("updates.install"))
								.then(() => {
									if (getUpdateStatusSummary().status === "ready")
										installDownloadedUpdateNow(options.sendUpdate);
								})
								.catch((error) =>
									console.warn(
										"Update installation deferred because application state changed:",
										error,
									),
								);
						}, 100);
						return { scheduled: true };
					}
					case "updates.defer":
						return deferUpdateReminder(
							options.getMainWindow,
							options.sendUpdate,
							params.delayMs as number | undefined,
						);
					case "updates.dismiss":
						return dismissUpdateToast(options.getMainWindow, options.sendUpdate);
					case "updates.skip":
						return skipAvailableUpdateVersion(options.sendUpdate);
					case "updates.preview": {
						await options.safeIdle(method);
						return {
							shown: previewUpdateToast(options.sendUpdate ?? (() => false)),
							preview: true,
						};
					}
					case "diagnostics.get":
						return {
							app: {
								version: app.getVersion(),
								platform: process.platform,
								arch: process.arch,
								osRelease: os.release(),
								electron: process.versions.electron,
								chrome: process.versions.chrome,
								node: process.versions.node,
							},
							nativeCapture: lastNativeCaptureDiagnostics,
							logs: [
								{ id: "updater", maxBytes: 65536 },
								{ id: "app", maxBytes: 65536 },
							],
						};
					case "logs.read":
						return {
							...(await readSystemLog(
								params.id === "app" ? getLogFilePath() : getUpdaterLogPath(),
								(params.maxBytes as number) ?? 16384,
							)),
							id: params.id,
						};
					case "logs.clear": {
						const result = await clearAppLogs();
						if (!result.success)
							throw new AutomationError(
								"SAVE_FAILED",
								result.error ?? "Could not clear application logs.",
							);
						return { id: "app", cleared: true };
					}
					case "clipboard.write":
						clipboard.writeText(params.text as string);
						return { copied: true, characters: (params.text as string).length };
					case "files.reveal": {
						if (!path.isAbsolute(params.path as string))
							throw new AutomationError(
								"INVALID_PARAMS",
								"An absolute local path is required.",
							);
						const filename = await fs.realpath(params.path as string);
						shell.showItemInFolder(filename);
						return { path: filename };
					}
					case "folders.open": {
						const directories = {
							recordings: await getRecordingsDir(),
							projects: await getProjectsDir(),
							extensions: getExtensionsDirectory(),
							userData: USER_DATA_PATH,
						};
						const directory = directories[params.kind as keyof typeof directories];
						const error = await shell.openPath(directory);
						if (error) throw new AutomationError("OPEN_FAILED", error);
						return { path: directory };
					}
					case "sources.highlight": {
						const { listCaptureSources, showSourceHighlight } = await import(
							"../ipc/register/sources"
						);
						const source = (
							await listCaptureSources({
								types: ["screen", "window"],
								thumbnailSize: { width: 0, height: 0 },
							})
						).find((item) => item.id === params.sourceId);
						if (!source)
							throw new AutomationError(
								"SOURCE_UNAVAILABLE",
								"Source is no longer available; list sources again.",
							);
						const result = await showSourceHighlight(source as SelectedSource);
						if (!result.success)
							throw new AutomationError(
								"SOURCE_UNAVAILABLE",
								"Could not highlight this source.",
							);
						return result;
					}
					case "project.rename":
						await options.safeIdle(method);
						return options.renameProject(params.name as string);
					case "wallpapers.add": {
						const filename = await requireLocalFile(params.path);
						if (
							!/\.(png|jpe?g|gif|webp|avif|svg|mov|mp4|webm|mkv|avi|m4v)$/i.test(
								filename,
							)
						)
							throw new AutomationError(
								"UNSUPPORTED_FORMAT",
								"Wallpaper must be a supported image or video.",
							);
						await rememberApprovedLocalReadPath(filename);
						const result = await options.renderer(method, { path: filename });
						options.broadcastSystem?.({ assetsChanged: true });
						return result;
					}
					default: {
						if (method === "extensions.settings.set" || method === "fonts.remove")
							await options.safeIdle(method);
						const result = await options.renderer(method, params);
						if (method === "settings.set")
							options.broadcastSystem?.({ settings: params });
						if (method === "shortcuts.set")
							options.broadcastSystem?.({
								shortcuts: (result as { bindings: unknown }).bindings,
							});
						if (
							method === "fonts.add" ||
							method === "fonts.remove" ||
							method === "wallpapers.remove"
						)
							options.broadcastSystem?.({ assetsChanged: true });
						if (method === "extensions.settings.set")
							options.broadcastSystem?.({ extensionSetting: params });
						return result;
					}
				}
			} finally {
				if (mutation) mutating = false;
			}
		},
	};
}
