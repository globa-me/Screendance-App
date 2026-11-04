import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, type Session } from "electron";
import { isAllowedLocalReadPath, isPathInsideDirectory } from "./ipc/project/manager";
import { customRecordingsDir } from "./ipc/state";
import { isRendererMediaFile } from "./mediaTypes";

export { isRendererMediaFile };

/**
 * Renderer read policy shared by `read-local-file` and every `file://` request.
 *
 * The HUD and editor windows run with `webSecurity: false`, which lets page
 * script fetch any `file://` URL. Extensions execute in that same page, so
 * without this guard any extension could read SSH keys, documents or projects.
 *
 * A path is readable when it is app-managed or explicitly approved (see
 * `isAllowedLocalReadPath`), inside the app bundle or the chosen recordings
 * folder, or when both the requested and the real path are media/image/font
 * files (`isRendererMediaFile`). The media allowance keeps user wallpapers, imported videos and
 * project thumbnails working across restarts; it does not cover documents,
 * source code, keys, project files or other data.
 */
function getTrustedReadRoots(): string[] {
	const roots = [app.getAppPath(), process.resourcesPath, customRecordingsDir];
	return roots.filter((root): root is string => typeof root === "string" && root.length > 0);
}

export function isRendererReadablePath(filePath: string): boolean {
	if (typeof filePath !== "string" || filePath.length === 0) {
		return false;
	}

	const lexicalPath = path.resolve(filePath);
	let realPath = lexicalPath;
	try {
		realPath = realpathSync(lexicalPath);
	} catch {
		// Missing file: the lexical path decides; the read itself will fail later.
	}

	if (isAllowedLocalReadPath(lexicalPath)) {
		return true;
	}

	const roots = getTrustedReadRoots();
	if (
		roots.some((root) => isPathInsideDirectory(lexicalPath, root)) &&
		roots.some((root) => isPathInsideDirectory(realPath, root))
	) {
		return true;
	}

	return isRendererMediaFile(lexicalPath) && isRendererMediaFile(realPath);
}

function fileUrlToLocalPath(url: string): string | null {
	try {
		const parsed = new URL(url);
		parsed.search = "";
		parsed.hash = "";
		return fileURLToPath(parsed);
	} catch {
		return null;
	}
}

const reportedBlockedPaths = new Set<string>();

/** Cancels renderer `file://` requests that fall outside `isRendererReadablePath`. */
export function installFileAccessGuard(targetSession: Session): void {
	targetSession.webRequest.onBeforeRequest({ urls: ["file://*/*"] }, (details, callback) => {
		const localPath = fileUrlToLocalPath(details.url);
		const allowed = localPath !== null && isRendererReadablePath(localPath);
		if (!allowed) {
			const key = localPath ?? details.url;
			if (!reportedBlockedPaths.has(key)) {
				reportedBlockedPaths.add(key);
				console.warn(`[file-access] Blocked renderer file request: ${key}`);
			}
		}
		callback({ cancel: !allowed });
	});
}
