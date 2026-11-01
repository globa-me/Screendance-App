import { useEffect, useRef } from "react";

import { AutomationError as EditorAutomationError } from "../../../../shared/automation";

interface EditorAutomationController {
	editorCommand: (method: string, params: Record<string, unknown>) => Promise<unknown>;
	initializing: boolean;
	inspect: () => unknown;
	assertAvailable: (opening: boolean) => void;
	openProject: (
		path: string,
		beforeApply: () => void,
		candidate: unknown,
		requestId: string,
	) => Promise<void>;
	openVideo: (path: string, beforeApply: () => void) => Promise<void>;
	mediaState: () => { ready: boolean; error: string | null };
	renderPreview: (params: Record<string, unknown>) => Promise<unknown>;
	saveProject: (requestId: string, expectedContext: unknown) => Promise<unknown>;
}

/** Poll the current committed React state, rather than the request's original closure. */
export async function waitForAutomationMedia(
	read: () => { ready: boolean; error: string | null },
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = read();
		if (state.error) throw new EditorAutomationError("MEDIA_LOAD_FAILED", state.error);
		if (state.ready) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new EditorAutomationError(
		"MEDIA_NOT_READY",
		"Video and composition did not become ready in time.",
	);
}

export function useEditorAutomation(controller: EditorAutomationController): void {
	const latest = useRef(controller);
	latest.current = controller;
	const handling = useRef(false);

	useEffect(() => {
		return window.electronAPI.onAutomationRequest((request) => {
			if (
				![
					"project.inspect",
					"project.open",
					"video.open",
					"project.save",
					"preview.render",
					"editor.get",
					"editor.apply",
					"editor.undo",
					"editor.redo",
					"editor.catalogs",
					"editor.presets",
					"editor.autoZoom",
					"preview.control",
				].includes(request.method)
			)
				return;
			void (async () => {
				if (handling.current) {
					window.electronAPI.sendAutomationResponse({
						id: request.id,
						error: { code: "BUSY", message: "Another automation command is running." },
					});
					return;
				}
				handling.current = true;
				try {
					if (latest.current.initializing)
						throw new EditorAutomationError("BUSY", "Editor is initializing.");
					let result: unknown;
					if (
						request.method.startsWith("editor.") ||
						request.method === "preview.control"
					) {
						if (!["editor.get", "editor.catalogs"].includes(request.method))
							latest.current.assertAvailable(false);
						result = await latest.current.editorCommand(request.method, request.params);
					} else if (request.method === "project.inspect") {
						result = latest.current.inspect();
					} else if (
						request.method === "project.open" ||
						request.method === "video.open"
					) {
						latest.current.assertAvailable(true);
						const path = request.params.path;
						if (typeof path !== "string" || !path)
							throw new EditorAutomationError(
								"INVALID_PARAMS",
								"path must be a nonempty string.",
							);
						if (request.method === "project.open")
							await latest.current.openProject(
								path,
								() => latest.current.assertAvailable(true),
								request.params.projectData,
								request.id,
							);
						else
							await latest.current.openVideo(path, () =>
								latest.current.assertAvailable(true),
							);
						// Yield so state setters from loading are committed before readiness is read.
						await new Promise((resolve) => setTimeout(resolve, 0));
						await waitForAutomationMedia(() => latest.current.mediaState());
						result = latest.current.inspect();
					} else if (request.method === "project.save") {
						latest.current.assertAvailable(false);
						await waitForAutomationMedia(() => latest.current.mediaState());
						result = await latest.current.saveProject(
							request.id,
							request.params.expectedEditorContext,
						);
					} else if (request.method === "preview.render") {
						latest.current.assertAvailable(false);
						await waitForAutomationMedia(() => latest.current.mediaState());
						result = await latest.current.renderPreview(request.params);
					} else {
						throw new EditorAutomationError(
							"METHOD_NOT_FOUND",
							"Unsupported editor automation method.",
						);
					}
					window.electronAPI.sendAutomationResponse({ id: request.id, result });
				} catch (error) {
					window.electronAPI.sendAutomationResponse({
						id: request.id,
						error: {
							code:
								error instanceof EditorAutomationError
									? error.code
									: "EDITOR_ERROR",
							message: error instanceof Error ? error.message : String(error),
							details:
								error instanceof EditorAutomationError ? error.details : undefined,
						},
					});
				} finally {
					handling.current = false;
				}
			})();
		});
	}, []);

	useEffect(() => {
		if (!controller.initializing) window.electronAPI.automationReady();
	}, [controller.initializing]);
}
