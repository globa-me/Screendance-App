import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationError, type AutomationRequest } from "../../shared/automation";
import type { RecordingSessionData } from "../ipc/types";

const mocks = vi.hoisted(() => ({
	listeners: new Map<string, (...args: unknown[]) => void>(),
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	context: {
		project: null as string | null,
		video: null as string | null,
		session: null as RecordingSessionData | null,
		approved: new Set<string>(),
	},
	dispatch: null as null | ((request: AutomationRequest) => Promise<unknown>),
	close: vi.fn(async () => {}),
	preflight: vi.fn(async (_method: string, path: string) => path),
	readProject: vi.fn(async () => ({
		version: 1,
		videoPath: "/canonical/source.mp4",
		editor: {},
	})),
	approve: vi.fn(async () => {}),
	loadProject: vi.fn(
		async (
			_path: string,
		): Promise<{ success: boolean; path?: string; project?: unknown; message?: string }> => ({
			success: false,
		}),
	),
	prepare: vi.fn(async (path: string) => path),
	persist: vi.fn(async (path: string, data: unknown) => ({ path, data })),
	recording: false,
	countdown: false,
	countdownInProgress: false,
	getProjectsDir: vi.fn(async () => "/library/projects"),
	listProjects: vi.fn(async () => ({
		projectsDir: "/library/projects",
		entries: [{ path: "/library/projects/demo.scrdance", name: "demo" }],
	})),
	saveThumbnail: vi.fn(async () => {}),
	rememberRecent: vi.fn(async () => {}),
	prepareSave: vi.fn(async (_path: unknown, _current: unknown, _overwrite: unknown) => ({
		path: "/canonical/saved.scrdance",
	})),
	persistSave: vi.fn(async (target: { path: string }, _project: unknown) => ({
		path: target.path,
	})),
	mediaStatus: vi.fn((kind: string) => (kind === "camera" ? "denied" : "granted")),
	accessibility: vi.fn(() => false),
	jobsActive: false,
	jobMethods: new Set<string>(),
	jobOptions: null as null | { safeIdle: () => Promise<void> },
	jobsDispatch: vi.fn(async (command: AutomationRequest) => ({ method: command.method })),
	jobsClose: vi.fn(async () => {}),
	systemOptions: null as null | {
		renderer: (method: string, params: Record<string, unknown>) => Promise<unknown>;
		safeIdle: (operation: string) => Promise<void>;
	},
	systemDispatch: vi.fn(async (method: string, params: Record<string, unknown>) => ({
		method,
		params,
	})),
}));
vi.mock("electron", () => ({
	app: { getVersion: () => "1.5.0" },
	systemPreferences: {
		getMediaAccessStatus: mocks.mediaStatus,
		isTrustedAccessibilityClient: mocks.accessibility,
	},
	ipcMain: {
		on: (name: string, listener: (...args: unknown[]) => void) =>
			mocks.listeners.set(name, listener),
		removeListener: (name: string) => mocks.listeners.delete(name),
		handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
			mocks.handlers.set(name, handler),
		removeHandler: (name: string) => mocks.handlers.delete(name),
	},
}));
vi.mock("../appPaths", () => ({ USER_DATA_PATH: "/tmp/automation-host-unit" }));
vi.mock("../ipc/project/manager", () => ({
	rememberApprovedLocalReadPath: mocks.approve,
	loadProjectFromPath: mocks.loadProject,
	getProjectsDir: mocks.getProjectsDir,
	listProjectLibraryEntries: mocks.listProjects,
	saveProjectThumbnail: mocks.saveThumbnail,
	rememberRecentProject: mocks.rememberRecent,
}));
vi.mock("../ipc/state", () => ({
	get countdownInProgress() {
		return mocks.countdownInProgress;
	},
	get countdownTimer() {
		return mocks.countdown;
	},
	get nativeScreenRecordingActive() {
		return mocks.recording;
	},
	ffmpegScreenRecordingActive: false,
	windowsNativeCaptureActive: false,
	get currentProjectPath() {
		return mocks.context.project;
	},
	get currentVideoPath() {
		return mocks.context.video;
	},
	get currentRecordingSession() {
		return mocks.context.session;
	},
	approvedLocalReadPaths: mocks.context.approved,
	setCurrentProjectPath: (value: string | null) => {
		mocks.context.project = value;
	},
	setCurrentVideoPath: (value: string | null) => {
		mocks.context.video = value;
	},
	setCurrentRecordingSession: (value: RecordingSessionData | null) => {
		mocks.context.session = value;
	},
}));
vi.mock("./files", () => ({
	preflightOpen: mocks.preflight,
	readAutomationProject: mocks.readProject,
	preparePreviewPath: mocks.prepare,
	persistPreview: mocks.persist,
}));
vi.mock("./projectSave", () => ({
	prepareAutomationProjectSave: mocks.prepareSave,
	persistAutomationProject: mocks.persistSave,
}));
vi.mock("./socketServer", () => ({
	startAutomationSocket: vi.fn(async (options) => {
		mocks.dispatch = options.dispatch;
		return { endpoint: {}, close: mocks.close };
	}),
}));
vi.mock("./jobHost", () => ({
	createAutomationJobs: vi.fn((options) => {
		mocks.jobOptions = options;
		return {
			hasActive: () => mocks.jobsActive,
			recognizes: (method: string) => mocks.jobMethods.has(method),
			dispatch: mocks.jobsDispatch,
			close: mocks.jobsClose,
		};
	}),
}));
vi.mock("./system", () => ({
	createSystemAutomation: vi.fn((options) => {
		mocks.systemOptions = options;
		return { dispatch: mocks.systemDispatch };
	}),
}));

import { createAutomationHost } from "./host";

let host: ReturnType<typeof createAutomationHost>;
let dirty = false;
let window: ReturnType<typeof makeWindow> | null;
let recorder: ReturnType<typeof makeWindow> | null;
function makeWindow(id = 22) {
	const webContents = Object.assign(new EventEmitter(), { id, send: vi.fn() });
	return { webContents, isDestroyed: () => false };
}
function request(method: AutomationRequest["method"], params = {}): AutomationRequest {
	return { id: "external-id", method, params };
}
function ready() {
	mocks.listeners.get("automation:ready")!({ sender: window!.webContents });
}
function recorderReady(sender = recorder!.webContents) {
	mocks.listeners.get("automation:recorder-ready")!({ sender });
}
function systemReady(sender = window!.webContents) {
	mocks.listeners.get("automation:system-ready")!({ sender });
}
function invokeProjectSave(
	id: unknown,
	project: unknown,
	thumbnail?: string | null,
	sender = window!.webContents,
) {
	return mocks.handlers.get("automation:save-project")!({ sender }, id, project, thumbnail);
}
function respond(id: string, result: unknown, sender = window!.webContents) {
	mocks.listeners.get("automation:response")!({ sender }, { id, result });
}
function respondError(id: string, code: string) {
	mocks.listeners.get("automation:response")!(
		{ sender: window!.webContents },
		{ id, error: { code, message: code } },
	);
}
function invokeProjectOpen(id: unknown, path: unknown, sender = window!.webContents) {
	return mocks.handlers.get("automation:open-project")!({ sender }, id, path);
}
async function beginProjectOpen() {
	ready();
	const completion = mocks.dispatch!(request("project.open", { path: "/tmp/target.scrdance" }));
	await vi.waitFor(() => expect(window!.webContents.send).toHaveBeenCalled());
	const sent = window!.webContents.send.mock.calls[0][1] as AutomationRequest;
	return { completion, sent };
}

beforeEach(async () => {
	vi.clearAllMocks();
	mocks.jobsActive = false;
	mocks.jobMethods.clear();
	mocks.jobOptions = null;
	mocks.systemOptions = null;
	mocks.systemDispatch.mockImplementation(async (method, params) => ({ method, params }));
	mocks.jobsDispatch.mockImplementation(async (command) => ({ method: command.method }));
	mocks.listeners.clear();
	mocks.handlers.clear();
	mocks.context.project = "/original/project.scrdance";
	mocks.context.video = "/original/source.mp4";
	mocks.context.session = {
		videoPath: "/original/source.mp4",
		webcamPath: "/original/webcam.mp4",
		timeOffsetMs: 140,
	};
	mocks.context.approved.clear();
	mocks.context.approved.add("/original/source.mp4");
	mocks.context.approved.add("/original/webcam.mp4");
	mocks.loadProject.mockImplementation(async (target) => {
		mocks.context.project = target;
		mocks.context.video = "/canonical/source.mp4";
		mocks.context.session = { videoPath: "/canonical/source.mp4", webcamPath: null };
		mocks.context.approved.clear();
		mocks.context.approved.add("/canonical/source.mp4");
		return {
			success: true,
			path: target,
			project: { version: 1, videoPath: "/canonical/source.mp4", editor: {} },
		};
	});
	mocks.recording = false;
	mocks.countdown = false;
	mocks.countdownInProgress = false;
	mocks.prepareSave.mockResolvedValue({ path: "/canonical/saved.scrdance" });
	mocks.persistSave.mockImplementation(async (target) => ({ path: target.path }));
	mocks.saveThumbnail.mockResolvedValue(undefined);
	mocks.rememberRecent.mockResolvedValue(undefined);
	dirty = false;
	window = makeWindow();
	recorder = makeWindow(33);
	host = createAutomationHost({
		getEditor: () => window as unknown as BrowserWindow | null,
		createEditor: () => {
			window = makeWindow();
			return window as unknown as BrowserWindow;
		},
		getRecorder: () => recorder as unknown as BrowserWindow | null,
		createRecorder: () => {
			recorder = makeWindow(33);
			return recorder as unknown as BrowserWindow;
		},
		hasUnsavedChanges: () => dirty,
	});
	await host.start();
});
afterEach(async () => {
	await host.close();
	vi.useRealTimers();
});

describe("automation host orchestration", () => {
	it("provides status and capabilities before the editor is ready", async () => {
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({
			editorOpen: true,
			editorReady: false,
			busy: false,
		});
		expect(await mocks.dispatch!(request("app.capabilities"))).toMatchObject({
			protocolVersion: 1,
			stage: "complete-1-6",
		});
		expect(window!.webContents.send).not.toHaveBeenCalled();
	});

	it("prevents opening over dirty edits and during recording before approving a file", async () => {
		dirty = true;
		await expect(
			mocks.dispatch!(request("project.open", { path: "/tmp/a.scrdance" })),
		).rejects.toMatchObject({ code: "UNSAVED_CHANGES" });
		dirty = false;
		mocks.recording = true;
		await expect(
			mocks.dispatch!(request("video.open", { path: "/tmp/a.mov" })),
		).rejects.toMatchObject({ code: "RECORDING_ACTIVE" });
		mocks.recording = false;
		mocks.countdown = true;
		await expect(mocks.dispatch!(request("project.inspect"))).rejects.toMatchObject({
			code: "RECORDING_ACTIVE",
		});
		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.approve).not.toHaveBeenCalled();
	});

	it("uses private request ids, ignores other renderers, and serializes editor commands", async () => {
		ready();
		const pending = mocks.dispatch!(request("project.inspect"));
		const sent = window!.webContents.send.mock.calls[0][1];
		expect(sent.id).not.toBe("external-id");
		respond(sent.id, { wrong: true }, makeWindow(99).webContents);
		await expect(mocks.dispatch!(request("project.inspect"))).rejects.toMatchObject({
			code: "BUSY",
		});
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: true });
		respond(sent.id, { project: "right" });
		await expect(pending).resolves.toEqual({ project: "right" });
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: false });
	});

	it("rejects pending work when the editor is destroyed and allows subsequent status", async () => {
		ready();
		const pending = mocks.dispatch!(request("project.inspect"));
		const assertion = expect(pending).rejects.toMatchObject({ code: "EDITOR_CLOSED" });
		window!.webContents.emit("destroyed");
		await assertion;
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({
			busy: false,
			editorReady: false,
		});
	});

	it("waits for controller readiness before sending and then passes the approved canonical path", async () => {
		vi.useFakeTimers();
		mocks.preflight.mockResolvedValueOnce("/canonical/clip.mov");
		const pending = mocks.dispatch!(request("video.open", { path: "/alias/clip.mov" }));
		await vi.advanceTimersByTimeAsync(40);
		expect(window!.webContents.send).not.toHaveBeenCalled();
		ready();
		await vi.advanceTimersByTimeAsync(40);
		const sent = window!.webContents.send.mock.calls[0][1];
		expect(mocks.approve).toHaveBeenCalledWith("/canonical/clip.mov");
		expect(sent.params).toEqual({ path: "/canonical/clip.mov" });
		respond(sent.id, { readiness: { previewReady: true } });
		await expect(pending).resolves.toEqual({ readiness: { previewReady: true } });
	});

	it("injects only a validated internal project snapshot and approves its media before dispatch", async () => {
		ready();
		const pending = mocks.dispatch!(request("project.open", { path: "/tmp/demo.scrdance" }));
		await vi.waitFor(() => expect(window!.webContents.send).toHaveBeenCalled());
		const sent = window!.webContents.send.mock.calls[0][1];
		expect(mocks.readProject).toHaveBeenCalledWith("/tmp/demo.scrdance");
		expect(mocks.approve).toHaveBeenCalledWith("/canonical/source.mp4");
		expect(sent.params.projectData).toEqual({
			version: 1,
			videoPath: "/canonical/source.mp4",
			editor: {},
		});
		respond(sent.id, { projectPath: "/tmp/demo.scrdance" });
		await expect(pending).resolves.toEqual({ projectPath: "/tmp/demo.scrdance" });
	});

	it("times out ambiguous renderer work and releases the busy flag without retry", async () => {
		vi.useFakeTimers();
		ready();
		const assertion = expect(mocks.dispatch!(request("project.inspect"))).rejects.toMatchObject(
			{ code: "TIMEOUT" },
		);
		await vi.advanceTimersByTimeAsync(35000);
		await assertion;
		expect(window!.webContents.send).toHaveBeenCalledTimes(1);
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: false });
	});

	it("shuts down pending work and removes IPC listeners", async () => {
		ready();
		const assertion = expect(mocks.dispatch!(request("project.inspect"))).rejects.toMatchObject(
			{ code: "APP_CLOSING" },
		);
		await host.close();
		await assertion;
		expect(mocks.listeners.size).toBe(0);
		expect(mocks.handlers.size).toBe(0);
	});

	it("aborts readiness waits on shutdown without sending a late command", async () => {
		vi.useFakeTimers();
		const assertion = expect(mocks.dispatch!(request("project.inspect"))).rejects.toMatchObject(
			{ code: "APP_CLOSING" },
		);
		await host.close();
		await vi.advanceTimersByTimeAsync(40);
		await assertion;
		expect(window!.webContents.send).not.toHaveBeenCalled();
		await expect(host.start()).rejects.toMatchObject({ code: "APP_CLOSING" });
	});

	it.each([
		"did-start-loading",
		"render-process-gone",
	])("invalidates stale readiness after %s", async (event) => {
		vi.useFakeTimers();
		ready();
		const assertion = expect(mocks.dispatch!(request("project.inspect"))).rejects.toMatchObject(
			{ code: event === "did-start-loading" ? "EDITOR_RELOADING" : "EDITOR_CLOSED" },
		);
		window!.webContents.emit(event);
		await assertion;
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({
			editorReady: false,
			busy: false,
		});
		const retried = mocks.dispatch!(request("project.inspect"));
		await vi.advanceTimersByTimeAsync(40);
		expect(window!.webContents.send).toHaveBeenCalledTimes(1);
		ready();
		await vi.advanceTimersByTimeAsync(40);
		const sent = window!.webContents.send.mock.calls[1][1];
		respond(sent.id, { restored: true });
		await expect(retried).resolves.toEqual({ restored: true });
	});
});

describe("system and background operation routing", () => {
	it("routes declared system commands and persistent job queries to their services", async () => {
		await expect(mocks.dispatch!(request("settings.get"))).resolves.toEqual({
			method: "settings.get",
			params: {},
		});
		expect(mocks.systemDispatch).toHaveBeenCalledWith("settings.get", {});
		mocks.jobMethods.add("jobs.list");
		mocks.jobsActive = true;
		await expect(mocks.dispatch!(request("jobs.list"))).resolves.toEqual({
			method: "jobs.list",
		});
		expect(mocks.jobsDispatch).toHaveBeenCalledWith(request("jobs.list"));
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: true });
		expect(window!.webContents.send).not.toHaveBeenCalled();
	});

	it("requires trusted system readiness independently of editor readiness and targets a dedicated channel", async () => {
		vi.useFakeTimers();
		ready();
		systemReady(makeWindow(99).webContents);
		const pending = mocks.systemOptions!.renderer("settings.get", {});
		await vi.advanceTimersByTimeAsync(40);
		expect(window!.webContents.send).not.toHaveBeenCalled();
		systemReady();
		await vi.advanceTimersByTimeAsync(40);
		const [channel, command] = window!.webContents.send.mock.calls[0];
		expect(channel).toBe("automation:system-request");
		expect(command.method).toBe("settings.get");
		respond(command.id, { wrong: true }, makeWindow(99).webContents);
		respond(command.id, { theme: "dark" });
		await expect(pending).resolves.toEqual({ theme: "dark" });
	});

	it("uses the existing HUD system adapter when there is no editor", async () => {
		window = null;
		systemReady(recorder!.webContents);
		const pending = mocks.systemOptions!.renderer("settings.get", {});
		const [channel, command] = recorder!.webContents.send.mock.calls[0];
		expect(channel).toBe("automation:system-request");
		respond(command.id, { locale: "ru" }, recorder!.webContents);
		await expect(pending).resolves.toEqual({ locale: "ru" });
		expect(window).toBeNull();
	});

	it("invalidates system readiness and rejects pending system work during reload", async () => {
		vi.useFakeTimers();
		systemReady();
		const rejected = expect(
			mocks.systemOptions!.renderer("settings.get", {}),
		).rejects.toMatchObject({ code: "EDITOR_RELOADING" });
		window!.webContents.emit("did-start-loading");
		await rejected;
		const pending = mocks.systemOptions!.renderer("settings.get", {});
		await vi.advanceTimersByTimeAsync(40);
		expect(window!.webContents.send).toHaveBeenCalledTimes(1);
		systemReady();
		await vi.advanceTimersByTimeAsync(40);
		const command = window!.webContents.send.mock.calls[1][1];
		respond(command.id, {});
		await pending;
	});

	it("holds system mutation ownership across awaits and leaves queries available", async () => {
		let finish!: (value: { method: string; params: Record<string, unknown> }) => void;
		mocks.systemDispatch.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const mutation = mocks.dispatch!(request("settings.set", { theme: "dark" }));
		await expect(
			mocks.dispatch!(request("settings.set", { theme: "light" })),
		).rejects.toMatchObject({ code: "BUSY" });
		await expect(
			mocks.dispatch!(request("editor.apply", { expectedRevision: 0, operations: [] })),
		).rejects.toMatchObject({ code: "BUSY" });
		await expect(mocks.dispatch!(request("recording.start"))).rejects.toMatchObject({
			code: "BUSY",
		});
		await expect(mocks.dispatch!(request("settings.get"))).resolves.toMatchObject({
			method: "settings.get",
		});
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: true });
		finish({ method: "settings.set", params: { theme: "dark" } });
		await mutation;
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: false });
	});

	it("refuses editor mutations and recording start while a durable job is active but allows inspection", async () => {
		mocks.jobsActive = true;
		ready();
		await expect(
			mocks.dispatch!(request("video.open", { path: "/tmp/other.mp4" })),
		).rejects.toMatchObject({ code: "BUSY" });
		await expect(mocks.dispatch!(request("recording.start"))).rejects.toMatchObject({
			code: "BUSY",
		});
		expect(mocks.preflight).not.toHaveBeenCalled();
		const inspecting = mocks.dispatch!(request("project.inspect"));
		const command = window!.webContents.send.mock.calls[0][1];
		respond(command.id, { dirty: false });
		await expect(inspecting).resolves.toEqual({ dirty: false });
	});

	it("prevents creation of a new job during a pending system mutation", async () => {
		let finish!: (value: { method: string; params: Record<string, unknown> }) => void;
		mocks.systemDispatch.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const mutation = mocks.dispatch!(request("settings.set", { theme: "dark" }));
		mocks.jobMethods.add("export.start");
		mocks.jobsDispatch.mockImplementationOnce(async (command) => {
			await mocks.jobOptions!.safeIdle();
			return { method: command.method };
		});
		await expect(
			mocks.dispatch!(request("export.start", { outputPath: "/tmp/output.mp4" })),
		).rejects.toMatchObject({ code: "BUSY" });
		finish({ method: "settings.set", params: {} });
		await mutation;
	});

	it("closes owned job resources alongside the socket host", async () => {
		await host.close();
		expect(mocks.jobsClose).toHaveBeenCalledOnce();
		expect(mocks.listeners.has("automation:system-ready")).toBe(false);
	});

	it.each([
		"app.quit",
		"updates.install",
		"app.window.close",
	])("protects unsaved work before %s without trusting only main dirty flags", async (operation) => {
		ready();
		dirty = true;
		await expect(mocks.systemOptions!.safeIdle(operation)).rejects.toMatchObject({
			code: "UNSAVED_CHANGES",
		});
		expect(window!.webContents.send).not.toHaveBeenCalled();
		dirty = false;
		const rejected = expect(mocks.systemOptions!.safeIdle(operation)).rejects.toMatchObject({
			code: "UNSAVED_CHANGES",
		});
		const command = window!.webContents.send.mock.calls[0][1];
		respond(command.id, { dirty: true, readiness: {} });
		await rejected;
	});

	it.each([
		"exporting",
		"generatingCaptions",
		"saving",
		"loading",
	])("refuses system output mutations while the live editor reports %s", async (flag) => {
		ready();
		const rejected = expect(
			mocks.systemOptions!.safeIdle("extensions.settings.set"),
		).rejects.toMatchObject({ code: "BUSY" });
		const command = window!.webContents.send.mock.calls[0][1];
		respond(command.id, { dirty: false, readiness: { [flag]: true } });
		await rejected;
	});

	it("checks job ownership before executing unsafe system effects", async () => {
		mocks.jobsActive = true;
		await expect(mocks.systemOptions!.safeIdle("updates.install")).rejects.toMatchObject({
			code: "BUSY",
		});
		expect(window!.webContents.send).not.toHaveBeenCalled();
	});
});

describe("scoped automation project loading", () => {
	it.each([
		"PROJECT_CHANGED",
		"UNSAVED_CHANGES",
		"INVALID_PROJECT",
		"BUSY",
	])("restores prior main context and media approvals when rejected before apply: %s", async (code) => {
		const { completion, sent } = await beginProjectOpen();
		// Capture must occur at invoke time, after a potentially long source probe.
		const previousSession = {
			videoPath: "/late/source.mp4",
			webcamPath: "/late/camera.mp4",
			timeOffsetMs: 300,
		};
		mocks.context.project = "/late/project.scrdance";
		mocks.context.video = previousSession.videoPath;
		mocks.context.session = previousSession;
		mocks.context.approved.clear();
		mocks.context.approved.add("/late/source.mp4");
		mocks.context.approved.add("/late/camera.mp4");
		await expect(invokeProjectOpen(sent.id, sent.params.path)).resolves.toMatchObject({
			success: true,
		});
		expect(mocks.context.project).toBe("/tmp/target.scrdance");
		const rejected = expect(completion).rejects.toMatchObject({ code });
		respondError(sent.id, code);
		await rejected;
		expect(mocks.context.project).toBe("/late/project.scrdance");
		expect(mocks.context.video).toBe("/late/source.mp4");
		expect(mocks.context.session).toBe(previousSession);
		expect([...mocks.context.approved]).toEqual(["/late/source.mp4", "/late/camera.mp4"]);
	});

	it("keeps successful opens and their media context committed", async () => {
		const { completion, sent } = await beginProjectOpen();
		await invokeProjectOpen(sent.id, sent.params.path);
		respond(sent.id, { projectPath: "/tmp/target.scrdance" });
		await completion;
		expect(mocks.context.project).toBe("/tmp/target.scrdance");
		expect(mocks.context.video).toBe("/canonical/source.mp4");
		expect([...mocks.context.approved]).toEqual(["/canonical/source.mp4"]);
	});

	it.each([
		false,
		true,
	])("restores approvals on loader failures, including exceptions: %s", async (throws) => {
		const { completion, sent } = await beginProjectOpen();
		const previousSession = mocks.context.session;
		mocks.loadProject.mockImplementationOnce(async () => {
			// Failure can happen after the loader replaces approvals, before metadata changes.
			mocks.context.approved.clear();
			mocks.context.approved.add("/failed/source.mp4");
			if (throws) throw new Error("Filesystem write failed");
			return { success: false, message: "Cannot read project" };
		});
		await expect(invokeProjectOpen(sent.id, sent.params.path)).resolves.toMatchObject({
			success: false,
		});
		expect(mocks.context.project).toBe("/original/project.scrdance");
		expect(mocks.context.session).toBe(previousSession);
		expect([...mocks.context.approved]).toEqual([
			"/original/source.mp4",
			"/original/webcam.mp4",
		]);
		const rejected = expect(completion).rejects.toMatchObject({ code: "PROJECT_OPEN_FAILED" });
		respondError(sent.id, "PROJECT_OPEN_FAILED");
		await rejected;
	});

	it("requires the targeted pending id, sender, command and exact canonical path, and refuses duplicates", async () => {
		const { completion, sent } = await beginProjectOpen();
		for (const args of [
			["not-pending", sent.params.path, window!.webContents],
			[sent.id, "/wrong/project.scrdance", window!.webContents],
			[sent.id, sent.params.path, makeWindow(91).webContents],
		] as const) {
			await expect(invokeProjectOpen(...args)).resolves.toMatchObject({
				code: "ACCESS_DENIED",
			});
		}
		expect(mocks.loadProject).not.toHaveBeenCalled();
		await invokeProjectOpen(sent.id, sent.params.path);
		await expect(invokeProjectOpen(sent.id, sent.params.path)).resolves.toMatchObject({
			code: "BUSY",
		});
		expect(mocks.loadProject).toHaveBeenCalledTimes(1);
		respond(sent.id, {});
		await completion;
		await expect(invokeProjectOpen(sent.id, sent.params.path)).resolves.toMatchObject({
			code: "ACCESS_DENIED",
		});
		const inspecting = mocks.dispatch!(request("project.inspect"));
		const inspected = window!.webContents.send.mock.calls[1][1] as AutomationRequest;
		await expect(
			invokeProjectOpen(inspected.id, "/tmp/target.scrdance"),
		).resolves.toMatchObject({ code: "ACCESS_DENIED" });
		respond(inspected.id, {});
		await inspecting;
	});

	it.each([
		"/newer/project.scrdance",
		"/tmp/target.scrdance",
	])("does not revert a newer user open of %s", async (target) => {
		const { completion, sent } = await beginProjectOpen();
		await invokeProjectOpen(sent.id, sent.params.path);
		const newerSession = { videoPath: "/newer/source.mp4" };
		mocks.context.project = target;
		mocks.context.video = newerSession.videoPath;
		mocks.context.session = newerSession;
		mocks.context.approved.clear();
		mocks.context.approved.add(newerSession.videoPath);
		const rejected = expect(completion).rejects.toMatchObject({ code: "PROJECT_CHANGED" });
		respondError(sent.id, "PROJECT_CHANGED");
		await rejected;
		expect(mocks.context.project).toBe(target);
		expect(mocks.context.session).toBe(newerSession);
		expect([...mocks.context.approved]).toEqual([newerSession.videoPath]);
	});

	it("does not roll back an ambiguous post-application media error", async () => {
		const { completion, sent } = await beginProjectOpen();
		await invokeProjectOpen(sent.id, sent.params.path);
		const rejected = expect(completion).rejects.toMatchObject({ code: "MEDIA_NOT_READY" });
		respondError(sent.id, "MEDIA_NOT_READY");
		await rejected;
		expect(mocks.context.project).toBe("/tmp/target.scrdance");
		expect([...mocks.context.approved]).toEqual(["/canonical/source.mp4"]);
	});

	it("does not roll back on an ambiguous renderer timeout after main has loaded", async () => {
		vi.useFakeTimers();
		const { completion, sent } = await beginProjectOpen();
		await invokeProjectOpen(sent.id, sent.params.path);
		const timedOut = expect(completion).rejects.toMatchObject({ code: "TIMEOUT" });
		await vi.advanceTimersByTimeAsync(35000);
		await timedOut;
		expect(mocks.context.project).toBe("/tmp/target.scrdance");
		expect([...mocks.context.approved]).toEqual(["/canonical/source.mp4"]);
		await expect(invokeProjectOpen(sent.id, sent.params.path)).resolves.toMatchObject({
			code: "ACCESS_DENIED",
		});
	});
});

describe("recorder routing and concurrency", () => {
	it("reads permissions and project library in main without activating either renderer", async () => {
		expect(await mocks.dispatch!(request("permissions.status"))).toEqual({
			screen: "granted",
			microphone: "granted",
			camera: "denied",
			accessibility: false,
		});
		expect(mocks.accessibility).toHaveBeenCalledWith(false);
		expect(await mocks.dispatch!(request("project.list"))).toEqual({
			projectsDir: "/library/projects",
			entries: [{ path: "/library/projects/demo.scrdance", name: "demo" }],
		});
		expect(window!.webContents.send).not.toHaveBeenCalled();
		expect(recorder!.webContents.send).not.toHaveBeenCalled();
	});
	it("trusts only HUD readiness and routes recorder work to the HUD", async () => {
		vi.useFakeTimers();
		recorderReady(window!.webContents);
		mocks.listeners.get("automation:ready")!({ sender: recorder!.webContents });
		const pending = mocks.dispatch!(request("sources.list"));
		await vi.advanceTimersByTimeAsync(40);
		expect(recorder!.webContents.send).not.toHaveBeenCalled();
		recorderReady();
		await vi.advanceTimersByTimeAsync(40);
		const sent = recorder!.webContents.send.mock.calls[0][1] as AutomationRequest;
		expect(sent.method).toBe("sources.list");
		respond(sent.id, { spoofed: true }, window!.webContents);
		respond(sent.id, { sources: ["screen:0:0"] }, recorder!.webContents);
		await expect(pending).resolves.toEqual({ sources: ["screen:0:0"] });
		expect(window!.webContents.send).not.toHaveBeenCalled();
	});
	it.each([
		"recording.configure",
		"sources.select",
		"devices.list",
		"permissions.request",
	] as const)("routes %s without opening the editor", async (method) => {
		recorderReady();
		const pending = mocks.dispatch!(request(method));
		const sent = recorder!.webContents.send.mock.calls[0][1] as AutomationRequest;
		expect(sent.method).toBe(method);
		respond(sent.id, { done: true }, recorder!.webContents);
		await expect(pending).resolves.toEqual({ done: true });
		expect(window!.webContents.send).not.toHaveBeenCalled();
	});
	it.each([
		"recording.cancel",
		"recording.stop",
	] as const)("permits %s to interrupt a pending start without releasing its lock", async (method) => {
		window = null;
		recorderReady();
		const starting = mocks.dispatch!(request("recording.start"));
		const failed = expect(starting).rejects.toMatchObject({ code: "CANCELLED" });
		await expect(mocks.dispatch!(request("recording.configure"))).rejects.toMatchObject({
			code: "BUSY",
		});
		await expect(mocks.dispatch!(request("project.inspect"))).rejects.toMatchObject({
			code: "RECORDING_ACTIVE",
		});
		const querying = mocks.dispatch!(request("recording.status"));
		const canceling = mocks.dispatch!(request(method));
		const [start, query, cancel] = recorder!.webContents.send.mock.calls.map(
			(call) => call[1] as AutomationRequest,
		);
		expect([start.method, query.method, cancel.method]).toEqual([
			"recording.start",
			"recording.status",
			method,
		]);
		respond(query.id, { phase: "countdown" }, recorder!.webContents);
		respond(cancel.id, { cancelled: true }, recorder!.webContents);
		await expect(querying).resolves.toEqual({ phase: "countdown" });
		await expect(canceling).resolves.toEqual({ cancelled: true });
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: true });
		mocks.listeners.get("automation:response")!(
			{ sender: recorder!.webContents },
			{ id: start.id, error: { code: "CANCELLED", message: "Cancelled" } },
		);
		await failed;
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: false });
	});
	it.each([
		[{ dirty: true }, "UNSAVED_CHANGES"],
		[{ readiness: { exporting: true } }, "BUSY"],
		[{ readiness: { generatingCaptions: true } }, "BUSY"],
	])("checks live editor readiness before starting recording: %j", async (inspection, code) => {
		ready();
		recorderReady();
		const starting = mocks.dispatch!(request("recording.start"));
		const rejected = expect(starting).rejects.toMatchObject({ code });
		const inspected = window!.webContents.send.mock.calls[0][1] as AutomationRequest;
		expect(inspected.method).toBe("project.inspect");
		expect(recorder!.webContents.send).not.toHaveBeenCalled();
		respond(inspected.id, inspection);
		await rejected;
		expect(recorder!.webContents.send).not.toHaveBeenCalled();
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: false });
	});
	it("starts recording only after the live editor passes inspection", async () => {
		ready();
		recorderReady();
		const starting = mocks.dispatch!(request("recording.start"));
		const inspected = window!.webContents.send.mock.calls[0][1] as AutomationRequest;
		respond(inspected.id, {
			dirty: false,
			readiness: { exporting: false, generatingCaptions: false },
		});
		await vi.waitFor(() => expect(recorder!.webContents.send).toHaveBeenCalled());
		const started = recorder!.webContents.send.mock.calls[0][1] as AutomationRequest;
		expect(started.method).toBe("recording.start");
		respond(started.id, { phase: "recording" }, recorder!.webContents);
		await expect(starting).resolves.toEqual({ phase: "recording" });
	});
	it("rejects recovery over dirty edits before activating either renderer", async () => {
		dirty = true;
		await expect(mocks.dispatch!(request("recording.recover"))).rejects.toMatchObject({
			code: "UNSAVED_CHANGES",
		});
		expect(window!.webContents.send).not.toHaveBeenCalled();
		expect(recorder!.webContents.send).not.toHaveBeenCalled();
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: false });
	});
	it.each([
		[{ dirty: true }, "UNSAVED_CHANGES"],
		[{ readiness: { exporting: true } }, "BUSY"],
		[{ readiness: { generatingCaptions: true } }, "BUSY"],
	])("inspects the editor before recovery to protect live work: %j", async (inspection, code) => {
		ready();
		recorderReady();
		const recovering = mocks.dispatch!(request("recording.recover"));
		const rejected = expect(recovering).rejects.toMatchObject({ code });
		const inspected = window!.webContents.send.mock.calls[0][1] as AutomationRequest;
		expect(inspected.method).toBe("project.inspect");
		respond(inspected.id, inspection);
		await rejected;
		expect(recorder!.webContents.send).not.toHaveBeenCalled();
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: false });
	});
	it("routes recovery after the editor passes inspection", async () => {
		ready();
		recorderReady();
		const recovering = mocks.dispatch!(request("recording.recover"));
		const inspected = window!.webContents.send.mock.calls[0][1] as AutomationRequest;
		respond(inspected.id, {
			dirty: false,
			readiness: { exporting: false, generatingCaptions: false },
		});
		await vi.waitFor(() => expect(recorder!.webContents.send).toHaveBeenCalled());
		const recovered = recorder!.webContents.send.mock.calls[0][1] as AutomationRequest;
		expect(recovered.method).toBe("recording.recover");
		respond(recovered.id, { session: { videoPath: "/recovered.mp4" } }, recorder!.webContents);
		await vi.waitFor(() => expect(window!.webContents.send).toHaveBeenCalledTimes(2));
		const adoption = window!.webContents.send.mock.calls[1][1] as AutomationRequest;
		expect(adoption.method).toBe("project.inspect");
		respond(adoption.id, {
			project: { videoPath: "/recovered.mp4" },
			readiness: {
				loading: false,
				previewReady: true,
				videoLoaded: true,
				cursorTelemetryLoaded: true,
			},
		});
		await expect(recovering).resolves.toEqual({
			session: { videoPath: "/recovered.mp4" },
			editor: { opened: true, videoPath: "/recovered.mp4" },
		});
	});
	it("keeps readonly recorder queries available during an editor operation", async () => {
		ready();
		recorderReady();
		const editing = mocks.dispatch!(request("project.inspect"));
		const inspected = window!.webContents.send.mock.calls[0][1] as AutomationRequest;
		const querying = mocks.dispatch!(request("devices.list"));
		const queried = recorder!.webContents.send.mock.calls[0][1] as AutomationRequest;
		await expect(
			mocks.dispatch!(request("sources.select", { sourceId: "screen:1:0" })),
		).rejects.toMatchObject({ code: "BUSY" });
		respond(queried.id, { cameras: [] }, recorder!.webContents);
		respond(inspected.id, { project: true });
		await expect(querying).resolves.toEqual({ cameras: [] });
		await editing;
	});
	it("rejects recording over dirty edits and blocks editor work for countdowns without an interval timer", async () => {
		dirty = true;
		await expect(mocks.dispatch!(request("recording.start"))).rejects.toMatchObject({
			code: "UNSAVED_CHANGES",
		});
		expect(recorder!.webContents.send).not.toHaveBeenCalled();
		dirty = false;
		mocks.countdownInProgress = true;
		await expect(mocks.dispatch!(request("project.save"))).rejects.toMatchObject({
			code: "RECORDING_ACTIVE",
		});
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({
			countdownActive: true,
		});
		expect(mocks.prepareSave).not.toHaveBeenCalled();
	});
	it.each([
		"recording.stop",
		"recording.cancel",
	] as const)("holds the lock for ordinary %s even after native capture is inactive", async (method) => {
		recorderReady();
		mocks.recording = true;
		const completion = mocks.dispatch!(request(method));
		const sent = recorder!.webContents.send.mock.calls[0][1] as AutomationRequest;
		// Native capture ends before webcam/microphone/cursor finalization completes.
		mocks.recording = false;
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({
			busy: true,
			recording: false,
		});
		await expect(
			mocks.dispatch!(request("project.open", { path: "/tmp/other.scrdance" })),
		).rejects.toMatchObject({ code: "RECORDING_ACTIVE" });
		await expect(mocks.dispatch!(request("project.save"))).rejects.toMatchObject({
			code: "RECORDING_ACTIVE",
		});
		await expect(mocks.dispatch!(request("recording.start"))).rejects.toMatchObject({
			code: "BUSY",
		});
		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.prepareSave).not.toHaveBeenCalled();
		expect(window!.webContents.send).not.toHaveBeenCalled();
		respond(sent.id, { finished: true }, recorder!.webContents);
		await expect(completion).resolves.toEqual({ finished: true });
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({
			busy: false,
			recording: false,
		});
	});
	it("allows long recorder finalization and releases its lock after the recorder timeout", async () => {
		vi.useFakeTimers();
		recorderReady();
		const completion = mocks.dispatch!(request("recording.stop"));
		const timedOut = expect(completion).rejects.toMatchObject({ code: "TIMEOUT" });
		await vi.advanceTimersByTimeAsync(35_000);
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: true });
		await vi.advanceTimersByTimeAsync(80_000);
		await timedOut;
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: false });
		expect(recorder!.webContents.send).toHaveBeenCalledTimes(1);
	});
	it("invalidates pending HUD requests when its renderer exits", async () => {
		recorderReady();
		const completion = mocks.dispatch!(request("recording.stop"));
		const rejected = expect(completion).rejects.toMatchObject({ code: "EDITOR_CLOSED" });
		recorder!.webContents.emit("render-process-gone");
		await rejected;
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: false });
	});
});

describe("scoped project save", () => {
	const project = { version: 1, videoPath: "/original/source.mp4", editor: {} };
	async function beginSave(params = {}) {
		ready();
		const completion = mocks.dispatch!(request("project.save", params));
		await vi.waitFor(() => expect(window!.webContents.send).toHaveBeenCalled());
		const sent = window!.webContents.send.mock.calls[0][1] as AutomationRequest;
		return { completion, sent };
	}
	it("prepares a save target without leaking it into the renderer command and persists the current project", async () => {
		const { completion, sent } = await beginSave();
		expect(mocks.prepareSave).toHaveBeenCalledWith(
			undefined,
			"/original/project.scrdance",
			undefined,
		);
		expect(sent.params).toEqual({
			expectedEditorContext: {
				projectPath: "/original/project.scrdance",
				videoPath: "/original/source.mp4",
			},
		});
		await expect(invokeProjectSave(sent.id, project, "thumbnail")).resolves.toEqual({
			success: true,
			path: "/canonical/saved.scrdance",
		});
		expect(mocks.persistSave).toHaveBeenCalledWith(
			{ path: "/canonical/saved.scrdance" },
			project,
		);
		expect(mocks.context.project).toBe("/canonical/saved.scrdance");
		expect(mocks.saveThumbnail).toHaveBeenCalledWith("/canonical/saved.scrdance", "thumbnail");
		expect(mocks.rememberRecent).toHaveBeenCalledWith("/canonical/saved.scrdance");
		respond(sent.id, { projectPath: "/canonical/saved.scrdance" });
		await completion;
	});
	it("passes explicit overwrite policy to main preparation", async () => {
		const { completion, sent } = await beginSave({
			path: "/tmp/other.scrdance",
			overwrite: true,
		});
		expect(mocks.prepareSave).toHaveBeenCalledWith(
			"/tmp/other.scrdance",
			"/original/project.scrdance",
			true,
		);
		expect(sent.params).toEqual({
			path: "/tmp/other.scrdance",
			overwrite: true,
			expectedEditorContext: {
				projectPath: "/original/project.scrdance",
				videoPath: "/original/source.mp4",
			},
		});
		await invokeProjectSave(sent.id, project);
		respond(sent.id, {});
		await completion;
	});
	it("denies unknown IDs, spoofed senders and non-save commands, and permits a save only once", async () => {
		const { completion, sent } = await beginSave();
		await expect(invokeProjectSave("other-id", project)).resolves.toMatchObject({
			code: "ACCESS_DENIED",
		});
		await expect(
			invokeProjectSave(sent.id, project, null, recorder!.webContents),
		).resolves.toMatchObject({ code: "ACCESS_DENIED" });
		expect(mocks.persistSave).not.toHaveBeenCalled();
		await invokeProjectSave(sent.id, project);
		await expect(invokeProjectSave(sent.id, project)).resolves.toMatchObject({ code: "BUSY" });
		expect(mocks.persistSave).toHaveBeenCalledTimes(1);
		respond(sent.id, {});
		await completion;
		await expect(invokeProjectSave(sent.id, project)).resolves.toMatchObject({
			code: "ACCESS_DENIED",
		});
		const inspecting = mocks.dispatch!(request("project.inspect"));
		const inspected = window!.webContents.send.mock.calls[1][1] as AutomationRequest;
		await expect(invokeProjectSave(inspected.id, project)).resolves.toMatchObject({
			code: "ACCESS_DENIED",
		});
		respond(inspected.id, {});
		await inspecting;
	});
	it("binds the save context before asynchronous target preparation", async () => {
		ready();
		let prepared!: (value: { path: string }) => void;
		mocks.prepareSave.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					prepared = resolve;
				}),
		);
		const completion = mocks.dispatch!(request("project.save"));
		const rejected = expect(completion).rejects.toMatchObject({ code: "PROJECT_CHANGED" });
		await vi.waitFor(() => expect(mocks.prepareSave).toHaveBeenCalled());
		expect(mocks.prepareSave).toHaveBeenCalledWith(
			undefined,
			"/original/project.scrdance",
			undefined,
		);
		mocks.context.project = "/newer/project.scrdance";
		mocks.context.video = "/newer/source.mp4";
		mocks.context.session = { videoPath: "/newer/source.mp4" };
		prepared({ path: "/original/project.scrdance" });
		await rejected;
		expect(window!.webContents.send).not.toHaveBeenCalled();
		expect(mocks.persistSave).not.toHaveBeenCalled();
		expect(mocks.context.project).toBe("/newer/project.scrdance");
	});
	it("keeps the original save context while waiting for editor readiness", async () => {
		vi.useFakeTimers();
		const completion = mocks.dispatch!(request("project.save"));
		const rejected = expect(completion).rejects.toMatchObject({ code: "PROJECT_CHANGED" });
		await vi.advanceTimersByTimeAsync(40);
		expect(mocks.prepareSave).toHaveBeenCalled();
		expect(window!.webContents.send).not.toHaveBeenCalled();
		mocks.context.project = "/newer/project.scrdance";
		mocks.context.video = "/newer/source.mp4";
		mocks.context.session = { videoPath: "/newer/source.mp4" };
		ready();
		await vi.advanceTimersByTimeAsync(40);
		await rejected;
		expect(window!.webContents.send).not.toHaveBeenCalled();
		expect(mocks.persistSave).not.toHaveBeenCalled();
		expect(mocks.context.project).toBe("/newer/project.scrdance");
	});
	it("rejects a stale project save before writing when the user switches projects", async () => {
		const { completion, sent } = await beginSave();
		mocks.context.project = "/newer/project.scrdance";
		await expect(invokeProjectSave(sent.id, project)).resolves.toMatchObject({
			success: false,
			code: "PROJECT_CHANGED",
		});
		expect(mocks.persistSave).not.toHaveBeenCalled();
		expect(mocks.context.project).toBe("/newer/project.scrdance");
		const rejected = expect(completion).rejects.toMatchObject({ code: "PROJECT_CHANGED" });
		respondError(sent.id, "PROJECT_CHANGED");
		await rejected;
	});
	it("preserves a newer project when context changes during a durable save", async () => {
		let finish!: (value: { path: string }) => void;
		mocks.persistSave.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const { completion, sent } = await beginSave();
		const saving = invokeProjectSave(sent.id, project);
		mocks.context.project = "/newer/project.scrdance";
		mocks.context.video = "/newer/video.mp4";
		finish({ path: "/canonical/saved.scrdance" });
		await expect(saving).resolves.toMatchObject({ success: false, code: "PROJECT_CHANGED" });
		expect(mocks.context.project).toBe("/newer/project.scrdance");
		expect(mocks.context.video).toBe("/newer/video.mp4");
		expect(mocks.saveThumbnail).not.toHaveBeenCalled();
		const rejected = expect(completion).rejects.toMatchObject({ code: "PROJECT_CHANGED" });
		respondError(sent.id, "PROJECT_CHANGED");
		await rejected;
	});
	it("preserves durable save success when optional library metadata fails", async () => {
		mocks.saveThumbnail.mockRejectedValueOnce(new Error("No thumbnail"));
		mocks.rememberRecent.mockRejectedValueOnce(new Error("No recent metadata"));
		const { completion, sent } = await beginSave();
		await expect(invokeProjectSave(sent.id, project)).resolves.toMatchObject({ success: true });
		expect(mocks.context.project).toBe("/canonical/saved.scrdance");
		respond(sent.id, {});
		await completion;
	});
	it("keeps the prior project context on persistence failure and prevents ambiguous retries", async () => {
		mocks.persistSave.mockRejectedValueOnce(
			new AutomationError("OUTPUT_EXISTS", "Target already exists"),
		);
		const { completion, sent } = await beginSave();
		await expect(invokeProjectSave(sent.id, project)).resolves.toMatchObject({
			success: false,
			code: "OUTPUT_EXISTS",
		});
		expect(mocks.context.project).toBe("/original/project.scrdance");
		expect(mocks.saveThumbnail).not.toHaveBeenCalled();
		await expect(invokeProjectSave(sent.id, project)).resolves.toMatchObject({ code: "BUSY" });
		const rejected = expect(completion).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
		respondError(sent.id, "OUTPUT_EXISTS");
		await rejected;
	});
});

describe("recording adoption in an existing editor", () => {
	const capturedPath = "/captured/new-recording.mp4";
	async function stoppedRecording() {
		ready();
		recorderReady();
		mocks.recording = true;
		const previous = {
			project: mocks.context.project,
			video: mocks.context.video,
			session: mocks.context.session,
		};
		const completion = mocks.dispatch!(request("recording.stop"));
		const stopped = recorder!.webContents.send.mock.calls[0][1] as AutomationRequest;
		mocks.recording = false;
		mocks.context.project = null;
		mocks.context.video = capturedPath;
		mocks.context.session = {
			videoPath: capturedPath,
			webcamPath: "/captured/camera.mp4",
			timeOffsetMs: 25,
		};
		respond(
			stopped.id,
			{ session: mocks.context.session, warnings: ["Existing capture warning"] },
			recorder!.webContents,
		);
		await vi.waitFor(() => expect(window!.webContents.send).toHaveBeenCalled());
		const inspection = window!.webContents.send.mock.calls[0][1] as AutomationRequest;
		expect(inspection.method).toBe("project.inspect");
		return { completion, inspection, previous };
	}
	async function oldEditorInspected(inspection: AutomationRequest) {
		respond(inspection.id, {
			project: { videoPath: "/original/source.mp4" },
			dirty: false,
			readiness: {
				loading: false,
				previewReady: true,
				videoLoaded: true,
				cursorTelemetryLoaded: true,
			},
		});
		await vi.waitFor(() => expect(window!.webContents.send).toHaveBeenCalledTimes(2));
		const opened = window!.webContents.send.mock.calls[1][1] as AutomationRequest;
		expect(opened).toMatchObject({ method: "video.open", params: { path: capturedPath } });
		return opened;
	}
	it("adopts a newly captured recording through the normal fresh-video controller", async () => {
		const { completion, inspection } = await stoppedRecording();
		expect(mocks.preflight).toHaveBeenCalledWith("video.open", capturedPath);
		expect(mocks.approve).toHaveBeenCalledWith(capturedPath);
		const opened = await oldEditorInspected(inspection);
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: true });
		respond(opened.id, { readiness: { previewReady: true } });
		await expect(completion).resolves.toMatchObject({
			session: {
				videoPath: capturedPath,
				webcamPath: "/captured/camera.mp4",
				timeOffsetMs: 25,
			},
			editor: { opened: true, videoPath: capturedPath },
			warnings: ["Existing capture warning"],
		});
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: false });
	});
	it("validates an aliased recording path without changing its session identity during adoption", async () => {
		mocks.preflight.mockResolvedValueOnce("/canonical/new-recording.mp4");
		const { completion, inspection } = await stoppedRecording();
		const capturedSession = mocks.context.session;
		expect(mocks.preflight).toHaveBeenCalledWith("video.open", capturedPath);
		expect(mocks.approve).toHaveBeenCalledWith(capturedPath);
		const opened = await oldEditorInspected(inspection);
		expect(opened.params).toEqual({ path: capturedPath });
		respond(opened.id, { readiness: { previewReady: true } });
		const result = (await completion) as {
			session: unknown;
			editor: { opened: boolean; videoPath: string };
		};
		expect(result.editor).toEqual({ opened: true, videoPath: capturedPath });
		expect(result.session).toBe(capturedSession);
		expect(mocks.context.session).toBe(capturedSession);
		expect(mocks.context.session).toMatchObject({
			videoPath: capturedPath,
			webcamPath: "/captured/camera.mp4",
			timeOffsetMs: 25,
		});
	});
	it("waits for cursor and preview readiness when the editor already shows the captured source", async () => {
		vi.useFakeTimers();
		const { completion, inspection } = await stoppedRecording();
		respond(inspection.id, {
			project: { videoPath: capturedPath },
			readiness: {
				loading: false,
				previewReady: true,
				videoLoaded: true,
				cursorTelemetryLoaded: false,
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(window!.webContents.send).toHaveBeenCalledTimes(1);
		expect(await mocks.dispatch!(request("app.status"))).toMatchObject({ busy: true });
		await vi.advanceTimersByTimeAsync(50);
		const inspectedAgain = window!.webContents.send.mock.calls[1][1] as AutomationRequest;
		expect(inspectedAgain.method).toBe("project.inspect");
		respond(inspectedAgain.id, {
			project: { videoPath: capturedPath },
			readiness: {
				loading: false,
				previewReady: true,
				videoLoaded: true,
				cursorTelemetryLoaded: true,
			},
		});
		await expect(completion).resolves.toMatchObject({
			editor: { opened: true, videoPath: capturedPath },
		});
		expect(
			window!.webContents.send.mock.calls.every(
				(call) => (call[1] as AutomationRequest).method === "project.inspect",
			),
		).toBe(true);
	});
	it.each([
		"UNSAVED_CHANGES",
		"BUSY",
	])("keeps a completed recording and restores the old document context after %s refusal", async (code) => {
		const { completion, inspection, previous } = await stoppedRecording();
		const opened = await oldEditorInspected(inspection);
		respondError(opened.id, code);
		await expect(completion).resolves.toMatchObject({
			session: { videoPath: capturedPath },
			editor: { opened: false, error: { code } },
			warnings: expect.arrayContaining([
				expect.stringContaining(capturedPath),
				"Existing capture warning",
			]),
		});
		expect(mocks.context.project).toBe(previous.project);
		expect(mocks.context.video).toBe(previous.video);
		expect(mocks.context.session).toBe(previous.session);
	});
	it("does not restore an older context over a newer user project after a refused handoff", async () => {
		const { completion, inspection } = await stoppedRecording();
		const opened = await oldEditorInspected(inspection);
		const newerSession = { videoPath: "/newer/source.mp4" };
		mocks.context.project = "/newer/project.scrdance";
		mocks.context.video = newerSession.videoPath;
		mocks.context.session = newerSession;
		respondError(opened.id, "UNSAVED_CHANGES");
		await expect(completion).resolves.toMatchObject({
			session: { videoPath: capturedPath },
			editor: { opened: false },
		});
		expect(mocks.context.project).toBe("/newer/project.scrdance");
		expect(mocks.context.video).toBe(newerSession.videoPath);
		expect(mocks.context.session).toBe(newerSession);
	});
	it("retains the newer context if it changes while the handoff inspection is pending", async () => {
		const { completion, inspection } = await stoppedRecording();
		const newerSession = { videoPath: "/newer/source.mp4" };
		mocks.context.project = "/newer/project.scrdance";
		mocks.context.video = newerSession.videoPath;
		mocks.context.session = newerSession;
		respond(inspection.id, {
			project: { videoPath: "/original/source.mp4" },
			readiness: { loading: false },
		});
		await expect(completion).resolves.toMatchObject({
			session: { videoPath: capturedPath },
			editor: { opened: false, error: { code: "PROJECT_CHANGED" } },
		});
		expect(window!.webContents.send).toHaveBeenCalledTimes(1);
		expect(mocks.context.project).toBe("/newer/project.scrdance");
		expect(mocks.context.session).toBe(newerSession);
	});
});
