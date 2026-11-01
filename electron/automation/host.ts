import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
	app,
	type BrowserWindow,
	dialog,
	type IpcMainEvent,
	type IpcMainInvokeEvent,
	ipcMain,
	systemPreferences,
} from "electron";
import {
	AUTOMATION_COMMANDS,
	AUTOMATION_PROTOCOL_VERSION,
	AutomationError,
	type AutomationRequest,
	type AutomationResponse,
	toAutomationError,
} from "../../shared/automation";
import {
	collectEditorAutomationMediaPaths,
	EDITOR_AUTOMATION_COMMANDS,
} from "../../shared/editorAutomation";
import type { JobJson, JobObject } from "../../shared/jobAutomation";
import {
	isSystemAutomationCommand,
	SYSTEM_AUTOMATION_COMMANDS,
} from "../../shared/systemAutomation";
import { USER_DATA_PATH } from "../appPaths";
import {
	getProjectsDir,
	listProjectLibraryEntries,
	loadProjectFromPath,
	rememberApprovedLocalReadPath,
	rememberRecentProject,
	saveProjectThumbnail,
} from "../ipc/project/manager";
import {
	approvedLocalReadPaths,
	countdownInProgress,
	countdownTimer,
	currentProjectPath,
	currentRecordingSession,
	currentVideoPath,
	ffmpegScreenRecordingActive,
	nativeScreenRecordingActive,
	setCurrentProjectPath,
	setCurrentRecordingSession,
	setCurrentVideoPath,
	windowsNativeCaptureActive,
} from "../ipc/state";
import { persistPreview, preflightOpen, preparePreviewPath, readAutomationProject } from "./files";
import { createAutomationJobs } from "./jobHost";
import {
	type PreparedAutomationProjectSave,
	persistAutomationProject,
	prepareAutomationProjectSave,
} from "./projectSave";
import { startAutomationSocket } from "./socketServer";
import { createSystemAutomation } from "./system";

type ProjectContext = {
	projectPath: string | null;
	videoPath: string | null;
	session: typeof currentRecordingSession;
};
const projectContext = (): ProjectContext => ({
	projectPath: currentProjectPath,
	videoPath: currentVideoPath,
	session: currentRecordingSession,
});
const ownsProjectContext = (context: ProjectContext) =>
	context.projectPath === currentProjectPath &&
	context.videoPath === currentVideoPath &&
	context.session === currentRecordingSession;

export function createAutomationHost(options: {
	getEditor: () => BrowserWindow | null;
	createEditor: () => BrowserWindow;
	getMainWindow?: () => BrowserWindow | null;
	openWindow?: (kind: "editor" | "recorder" | "sources") => unknown;
	quit?: () => void;
	sendUpdate?: (channel: "update-toast-state", payload: unknown) => boolean;
	broadcastJobs?: () => void;
	broadcastSystem?: (payload: Record<string, unknown>) => void;
	getRecorder?: () => BrowserWindow | null;
	createRecorder?: () => BrowserWindow;
	hasUnsavedChanges: () => boolean;
}) {
	const ready = new Set<number>();
	const systemReady = new Set<number>();
	const pending = new Map<
		string,
		{
			sender: number;
			command: AutomationRequest;
			projectOpenStarted?: boolean;
			rollbackProjectOpen?: () => void;
			saveTarget?: PreparedAutomationProjectSave;
			saveStarted?: boolean;
			saveContext?: ProjectContext;
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	let transport: Awaited<ReturnType<typeof startAutomationSocket>> | null = null;
	let starting: Promise<void> | null = null;
	let busy = false;
	let recorderBusy = false;
	let systemBusy = false;
	let closed = false;
	const watched = new Map<
		number,
		{
			contents: BrowserWindow["webContents"];
			loading: () => void;
			gone: () => void;
			destroyed: () => void;
		}
	>();

	function rejectEditorRequests(sender: number, error: AutomationError) {
		ready.delete(sender);
		systemReady.delete(sender);
		for (const [requestId, request] of pending) {
			if (request.sender !== sender) continue;
			clearTimeout(request.timer);
			pending.delete(requestId);
			request.reject(error);
		}
	}
	function watchEditor(window: BrowserWindow) {
		const contents = window.webContents;
		const id = contents.id;
		if (watched.has(id)) return;
		const loading = () =>
			rejectEditorRequests(
				id,
				new AutomationError(
					"EDITOR_RELOADING",
					"Editor reloaded during the command. Inspect the live state before retrying.",
				),
			);
		const gone = () =>
			rejectEditorRequests(
				id,
				new AutomationError("EDITOR_CLOSED", "Editor process exited during the command."),
			);
		const destroyed = () => {
			gone();
			watched.delete(id);
		};
		watched.set(id, { contents, loading, gone, destroyed });
		contents.on("did-start-loading", loading);
		contents.on("render-process-gone", gone);
		contents.once("destroyed", destroyed);
	}

	function onReady(event: IpcMainEvent) {
		const window = options.getEditor();
		if (
			!closed &&
			window &&
			!window.isDestroyed() &&
			event.sender.id === window.webContents.id
		) {
			watchEditor(window);
			const id = event.sender.id;
			ready.add(id);
		}
	}
	function onRecorderReady(event: IpcMainEvent) {
		const window = options.getRecorder?.();
		if (
			!closed &&
			window &&
			!window.isDestroyed() &&
			event.sender.id === window.webContents.id
		) {
			watchEditor(window);
			ready.add(event.sender.id);
		}
	}
	function onSystemReady(event: IpcMainEvent) {
		const window = [options.getEditor(), options.getRecorder?.()].find(
			(candidate) =>
				candidate &&
				!candidate.isDestroyed() &&
				candidate.webContents.id === event.sender.id,
		);
		if (!closed && window) {
			watchEditor(window);
			systemReady.add(event.sender.id);
		}
	}

	function onResponse(event: IpcMainEvent, response: AutomationResponse) {
		if (!response || typeof response.id !== "string") return;
		const request = pending.get(response.id);
		if (!request || request.sender !== event.sender.id) return;
		pending.delete(response.id);
		clearTimeout(request.timer);
		if (response.error) {
			// These errors are emitted before applying the new renderer document. Do not
			// roll back timeouts or media failures, where application may have started.
			if (
				["PROJECT_CHANGED", "UNSAVED_CHANGES", "INVALID_PROJECT", "BUSY"].includes(
					response.error.code,
				)
			) {
				request.rollbackProjectOpen?.();
			}
			request.reject(
				new AutomationError(
					response.error.code,
					response.error.message,
					response.error.details,
				),
			);
		} else request.resolve(response.result);
	}

	async function openProject(event: IpcMainInvokeEvent, requestId: unknown, filePath: unknown) {
		const request = typeof requestId === "string" ? pending.get(requestId) : undefined;
		if (
			closed ||
			!request ||
			request.sender !== event.sender.id ||
			request.command.method !== "project.open" ||
			typeof filePath !== "string" ||
			filePath !== request.command.params.path
		) {
			return {
				success: false,
				code: "ACCESS_DENIED",
				message: "No matching pending automation project open.",
			};
		}
		if (request.projectOpenStarted)
			return { success: false, code: "BUSY", message: "Project open has already started." };
		request.projectOpenStarted = true;
		// Capture immediately before the existing loader changes main metadata and
		// media approvals; the user may have edited or switched context during probing.
		const previous = {
			projectPath: currentProjectPath,
			videoPath: currentVideoPath,
			session: currentRecordingSession,
			approvedPaths: [...approvedLocalReadPaths],
		};
		let owned: {
			projectPath: string | null;
			videoPath: string | null;
			session: typeof currentRecordingSession;
		} | null = null;
		const rollback = () => {
			const expected = owned ?? previous;
			// A later user open (including the same target with a new session object)
			// owns its own context and must never be reverted by this older request.
			if (
				currentProjectPath !== expected.projectPath ||
				currentVideoPath !== expected.videoPath ||
				currentRecordingSession !== expected.session
			)
				return;
			setCurrentProjectPath(previous.projectPath);
			setCurrentVideoPath(previous.videoPath);
			setCurrentRecordingSession(previous.session);
			approvedLocalReadPaths.clear();
			for (const approvedPath of previous.approvedPaths)
				approvedLocalReadPaths.add(approvedPath);
		};
		request.rollbackProjectOpen = rollback;
		try {
			const result = await loadProjectFromPath(filePath);
			if (currentProjectPath === filePath) {
				owned = {
					projectPath: currentProjectPath,
					videoPath: currentVideoPath,
					session: currentRecordingSession,
				};
			}
			if (!result.success) {
				rollback();
				request.rollbackProjectOpen = undefined;
			}
			return result;
		} catch (error) {
			rollback();
			request.rollbackProjectOpen = undefined;
			return {
				success: false,
				code: "PROJECT_OPEN_FAILED",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}
	ipcMain.on("automation:ready", onReady);
	ipcMain.on("automation:system-ready", onSystemReady);
	ipcMain.on("automation:recorder-ready", onRecorderReady);
	ipcMain.on("automation:response", onResponse);
	ipcMain.handle("automation:open-project", openProject);

	ipcMain.handle(
		"automation:save-project",
		async (event, requestId: unknown, project: unknown, thumbnail?: string | null) => {
			const request = typeof requestId === "string" ? pending.get(requestId) : undefined;
			if (
				closed ||
				!request ||
				request.sender !== event.sender.id ||
				request.command.method !== "project.save" ||
				!request.saveTarget
			)
				return {
					success: false,
					code: "ACCESS_DENIED",
					message: "No matching pending automation project save.",
				};
			if (request.saveStarted)
				return {
					success: false,
					code: "BUSY",
					message: "Project save has already started.",
				};
			request.saveStarted = true;
			try {
				const context = request.saveContext;
				const stillCurrent = () => context && ownsProjectContext(context);
				if (!stillCurrent())
					throw new AutomationError(
						"PROJECT_CHANGED",
						"Project context changed before saving.",
					);
				const result = await persistAutomationProject(request.saveTarget, project);
				if (!stillCurrent())
					return {
						success: false,
						code: "PROJECT_CHANGED",
						message: `Saved a copy to ${result.path}, but the current document changed. Inspect before retrying.`,
					};
				setCurrentProjectPath(result.path);
				// Document persistence succeeds independently of optional library metadata.
				await Promise.allSettled([
					saveProjectThumbnail(result.path, thumbnail),
					rememberRecentProject(result.path),
				]);
				return { success: true, ...result };
			} catch (error) {
				return {
					success: false,
					code: error instanceof AutomationError ? error.code : "SAVE_FAILED",
					message: error instanceof Error ? error.message : String(error),
					details: error instanceof AutomationError ? error.details : undefined,
				};
			}
		},
	);

	async function callRenderer(
		request: AutomationRequest,
		create: boolean,
		recorder = false,
		saveTarget?: PreparedAutomationProjectSave,
		saveContext?: ProjectContext,
		system = false,
	) {
		if (closed) throw new AutomationError("APP_CLOSING", "Application is closing.");
		let window = recorder ? options.getRecorder?.() : options.getEditor();
		if (!window && create)
			window = recorder ? options.createRecorder?.() : options.createEditor();
		if (!window || window.isDestroyed())
			throw new AutomationError(
				recorder ? "RECORDER_NOT_OPEN" : "EDITOR_NOT_OPEN",
				recorder ? "Recorder window is not available." : "Open a project or video first.",
			);
		const editor = window;
		watchEditor(editor);
		const deadline = Date.now() + 20_000;
		while (!(system ? systemReady : ready).has(editor.webContents.id)) {
			if (closed) throw new AutomationError("APP_CLOSING", "Application is closing.");
			if (editor.isDestroyed())
				throw new AutomationError("EDITOR_CLOSED", "Editor closed before becoming ready.");
			if (Date.now() > deadline)
				throw new AutomationError(
					"EDITOR_NOT_READY",
					"Editor did not register its automation controller.",
				);
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
		if (closed) throw new AutomationError("APP_CLOSING", "Application is closing.");
		if (saveContext && !ownsProjectContext(saveContext))
			throw new AutomationError(
				"PROJECT_CHANGED",
				"Project context changed while preparing the save.",
			);
		// Internal IDs prevent one adapter from settling another adapter's command.
		const id = randomUUID();
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(
				() => {
					pending.delete(id);
					reject(
						new AutomationError(
							"TIMEOUT",
							"Editor command timed out. Inspect the live state before retrying.",
						),
					);
				},
				recorder ? 115_000 : 35_000,
			);
			pending.set(id, {
				sender: editor.webContents.id,
				command: request,
				saveTarget,
				saveContext,
				resolve,
				reject,
				timer,
			});
			try {
				editor.webContents.send(
					system ? "automation:system-request" : "automation:request",
					{ ...request, id },
				);
			} catch (error) {
				pending.delete(id);
				clearTimeout(timer);
				reject(error);
			}
		});
	}

	async function adoptRecordingInEditor(
		request: AutomationRequest,
		result: unknown,
		previous: ProjectContext,
	): Promise<unknown> {
		const recording = result as {
			session?: { videoPath?: string };
			warnings?: string[];
		} | null;
		if (!recording?.session?.videoPath) return result; // Countdown stop/cancel has no captured media.
		const capturedContext = projectContext();
		const deadline = Date.now() + 30_000;
		try {
			// Preserve the recorder's session identity even when its configured directory
			// uses an alias. Validation/approval still resolve the actual local file.
			const videoPath = recording.session.videoPath;
			await preflightOpen("video.open", videoPath);
			await rememberApprovedLocalReadPath(videoPath);
			while (true) {
				let inspection: {
					project?: { videoPath?: string };
					dirty?: boolean;
					readiness?: {
						loading?: boolean;
						previewReady?: boolean;
						videoLoaded?: boolean;
						cursorTelemetryLoaded?: boolean;
					};
				};
				try {
					inspection = (await callRenderer(
						{ ...request, method: "project.inspect", params: {} },
						false,
					)) as typeof inspection;
				} catch (error) {
					// The editor window may still be opening after a recording that
					// started without one (fresh app, HUD only): keep waiting.
					if (
						!(error instanceof AutomationError) ||
						!["BUSY", "EDITOR_NOT_OPEN"].includes(error.code) ||
						Date.now() >= deadline
					)
						throw error;
					await new Promise((resolve) => setTimeout(resolve, 50));
					continue;
				}
				if (!ownsProjectContext(capturedContext))
					throw new AutomationError(
						"PROJECT_CHANGED",
						"Application context changed during recording handoff.",
					);
				if (inspection.project?.videoPath !== videoPath && !inspection.readiness?.loading) {
					// Existing editor windows are reused by switchToEditor. Adopt the new
					// recording via the same fresh-import controller, preserving its session.
					await callRenderer(
						{ ...request, method: "video.open", params: { path: videoPath } },
						false,
					);
					return { ...recording, editor: { opened: true, videoPath } };
				}
				if (
					inspection.project?.videoPath === videoPath &&
					!inspection.readiness?.loading &&
					inspection.readiness?.previewReady &&
					inspection.readiness?.videoLoaded &&
					inspection.readiness?.cursorTelemetryLoaded
				)
					return { ...recording, editor: { opened: true, videoPath } };
				if (Date.now() >= deadline)
					throw new AutomationError(
						"EDITOR_NOT_READY",
						"Recording was saved, but the editor has not become ready.",
					);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		} catch (error) {
			if (
				error instanceof AutomationError &&
				["UNSAVED_CHANGES", "BUSY"].includes(error.code) &&
				ownsProjectContext(capturedContext)
			) {
				// A refusal before fresh import must keep the old document saveable.
				setCurrentProjectPath(previous.projectPath);
				setCurrentVideoPath(previous.videoPath);
				setCurrentRecordingSession(previous.session);
			}
			return {
				...recording,
				editor: { opened: false, error: toAutomationError(error) },
				warnings: [
					...(recording.warnings ?? []),
					`Recording is saved at ${recording.session.videoPath}; editor handoff failed. Inspect the result before saving a project.`,
				],
			};
		}
	}

	async function assertIdle(ignoreSystem = false, ignoreJobs = false, operation = "") {
		if (
			busy ||
			recorderBusy ||
			(!ignoreSystem && systemBusy) ||
			(!ignoreJobs && jobs.hasActive()) ||
			recordingActive() ||
			countdownTimer ||
			countdownInProgress
		)
			throw new AutomationError(
				"BUSY",
				"Wait for active editor, recorder and background operations to finish.",
			);
		const unsafeClose = ["app.quit", "updates.install", "app.window.close"].includes(operation);
		if (unsafeClose && options.hasUnsavedChanges())
			throw new AutomationError(
				"UNSAVED_CHANGES",
				"Save the current project before closing or restarting the application.",
			);
		if (options.getEditor()) {
			const live = (await callRenderer(
				{ id: randomUUID(), method: "project.inspect", params: {} },
				false,
			)) as {
				dirty?: boolean;
				readiness?: {
					exporting?: boolean;
					generatingCaptions?: boolean;
					saving?: boolean;
					loading?: boolean;
				};
			};
			if (
				live.readiness?.exporting ||
				live.readiness?.generatingCaptions ||
				live.readiness?.saving ||
				live.readiness?.loading
			)
				throw new AutomationError("BUSY", "An editor operation is still running.");
			if (unsafeClose && live.dirty)
				throw new AutomationError(
					"UNSAVED_CHANGES",
					"Save the current project before closing or restarting.",
				);
		}
	}
	const jobs = createAutomationJobs({
		getEditor: options.getEditor,
		createEditor: options.createEditor,
		safeIdle: () => assertIdle(false, true),
		applyCaptions: async (snapshot: JobObject, cues: JobJson) => {
			if (snapshot.videoPath !== currentVideoPath || typeof snapshot.documentId !== "string")
				throw new AutomationError(
					"PROJECT_CHANGED",
					"Caption cues belong to a previous source or editor instance; inspect them before applying.",
				);
			if (recordingActive() || countdownTimer || countdownInProgress)
				throw new AutomationError(
					"BUSY",
					"Caption cues are ready; wait for recording to finish before applying them.",
				);
			return callRenderer(
				{
					id: randomUUID(),
					method: "editor.apply",
					params: {
						expectedRevision: snapshot.revision,
						expectedDocumentId: snapshot.documentId,
						operations: [
							{ op: "collection.replace", collection: "autoCaptions", values: cues },
							{
								op: "settings.patch",
								values: { autoCaptionSettings: { enabled: true } },
							},
						],
					},
				},
				false,
			);
		},
	});
	const system = createSystemAutomation({
		renderer: (method, params) =>
			callRenderer(
				{ id: randomUUID(), method: method as AutomationRequest["method"], params },
				true,
				!options.getEditor(),
				undefined,
				undefined,
				true,
			),
		safeIdle: (operation) => assertIdle(true, false, operation),
		openWindow: (kind) =>
			options.openWindow?.(kind) ??
			(kind === "editor" ? options.createEditor() : options.createRecorder?.()),
		quit: () => {
			setTimeout(() => (options.quit ? options.quit() : app.quit()), 100);
		},
		getMainWindow: () =>
			options.getMainWindow?.() ?? options.getEditor() ?? options.getRecorder?.() ?? null,
		broadcastSystem: options.broadcastSystem,
		sendUpdate: options.sendUpdate,
		renameProject: async (name) => {
			const previous = projectContext();
			const oldPath = previous.projectPath;
			const oldStat = oldPath ? await fs.lstat(oldPath, { bigint: true }) : null;
			if (oldStat?.isSymbolicLink() || (oldStat && !oldStat.isFile()))
				throw new AutomationError(
					"INVALID_PATH",
					"Current project must be a regular file.",
				);
			const parent = oldPath ? path.dirname(oldPath) : await getProjectsDir();
			const targetPath = path.join(
				parent,
				`${name.replace(/\.(?:scrdance|recordly)$/i, "")}${oldPath ? path.extname(oldPath) : ".scrdance"}`,
			);
			if (targetPath === oldPath) return { path: oldPath, renamed: false };
			const target = await prepareAutomationProjectSave(targetPath, oldPath, false);
			const result = (await callRenderer(
				{
					id: randomUUID(),
					method: "project.save",
					params: {
						path: targetPath,
						expectedEditorContext: {
							projectPath: previous.projectPath,
							videoPath: previous.videoPath,
						},
					},
				},
				false,
				false,
				target,
				previous,
			)) as Record<string, unknown>;
			let warning: string | undefined;
			if (oldPath && oldStat) {
				const now = await fs.lstat(oldPath, { bigint: true }).catch(() => null);
				if (
					now &&
					["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
						(key) =>
							now[key as keyof typeof now] === oldStat[key as keyof typeof oldStat],
					)
				) {
					await fs.unlink(oldPath);
					await fs.unlink(`${oldPath}.preview.png`).catch(() => {
						/* Thumbnail cleanup is optional. */
					});
				} else
					warning =
						"The original project changed while renaming; it was retained as a separate copy.";
			}
			return { ...result, renamed: true, ...(warning ? { warning } : {}) };
		},
	});

	ipcMain.handle("automation:jobs-ui", async (event, action: unknown, jobId: unknown) => {
		const parent = [options.getEditor(), options.getRecorder?.()].find(
			(window) =>
				window && !window.isDestroyed() && window.webContents.id === event.sender.id,
		);
		if (!parent || closed)
			throw new AutomationError(
				"ACCESS_DENIED",
				"Only the active application UI can control jobs.",
			);
		if (action === "list")
			return jobs.dispatch({ id: randomUUID(), method: "jobs.list", params: { limit: 100 } });
		if (typeof jobId !== "string" || !/^[a-f0-9-]{36}$/.test(jobId))
			throw new AutomationError("INVALID_PARAMS", "A valid job ID is required.");
		if (action === "cancel" || action === "retry")
			return jobs.dispatch({
				id: randomUUID(),
				method: action === "cancel" ? "jobs.cancel" : "jobs.retry",
				params: { jobId },
			});
		if (action !== "save") throw new AutomationError("INVALID_PARAMS", "Unknown job action.");
		const job = jobs.manager.getRecord(jobId);
		const format = String(job.checkpoint?.format ?? "mp4");
		const selected = await dialog.showSaveDialog(parent, {
			title: "Save completed export",
			defaultPath: `export.${format}`,
			properties: ["createDirectory", "showOverwriteConfirmation"],
			filters: [{ name: format.toUpperCase(), extensions: [format] }],
		});
		if (selected.canceled || !selected.filePath) return { canceled: true };
		return jobs.dispatch({
			id: randomUUID(),
			method: "export.save",
			params: { jobId, outputPath: selected.filePath, overwrite: true },
		});
	});

	function recordingActive() {
		return (
			nativeScreenRecordingActive || windowsNativeCaptureActive || ffmpegScreenRecordingActive
		);
	}
	async function dispatch(request: AutomationRequest): Promise<unknown> {
		if (closed) throw new AutomationError("APP_CLOSING", "Application is closing.");
		if (request.method === "app.status") {
			const editor = options.getEditor();
			return {
				protocolVersion: AUTOMATION_PROTOCOL_VERSION,
				app: "Screendance App",
				version: app.getVersion(),
				pid: process.pid,
				platform: process.platform,
				arch: process.arch,
				automationEnabled: Boolean(transport),
				busy: busy || recorderBusy || systemBusy || jobs.hasActive(),
				recording: recordingActive(),
				countdownActive: Boolean(countdownTimer || countdownInProgress),
				editorOpen: Boolean(editor),
				editorReady: Boolean(editor && ready.has(editor.webContents.id)),
				projectPath: currentProjectPath,
				videoPath: currentVideoPath,
				hasUnsavedChanges: options.hasUnsavedChanges(),
			};
		}
		if (request.method === "app.capabilities") {
			return {
				protocolVersion: AUTOMATION_PROTOCOL_VERSION,
				stage: "complete-1-6",
				commands: AUTOMATION_COMMANDS,
				limits: [
					"Requires a running Electron desktop session.",
					"Recording and GPU export require a live macOS desktop session and their normal permissions.",
					"Mutations require document revisions. Background jobs survive adapter disconnects; interrupted work requires an explicit retry.",
					"Preview time is source media time; preview is a static composition, not an exported video frame.",
					"Opening another file refuses unsaved edits; preview never overwrites an existing file.",
				],
			};
		}
		if (jobs.recognizes(request.method)) {
			try {
				return await jobs.dispatch(request);
			} finally {
				if (!["jobs.list", "jobs.get", "jobs.wait", "models.list"].includes(request.method))
					options.broadcastJobs?.();
			}
		}
		if (isSystemAutomationCommand(request.method)) {
			const readonly = SYSTEM_AUTOMATION_COMMANDS.find(
				(command) => command.name === request.method,
			)?.readOnly;
			if (!readonly && (systemBusy || busy || recorderBusy))
				throw new AutomationError("BUSY", "Another mutation is running.");
			if (!readonly) systemBusy = true;
			try {
				return await system.dispatch(request.method, request.params);
			} finally {
				if (!readonly) systemBusy = false;
			}
		}

		if (request.method === "permissions.status")
			return {
				screen: systemPreferences.getMediaAccessStatus("screen"),
				microphone: systemPreferences.getMediaAccessStatus("microphone"),
				camera: systemPreferences.getMediaAccessStatus("camera"),
				accessibility: systemPreferences.isTrustedAccessibilityClient(false),
			};
		if (request.method === "project.list") return await listProjectLibraryEntries();
		const recorderCommand =
			request.method.startsWith("recording.") ||
			request.method.startsWith("sources.") ||
			request.method === "devices.list" ||
			request.method === "permissions.request";
		if (recorderCommand) {
			const querying = ["recording.status", "sources.list", "devices.list"].includes(
				request.method,
			);
			const cancel =
				request.method === "recording.cancel" || request.method === "recording.stop";
			const interrupt = cancel && recorderBusy && !busy;
			if (!querying && !interrupt && (busy || recorderBusy || systemBusy || jobs.hasActive()))
				throw new AutomationError("BUSY", "Another automation operation is running.");
			const replacesEditor =
				request.method === "recording.start" || request.method === "recording.recover";
			if (replacesEditor && options.hasUnsavedChanges())
				throw new AutomationError(
					"UNSAVED_CHANGES",
					"Save the current editor project before starting a new recording.",
				);
			const ownsLock = !querying && !interrupt;
			if (ownsLock) recorderBusy = true;
			try {
				if (replacesEditor && options.getEditor()) {
					const inspection = (await callRenderer(
						{ ...request, method: "project.inspect", params: {} },
						false,
					)) as {
						dirty?: boolean;
						readiness?: { exporting?: boolean; generatingCaptions?: boolean };
					};
					if (inspection.dirty)
						throw new AutomationError(
							"UNSAVED_CHANGES",
							"Save the current editor project before recording.",
						);
					if (inspection.readiness?.exporting || inspection.readiness?.generatingCaptions)
						throw new AutomationError(
							"BUSY",
							"An editor export or caption task is running.",
						);
				}
				const previous = projectContext();
				const result = await callRenderer(request, true, true);
				if (request.method === "recording.stop" || request.method === "recording.recover")
					return await adoptRecordingInEditor(request, result, previous);
				return result;
			} finally {
				if (ownsLock) recorderBusy = false;
			}
		}

		const editorRead =
			request.method === "project.inspect" ||
			request.method === "editor.get" ||
			request.method === "editor.catalogs" ||
			(request.method === "preview.control" && request.params.action === "status");
		if (!editorRead && (systemBusy || jobs.hasActive()))
			throw new AutomationError("BUSY", "A background job or settings operation is running.");

		if (busy)
			throw new AutomationError("BUSY", "Another editor automation command is in progress.");
		if (recordingActive() || countdownTimer || countdownInProgress || recorderBusy)
			throw new AutomationError(
				"RECORDING_ACTIVE",
				"Wait for recording and countdown to finish.",
			);
		busy = true;
		try {
			if (request.method === "project.open" || request.method === "video.open") {
				if (options.hasUnsavedChanges())
					throw new AutomationError(
						"UNSAVED_CHANGES",
						"Save your current edits before opening another file.",
					);
				const canonical = await preflightOpen(request.method, request.params.path);
				await rememberApprovedLocalReadPath(canonical);
				const params: Record<string, unknown> = { path: canonical };
				if (request.method === "project.open") {
					const projectData = await readAutomationProject(canonical);
					await rememberApprovedLocalReadPath(projectData.videoPath);
					params.projectData = projectData;
				}
				if (recordingActive() || countdownTimer || countdownInProgress || recorderBusy)
					throw new AutomationError(
						"RECORDING_ACTIVE",
						"Recording started while preparing this command.",
					);
				return await callRenderer({ ...request, params }, true);
			}
			if (EDITOR_AUTOMATION_COMMANDS.some((command) => command.name === request.method)) {
				if (request.method === "editor.presets" && request.params.action === "apply") {
					const existing = (await callRenderer(
						{ ...request, params: { action: "get", id: request.params.id } },
						false,
					)) as { preset?: { snapshot?: { wallpaper?: unknown } } };
					for (const file of collectEditorAutomationMediaPaths({
						wallpaper: existing.preset?.snapshot?.wallpaper,
					}))
						await rememberApprovedLocalReadPath(
							await (await import("./files")).requireLocalFile(file),
						);
				}
				for (const filePath of collectEditorAutomationMediaPaths(request.params)) {
					const approved = await (await import("./files")).requireLocalFile(filePath);
					await rememberApprovedLocalReadPath(approved);
				}
				return await callRenderer(request, false);
			}

			if (request.method === "project.save") {
				const context = projectContext();
				const target = await prepareAutomationProjectSave(
					request.params.path,
					context.projectPath,
					request.params.overwrite,
				);
				if (!ownsProjectContext(context))
					throw new AutomationError(
						"PROJECT_CHANGED",
						"Project context changed while preparing the save.",
					);
				return await callRenderer(
					{
						...request,
						params: {
							...request.params,
							expectedEditorContext: {
								projectPath: context.projectPath,
								videoPath: context.videoPath,
							},
						},
					},
					false,
					false,
					target,
					context,
				);
			}

			if (request.method === "preview.render") {
				const outputPath = await preparePreviewPath(request.params.outputPath);
				const result = await callRenderer(
					{ ...request, params: { ...request.params, outputPath } },
					false,
				);
				return await persistPreview(outputPath, result);
			}
			return await callRenderer(request, false);
		} finally {
			busy = false;
		}
	}

	return {
		async start() {
			if (closed) throw new AutomationError("APP_CLOSING", "Application is closing.");
			if (transport) return;
			if (starting) return starting;
			starting = (async () => {
				if (process.platform !== "darwin")
					throw new AutomationError(
						"UNSUPPORTED_PLATFORM",
						"The automation prototype currently supports macOS only.",
					);
				const endpointPath =
					process.env.SCREENDANCE_AUTOMATION_ENDPOINT ||
					path.join(USER_DATA_PATH, "automation", "endpoint.json");
				const created = await startAutomationSocket({ endpointPath, dispatch });
				if (closed) {
					await created.close();
					return;
				}
				transport = created;
				console.log(`[automation] Local API enabled; endpoint: ${endpointPath}`);
			})();
			try {
				await starting;
			} finally {
				starting = null;
			}
		},
		async close() {
			closed = true;
			ipcMain.removeListener("automation:ready", onReady);
			ipcMain.removeListener("automation:system-ready", onSystemReady);
			ipcMain.removeListener("automation:recorder-ready", onRecorderReady);
			ipcMain.removeListener("automation:response", onResponse);
			ipcMain.removeHandler("automation:open-project");
			ipcMain.removeHandler("automation:save-project");
			ipcMain.removeHandler("automation:jobs-ui");
			for (const request of pending.values()) {
				clearTimeout(request.timer);
				request.reject(new AutomationError("APP_CLOSING", "Application is closing."));
			}
			pending.clear();
			ready.clear();
			systemReady.clear();
			await jobs.close();
			for (const { contents, loading, gone, destroyed } of watched.values()) {
				contents.removeListener("did-start-loading", loading);
				contents.removeListener("render-process-gone", gone);
				contents.removeListener("destroyed", destroyed);
			}
			watched.clear();
			await starting?.catch(() => {
				/* Startup errors have already been reported by its caller. */
			});
			await transport?.close();
			transport = null;
		},
	};
}
