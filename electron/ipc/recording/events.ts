import { BrowserWindow } from "electron";
import { getHudOverlayWindow } from "../../windows";

export function emitRecordingInterrupted(reason: string, message: string) {
	BrowserWindow.getAllWindows().forEach((window) => {
		if (!window.isDestroyed()) {
			window.webContents.send("recording-interrupted", { reason, message });
		}
	});
}

/**
 * The recorded window closed and the helper paused the take. Bring the HUD
 * back so the user can pick another source or stop.
 */
export function emitRecordingSourceUnavailable() {
	const hud = getHudOverlayWindow();
	if (hud && !hud.isDestroyed()) {
		if (hud.isMinimized()) hud.restore();
		hud.showInactive();
	}
	BrowserWindow.getAllWindows().forEach((window) => {
		if (!window.isDestroyed()) {
			window.webContents.send("recording-source-unavailable");
		}
	});
}
