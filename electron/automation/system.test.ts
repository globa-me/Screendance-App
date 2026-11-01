import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationError } from "../../shared/automation";

const mocks = vi.hoisted(() => ({
	root: "",
	recordings: "",
	log: "",
	extensions: new Map<
		string,
		{
			manifest: {
				id: string;
				name: string;
				main: string;
				version: string;
				description: string;
				permissions: [];
			};
			status: string;
			path: string;
			builtin: boolean;
		}
	>(),
	install: vi.fn(),
	marketplaceGet: vi.fn(),
	marketplaceInstall: vi.fn(),
	clearLogs: vi.fn(async () => ({ success: true })),
	copyText: vi.fn(),
	reveal: vi.fn(),
	openFolder: vi.fn(async () => ""),
	hudProtection: true,
	uninstall: vi.fn(),
	discover: vi.fn(async () => []),
	setStatus: vi.fn(),
	persistDirectory: vi.fn(),
	updateStatus: {
		status: "idle",
		currentVersion: "1.5.0",
		availableVersion: null as string | null,
	},
	check: vi.fn(),
	download: vi.fn(async () => ({ success: true })),
	installUpdate: vi.fn(),
	defer: vi.fn(),
	dismiss: vi.fn(),
	skip: vi.fn(),
	window: {
		id: 7,
		isDestroyed: () => false,
		getTitle: () => "Editor",
		isFocused: () => true,
		isVisible: () => true,
		isMinimized: () => false,
		isMaximized: () => false,
		getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
		show: vi.fn(),
		focus: vi.fn(),
		hide: vi.fn(),
		minimize: vi.fn(),
		maximize: vi.fn(),
		restore: vi.fn(),
		close: vi.fn(),
	},
	highlight: vi.fn(async () => ({ success: true })),
	sources: vi.fn(async () => [{ id: "window:42:0", name: "Fixture" }]),
}));
vi.mock("electron", () => ({
	app: { getVersion: () => "1.5.0" },
	clipboard: { writeText: mocks.copyText },
	shell: { showItemInFolder: mocks.reveal, openPath: mocks.openFolder },
	BrowserWindow: {
		getAllWindows: () => [mocks.window],
		fromId: (id: number) => (id === 7 ? mocks.window : null),
	},
}));
vi.mock("../appPaths", () => ({ USER_DATA_PATH: "/isolated/profile" }));
vi.mock("../extensions/extensionLoader", () => ({
	getExtensionsDirectory: () => path.join(mocks.root, "extensions"),
	getRegisteredExtensions: () => [...mocks.extensions.values()],
	getExtension: (id: string) => mocks.extensions.get(id),
	discoverExtensions: mocks.discover,
	installExtensionFromPath: mocks.install,
	uninstallExtension: mocks.uninstall,
	setExtensionStatus: mocks.setStatus,
}));
vi.mock("../extensions/extensionMarketplace", () => ({
	searchMarketplace: vi.fn(async (params) => ({ extensions: [], ...params })),
	getMarketplaceExtension: mocks.marketplaceGet,
	downloadAndInstallExtension: mocks.marketplaceInstall,
}));
vi.mock("../ipc/logging", () => ({
	getLogFilePath: () => path.join(mocks.root, "app.log"),
	clearAppLogs: mocks.clearLogs,
}));
vi.mock("../windows", () => ({
	getHudOverlayCaptureProtection: () => ({ success: true, enabled: mocks.hudProtection }),
	setHudOverlayCaptureProtection: (enabled: boolean) => {
		mocks.hudProtection = enabled;
		return { success: true, enabled };
	},
	isHudOverlayMousePassthroughSupported: () => true,
}));
vi.mock("../ipc/project/manager", () => ({
	getProjectsDir: async () => path.join(mocks.recordings, "Projects"),
	persistRecordingsDirectorySetting: mocks.persistDirectory,
	rememberApprovedLocalReadPath: vi.fn(async () => {}),
}));
vi.mock("../ipc/state", () => ({
	lastNativeCaptureDiagnostics: { backend: "mac-screencapturekit", phase: "stop" },
}));
vi.mock("../ipc/utils", () => ({ getRecordingsDir: async () => mocks.recordings }));
vi.mock("../updater", () => ({
	getUpdateStatusSummary: () => mocks.updateStatus,
	getCurrentUpdateToastPayload: () => null,
	getUpdaterLogPath: () => mocks.log,
	isAutoUpdateFeatureEnabled: () => false,
	checkForAppUpdates: mocks.check,
	downloadAvailableUpdate: mocks.download,
	installDownloadedUpdateNow: mocks.installUpdate,
	deferUpdateReminder: mocks.defer,
	dismissUpdateToast: mocks.dismiss,
	skipAvailableUpdateVersion: mocks.skip,
	previewUpdateToast: vi.fn(() => true),
}));
vi.mock("../ipc/register/sources", () => ({
	listCaptureSources: mocks.sources,
	showSourceHighlight: mocks.highlight,
}));

import { createSystemAutomation, readSystemLog } from "./system";

let service: ReturnType<typeof createSystemAutomation>;
const renderer = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
	activeExtensions: [...mocks.extensions.values()]
		.filter((item) => item.status === "active")
		.map((item) => item.manifest.id),
}));
const safeIdle = vi.fn(async (_operation: string) => {});
const quit = vi.fn();
const rename = vi.fn(async (name: string) => ({ name }));
const broadcast = vi.fn();
function extension(id: string, builtin = false) {
	const item = {
		manifest: {
			id,
			name: id,
			main: "index.js",
			version: "1.0.0",
			description: "fixture",
			permissions: [] as [],
		},
		status: "disabled",
		path: path.join(mocks.root, "extensions", id),
		builtin,
	};
	mocks.extensions.set(id, item);
	return item;
}
async function sourceExtension(id = "com.example.fixture") {
	const source = path.join(mocks.root, "source");
	await fs.mkdir(source);
	await fs.writeFile(
		path.join(source, "recordly-extension.json"),
		JSON.stringify(extension(id).manifest),
	);
	mocks.extensions.delete(id);
	await fs.writeFile(path.join(source, "index.js"), "export function activate() {}");
	return source;
}
beforeEach(async () => {
	vi.clearAllMocks();
	mocks.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sd-system-")));
	mocks.recordings = path.join(mocks.root, "recordings");
	mocks.log = path.join(mocks.root, "updater.log");
	await fs.mkdir(path.join(mocks.root, "extensions"));
	await fs.mkdir(mocks.recordings);
	mocks.extensions.clear();
	mocks.updateStatus = { status: "idle", currentVersion: "1.5.0", availableVersion: null };
	mocks.persistDirectory.mockImplementation(async (value: string) => {
		mocks.recordings = value;
	});
	mocks.setStatus.mockImplementation(async (id: string, status: string) => {
		const item = mocks.extensions.get(id);
		if (!item) return false;
		item.status = status;
		return true;
	});
	mocks.uninstall.mockImplementation(async (id: string) => mocks.extensions.delete(id));
	mocks.install.mockImplementation(async () => extension("com.example.fixture"));
	mocks.marketplaceGet.mockImplementation(async (id: string) => ({
		id,
		downloadUrl: "https://market.example/fixture.zip",
	}));
	mocks.marketplaceInstall.mockImplementation(async (id: string) => {
		extension(id);
		return { success: true };
	});
	mocks.hudProtection = true;
	service = createSystemAutomation({
		renderer,
		safeIdle,
		quit,
		renameProject: rename,
		openWindow: vi.fn(async (window) => ({ window })),
		getMainWindow: () => null,
		broadcastSystem: broadcast,
	});
});
afterEach(async () => {
	vi.useRealTimers();
	await fs.rm(mocks.root, { recursive: true, force: true });
});

describe("system automation lifecycle and strict contracts", () => {
	it("controls only listed window ids and blocks close/quit when active work exists", async () => {
		expect(await service.dispatch("app.windows")).toMatchObject({
			windows: [{ id: 7, title: "Editor" }],
		});
		await service.dispatch("app.window", { id: 7, action: "focus" });
		expect(mocks.window.focus).toHaveBeenCalledOnce();
		await expect(
			service.dispatch("app.window", { id: 99, action: "hide" }),
		).rejects.toMatchObject({ code: "WINDOW_NOT_FOUND" });
		safeIdle.mockRejectedValueOnce(new AutomationError("UNSAVED_CHANGES", "Save first"));
		await expect(service.dispatch("app.quit")).rejects.toMatchObject({
			code: "UNSAVED_CHANGES",
		});
		expect(quit).not.toHaveBeenCalled();
		safeIdle.mockRejectedValueOnce(new AutomationError("BUSY", "Recording"));
		await expect(
			service.dispatch("app.window", { id: 7, action: "close" }),
		).rejects.toMatchObject({ code: "BUSY" });
		expect(mocks.window.close).not.toHaveBeenCalled();
	});
	it.each([
		["logs.read", { id: "../../secret" }],
		["logs.read", { id: "updater", maxBytes: 65537 }],
		["app.window", { id: 7, action: "executeJavaScript" }],
		["extensions.uninstall", { id: "../outside" }],
		["settings.set", { theme: "dark", secret: true }],
		["settings.set", { locale: "unsupported" }],
	])("rejects unknown fields and unsafe inputs for %s", async (method, params) => {
		await expect(service.dispatch(method, params)).rejects.toMatchObject({
			code: "INVALID_PARAMS",
		});
		expect(renderer).not.toHaveBeenCalled();
	});
	it("changes only the recording location and never moves existing media", async () => {
		const original = path.join(mocks.recordings, "keep.mov");
		await fs.writeFile(original, "media");
		const destination = path.join(mocks.root, "new-recordings");
		await fs.mkdir(destination);
		expect(
			await service.dispatch("settings.directories.set", { recordingsPath: destination }),
		).toMatchObject({ recordingsPath: destination, existingMediaMoved: false });
		expect(await fs.readFile(original, "utf8")).toBe("media");
		await expect(
			service.dispatch("settings.directories.set", { recordingsPath: "relative" }),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
	});
	it("delegates only declared renderer operations and validated local wallpaper files", async () => {
		await service.dispatch("settings.set", { theme: "dark", locale: "ru" });
		expect(renderer).toHaveBeenCalledWith("settings.set", { theme: "dark", locale: "ru" });
		expect(broadcast).toHaveBeenCalledWith({ settings: { theme: "dark", locale: "ru" } });
		const wallpaper = path.join(mocks.root, "wallpaper.png");
		await fs.writeFile(wallpaper, "image fixture");
		await service.dispatch("wallpapers.add", { path: wallpaper });
		expect(renderer).toHaveBeenCalledWith("wallpapers.add", { path: wallpaper });
		await expect(service.dispatch("evaluate", { code: "arbitrary()" })).rejects.toMatchObject({
			code: "UNKNOWN_COMMAND",
		});
	});
	it("serializes mutations without blocking main-process diagnostics", async () => {
		let finish!: (value: { activeExtensions: string[] }) => void;
		renderer.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const first = service.dispatch("settings.set", { theme: "dark" });
		await expect(service.dispatch("settings.set", { theme: "light" })).rejects.toMatchObject({
			code: "BUSY",
		});
		expect(await service.dispatch("diagnostics.get")).toMatchObject({
			app: { version: "1.5.0" },
		});
		finish({ activeExtensions: [] });
		await first;
		await expect(service.dispatch("settings.set", { theme: "light" })).resolves.toBeDefined();
	});
	it("highlights only an exact currently available source", async () => {
		await service.dispatch("sources.highlight", { sourceId: "window:42:0" });
		expect(mocks.highlight).toHaveBeenCalledWith({ id: "window:42:0", name: "Fixture" });
		await expect(
			service.dispatch("sources.highlight", { sourceId: "window:43:0" }),
		).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
		expect(mocks.highlight).toHaveBeenCalledOnce();
	});
});

describe("extension management", () => {
	it("installs the selected catalog URL, enables it like the UI, and synchronizes runtimes", async () => {
		await service.dispatch("extensions.marketplace.install", { id: "com.example.remote" });
		expect(mocks.marketplaceInstall).toHaveBeenCalledWith(
			"com.example.remote",
			"https://market.example/fixture.zip",
		);
		expect(mocks.extensions.get("com.example.remote")?.status).toBe("active");
		expect(broadcast).toHaveBeenCalledWith({
			extensions: expect.arrayContaining([expect.objectContaining({ status: "active" })]),
		});
	});
	it("refuses implicit marketplace replacement and allows install-only without enabling", async () => {
		extension("com.example.remote");
		await expect(
			service.dispatch("extensions.marketplace.install", { id: "com.example.remote" }),
		).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
		expect(mocks.marketplaceInstall).not.toHaveBeenCalled();
		await service.dispatch("extensions.marketplace.install", {
			id: "com.example.remote",
			overwrite: true,
			enabled: false,
		});
		expect(mocks.setStatus).not.toHaveBeenCalled();
	});
	it("rejects catalog mismatches and does not accept caller-supplied download URLs", async () => {
		mocks.marketplaceGet.mockResolvedValueOnce({
			id: "different.id",
			downloadUrl: "https://market.example/other.zip",
		});
		await expect(
			service.dispatch("extensions.marketplace.install", { id: "com.example.remote" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			service.dispatch("extensions.marketplace.install", {
				id: "com.example.remote",
				downloadUrl: "https://evil.example/file.zip",
			}),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		expect(mocks.marketplaceInstall).not.toHaveBeenCalled();
	});
	it("updates configured state and synchronizes the existing renderer runtime", async () => {
		extension("com.example.fixture");
		expect(
			await service.dispatch("extensions.setEnabled", {
				id: "com.example.fixture",
				enabled: true,
			}),
		).toMatchObject({ runtime: { activeExtensions: ["com.example.fixture"] }, warnings: [] });
		expect(mocks.extensions.get("com.example.fixture")?.status).toBe("active");
		await service.dispatch("extensions.setEnabled", {
			id: "com.example.fixture",
			enabled: false,
		});
		expect(mocks.extensions.get("com.example.fixture")?.status).toBe("disabled");
	});
	it("protects builtins and unmanaged paths from uninstall", async () => {
		extension("builtin.fixture", true);
		await expect(
			service.dispatch("extensions.uninstall", { id: "builtin.fixture" }),
		).rejects.toMatchObject({ code: "ACCESS_DENIED" });
		const outside = extension("com.example.outside");
		outside.path = mocks.root;
		await expect(
			service.dispatch("extensions.uninstall", { id: outside.manifest.id }),
		).rejects.toMatchObject({ code: "ACCESS_DENIED" });
		expect(mocks.uninstall).not.toHaveBeenCalled();
	});
	it("requires explicit replacement and refuses builtin overwrite", async () => {
		const source = await sourceExtension();
		extension("com.example.fixture");
		await expect(
			service.dispatch("extensions.install", { path: source }),
		).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
		await service.dispatch("extensions.install", { path: source, overwrite: true });
		expect(mocks.install).toHaveBeenCalledWith(source);
		mocks.extensions.get("com.example.fixture")!.builtin = true;
		await expect(
			service.dispatch("extensions.install", { path: source, overwrite: true }),
		).rejects.toMatchObject({ code: "ACCESS_DENIED" });
	});
	it("refuses symlink-bearing extension trees before invoking the installer", async () => {
		const source = await sourceExtension();
		await fs.symlink(mocks.log, path.join(source, "external-resource"));
		await expect(
			service.dispatch("extensions.install", { path: source }),
		).rejects.toMatchObject({ code: "INVALID_EXTENSION" });
		expect(mocks.install).not.toHaveBeenCalled();
	});
	it("does not permit installing from the live extensions directory", async () => {
		await expect(
			service.dispatch("extensions.install", { path: path.join(mocks.root, "extensions") }),
		).rejects.toMatchObject({ code: "INVALID_PATH" });
		expect(mocks.install).not.toHaveBeenCalled();
	});
});

describe("updates and diagnostics", () => {
	it("supports existing application logs, clipboard, Finder and HUD protection without generic IPC", async () => {
		await fs.writeFile(path.join(mocks.root, "app.log"), "fixture app log");
		expect(await service.dispatch("logs.read", { id: "app" })).toMatchObject({
			id: "app",
			text: "fixture app log",
		});
		await service.dispatch("logs.clear", { id: "app" });
		expect(mocks.clearLogs).toHaveBeenCalledOnce();
		await service.dispatch("clipboard.write", { text: "Copied diagnostic text" });
		expect(mocks.copyText).toHaveBeenCalledWith("Copied diagnostic text");
		await service.dispatch("files.reveal", { path: mocks.root });
		expect(mocks.reveal).toHaveBeenCalledWith(mocks.root);
		await service.dispatch("folders.open", { kind: "recordings" });
		expect(mocks.openFolder).toHaveBeenCalledWith(mocks.recordings);
		await service.dispatch("settings.hud.set", { captureProtection: false });
		expect(mocks.hudProtection).toBe(false);
		expect(broadcast).toHaveBeenCalledWith({ hudCaptureProtection: false });
	});
	it("download never implies install and install requires ready plus safe idle", async () => {
		await service.dispatch("updates.download");
		expect(mocks.download).toHaveBeenCalledWith(undefined, { installAfterDownload: false });
		expect(mocks.installUpdate).not.toHaveBeenCalled();
		await expect(service.dispatch("updates.install")).rejects.toMatchObject({
			code: "UPDATE_NOT_READY",
		});
		vi.useFakeTimers();
		mocks.updateStatus.status = "ready";
		await service.dispatch("updates.install");
		expect(mocks.installUpdate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(100);
		expect(mocks.installUpdate).toHaveBeenCalledOnce();
	});
	it("reads only bounded known logs, redacts simple credentials and refuses symlinks", async () => {
		await fs.writeFile(mocks.log, `${"x".repeat(100)}\ntoken=secret-value\n`);
		expect(await service.dispatch("logs.read", { id: "updater", maxBytes: 40 })).toMatchObject({
			truncated: true,
			text: expect.stringContaining("token=[redacted]"),
		});
		expect(
			JSON.stringify(await service.dispatch("logs.read", { id: "updater" })),
		).not.toContain("secret-value");
		await fs.unlink(mocks.log);
		await fs.symlink("/etc/passwd", mocks.log);
		await expect(service.dispatch("logs.read", { id: "updater" })).rejects.toMatchObject({
			code: "ACCESS_DENIED",
		});
		await expect(readSystemLog(mocks.log, 1_000_000)).rejects.toMatchObject({
			code: "INVALID_PARAMS",
		});
	});
	it("rechecks safe state before the scheduled installer runs", async () => {
		vi.useFakeTimers();
		mocks.updateStatus.status = "ready";
		await service.dispatch("updates.install");
		safeIdle.mockRejectedValueOnce(new AutomationError("BUSY", "Recording just started"));
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		await vi.advanceTimersByTimeAsync(100);
		expect(mocks.installUpdate).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalled();
		warning.mockRestore();
	});
	it("redacts authorization credentials including the value after Bearer", async () => {
		await fs.writeFile(mocks.log, "Authorization: Bearer private-credential\n");
		const result = await service.dispatch("logs.read", { id: "updater" });
		expect(JSON.stringify(result)).not.toContain("private-credential");
	});
});
