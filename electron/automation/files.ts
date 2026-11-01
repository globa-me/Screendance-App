import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutomationError } from "../../shared/automation";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);

export async function requireLocalFile(filePath: unknown): Promise<string> {
	if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
		throw new AutomationError("INVALID_PARAMS", "An absolute local file path is required.");
	}
	try {
		const canonical = await fs.realpath(filePath);
		if (!(await fs.stat(canonical)).isFile())
			throw new AutomationError("INVALID_PATH", "Path is not a regular file.");
		return canonical;
	} catch (error) {
		if (error instanceof AutomationError) throw error;
		throw new AutomationError("FILE_UNAVAILABLE", `Cannot read file: ${filePath}`);
	}
}

export async function preflightOpen(
	method: "project.open" | "video.open",
	filePath: unknown,
): Promise<string> {
	const canonical = await requireLocalFile(filePath);
	if (method === "video.open") {
		if (!VIDEO_EXTENSIONS.has(path.extname(canonical).toLowerCase()))
			throw new AutomationError("UNSUPPORTED_FORMAT", "Unsupported video extension.");
		return canonical;
	}
	if (![".scrdance", ".recordly"].includes(path.extname(canonical).toLowerCase())) {
		throw new AutomationError(
			"UNSUPPORTED_FORMAT",
			"Expected a .scrdance or .recordly project.",
		);
	}
	await readAutomationProject(canonical);
	return canonical;
}

/** Read a bounded, validated snapshot again immediately before dispatching it. */
export async function readAutomationProject(
	canonical: string,
): Promise<Record<string, unknown> & { videoPath: string }> {
	if ((await fs.stat(canonical)).size > 16 * 1024 * 1024)
		throw new AutomationError("INVALID_PROJECT", "Project file exceeds 16 MiB.");
	let project: Record<string, unknown>;
	try {
		project = JSON.parse((await fs.readFile(canonical, "utf8")).replace(/^\uFEFF/, ""));
	} catch {
		throw new AutomationError("INVALID_PROJECT", "Project is not valid JSON.");
	}
	if (
		!project ||
		typeof project !== "object" ||
		Array.isArray(project) ||
		project.version !== 1 ||
		typeof project.videoPath !== "string" ||
		!project.editor ||
		typeof project.editor !== "object" ||
		Array.isArray(project.editor)
	) {
		throw new AutomationError(
			"INVALID_PROJECT",
			"Expected a version 1 Screendance project with videoPath and editor.",
		);
	}
	const sourcePath = projectLocalPath(project.videoPath);
	await requireLocalFile(sourcePath);
	const webcam = project.editor as { webcam?: { sourcePath?: unknown } };
	const webcamSource = webcam.webcam?.sourcePath;
	if (typeof webcamSource === "string" && webcamSource)
		await requireLocalFile(projectLocalPath(webcamSource));
	return project as Record<string, unknown> & { videoPath: string };
}

function projectLocalPath(value: string): string {
	try {
		return value.startsWith("file://") ? fileURLToPath(value) : value;
	} catch {
		throw new AutomationError(
			"INVALID_PROJECT",
			"Project contains an invalid local media URL.",
		);
	}
}

export async function preparePreviewPath(outputPath: unknown): Promise<string> {
	if (
		typeof outputPath !== "string" ||
		!path.isAbsolute(outputPath) ||
		path.extname(outputPath).toLowerCase() !== ".png"
	) {
		throw new AutomationError("INVALID_PARAMS", "outputPath must be an absolute .png path.");
	}
	let parent: string;
	try {
		parent = await fs.realpath(path.dirname(outputPath));
	} catch {
		throw new AutomationError("INVALID_PATH", "Preview output directory does not exist.");
	}
	const target = path.join(parent, path.basename(outputPath));
	try {
		await fs.lstat(target);
		throw new AutomationError(
			"OUTPUT_EXISTS",
			"Preview output already exists; choose a new path.",
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return target;
}

export async function persistPreview(
	outputPath: string,
	value: unknown,
): Promise<Record<string, unknown>> {
	const result = value as Record<string, unknown> | null;
	if (
		!result ||
		typeof result.pngDataUrl !== "string" ||
		!result.pngDataUrl.startsWith("data:image/png;base64,")
	) {
		throw new AutomationError(
			"INVALID_PREVIEW",
			"Renderer did not return a composed PNG preview.",
		);
	}
	if (result.pngDataUrl.length > 24 * 1024 * 1024)
		throw new AutomationError("INVALID_PREVIEW", "Preview exceeds size limit.");
	const data = Buffer.from(result.pngDataUrl.slice("data:image/png;base64,".length), "base64");
	if (
		data.length < 24 ||
		!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	) {
		throw new AutomationError("INVALID_PREVIEW", "Invalid PNG preview data.");
	}
	try {
		await fs.writeFile(outputPath, data, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new AutomationError(
				"OUTPUT_EXISTS",
				"Preview output already exists; choose a new path.",
			);
		throw error;
	}
	const { pngDataUrl: _png, ...metadata } = result;
	return {
		...metadata,
		outputPath,
		bytes: data.length,
		width: data.readUInt32BE(16),
		height: data.readUInt32BE(20),
	};
}
