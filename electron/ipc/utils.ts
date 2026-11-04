import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { RECORDINGS_DIR } from "../appPaths";
import { AUTO_RECORDING_PREFIX, RECORDINGS_SETTINGS_FILE } from "./constants";
import {
	approvedLocalReadPaths,
	approvedWriteDestinations,
	customRecordingsDir,
	recordingsDirLoaded,
	setCustomRecordingsDir,
	setRecordingsDirLoaded,
} from "./state";

const nodeRequire = createRequire(import.meta.url);

export function getScreen() {
	if (!app.isReady()) {
		throw new Error(
			"getScreen() called before app is ready. Ensure all screen access happens after app.whenReady().",
		);
	}
	return nodeRequire("electron").screen as typeof import("electron").screen;
}

export function normalizePath(filePath: string) {
	return path.resolve(filePath);
}

export function normalizeVideoSourcePath(videoPath?: string | null): string | null {
	if (typeof videoPath !== "string") {
		return null;
	}

	const trimmed = videoPath.trim();
	if (!trimmed) {
		return null;
	}

	if (/^file:\/\//i.test(trimmed)) {
		try {
			return fileURLToPath(trimmed);
		} catch {
			// Fall through and keep best-effort string path below.
		}
	}

	return trimmed;
}

export function stripJsonByteOrderMark(content: string) {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

export function parseJsonWithByteOrderMark<T = unknown>(content: string): T {
	return JSON.parse(stripJsonByteOrderMark(content)) as T;
}

export function parseWindowId(sourceId?: string) {
	if (!sourceId) return null;
	const match = sourceId.match(/^window:(\d+)/);
	return match ? Number.parseInt(match[1], 10) : null;
}

export function getTelemetryPathForVideo(videoPath: string) {
	return `${videoPath}.cursor.json`;
}

export function isAutoRecordingPath(filePath: string) {
	return path.basename(filePath).startsWith(AUTO_RECORDING_PREFIX);
}

export async function moveFileWithOverwrite(sourcePath: string, destinationPath: string) {
	await fs.mkdir(path.dirname(destinationPath), { recursive: true });
	await fs.rm(destinationPath, { force: true });

	try {
		await fs.rename(sourcePath, destinationPath);
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code !== "EXDEV") {
			throw error;
		}

		await fs.copyFile(sourcePath, destinationPath);
		await fs.unlink(sourcePath);
	}
}

async function loadRecordingsDirectorySetting() {
	if (recordingsDirLoaded) {
		return;
	}

	setRecordingsDirLoaded(true);

	try {
		const content = await fs.readFile(RECORDINGS_SETTINGS_FILE, "utf-8");
		const parsed = parseJsonWithByteOrderMark<{ recordingsDir?: unknown }>(content);
		if (typeof parsed.recordingsDir === "string" && parsed.recordingsDir.trim()) {
			setCustomRecordingsDir(path.resolve(parsed.recordingsDir));
		}
	} catch {
		setCustomRecordingsDir(null);
	}
}

export async function getRecordingsDir() {
	await loadRecordingsDirectorySetting();
	const targetDir = customRecordingsDir ?? RECORDINGS_DIR;
	await fs.mkdir(targetDir, { recursive: true });
	return targetDir;
}

export function getMacPrivacySettingsUrl(pane: "screen" | "accessibility" | "microphone"): string {
	if (pane === "screen")
		return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
	if (pane === "microphone")
		return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
	return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
}

function normalizeComparablePath(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideDirectory(candidatePath: string, directoryPath: string): boolean {
	const candidate = normalizeComparablePath(candidatePath);
	const directory = normalizeComparablePath(directoryPath);
	return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

/**
 * Remembers a destination the user picked in a main-process save dialog, so a
 * later renderer request may write exactly there without a second dialog.
 */
export function approveWriteDestination(filePath: string | null | undefined): void {
	if (!filePath) return;
	approvedWriteDestinations.add(normalizeComparablePath(filePath));
}

/** Smoke-export destinations come from the launching environment, not the renderer. */
function getEnvironmentWriteDestinations(): string[] {
	const smokeOutput =
		process.env.RECORDLY_SMOKE_EXPORT === "1"
			? process.env.RECORDLY_SMOKE_EXPORT_OUTPUT?.trim()
			: undefined;
	if (!smokeOutput) return [];
	return [smokeOutput, `${smokeOutput}.report.json`];
}

/**
 * Renderer-supplied output paths are writable only when main approved them:
 * chosen through a save dialog, or configured by the smoke-export environment.
 * Alpha exports may get their extension corrected to `.mov`, so the same base
 * name with a different extension is accepted for an approved destination.
 */
export function isApprovedWriteDestination(filePath: string | null | undefined): boolean {
	if (!filePath) return false;
	const candidate = normalizeComparablePath(filePath);
	const approved = [
		...approvedWriteDestinations,
		...getEnvironmentWriteDestinations().map(normalizeComparablePath),
	];
	const stripExtension = (value: string) => value.replace(/\.[^./\\]+$/, "");
	const candidateIsAlphaContainer = /\.(mov|webm)$/i.test(candidate);
	return approved.some(
		(entry) =>
			entry === candidate ||
			(candidateIsAlphaContainer && stripExtension(entry) === stripExtension(candidate)),
	);
}

/** True when the path lies inside the default or the user-chosen recordings folder. */
export async function isInsideRecordingsDir(filePath: string | null | undefined): Promise<boolean> {
	if (!filePath) return false;
	const recordingsDir = await getRecordingsDir();
	return isInsideDirectory(filePath, recordingsDir) || isInsideDirectory(filePath, RECORDINGS_DIR);
}

export function approveUserPath(filePath: string | null | undefined): void {
	if (!filePath) return;
	try {
		approvedLocalReadPaths.add(path.resolve(filePath));
	} catch {
		// Ignore invalid paths; later reads will surface the underlying error.
	}
}

