import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { get as httpsGet } from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { app } from "electron";
import { AutomationError } from "../../shared/automation";
import type { JobJson, JobObject } from "../../shared/jobAutomation";
import {
	ensureReadableFile,
	resolveCaptionAudioCandidates,
	resolveWhisperExecutablePath,
} from "../ipc/captions/generate";
import {
	parseSrtCues,
	parseWhisperJsonCues,
	shouldRetryWhisperWithoutJson,
} from "../ipc/captions/parser";
import { getWhisperSmallModelStatus } from "../ipc/captions/whisper";
import {
	WHISPER_MODEL_DIR,
	WHISPER_MODEL_DOWNLOAD_URL,
	WHISPER_SMALL_MODEL_PATH,
} from "../ipc/constants";
import { getFfmpegBinaryPath } from "../ipc/ffmpeg/binary";
import type { AutomationJobContext } from "./jobs";

/** Child process lifetime remains attached to a desktop job, never an MCP connection. */
export async function runJobProcess(
	executable: string,
	args: string[],
	options: { signal: AbortSignal; timeoutMs?: number; onStderr?: (text: string) => void },
): Promise<{ stdout: string; stderr: string }> {
	options.signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let failure: Error | null = null;
		let escalation: ReturnType<typeof setTimeout> | null = null;
		const terminate = (error: Error) => {
			failure ??= error;
			child.kill("SIGTERM");
			if (!escalation) escalation = setTimeout(() => child.kill("SIGKILL"), 1500);
		};
		const aborted = () =>
			terminate(
				new AutomationError("CANCELLED", "Job subprocess cancellation was requested."),
			);
		options.signal.addEventListener("abort", aborted, { once: true });
		const timeout = setTimeout(
			() =>
				terminate(
					new AutomationError(
						"TIMEOUT",
						"Job subprocess exceeded its execution deadline.",
					),
				),
			options.timeoutMs ?? 30 * 60 * 1000,
		);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (failure) return;
			stdout += chunk;
			if (Buffer.byteLength(stdout) > 20 * 1024 * 1024)
				terminate(
					new AutomationError(
						"PROCESS_OUTPUT_LIMIT",
						"Job subprocess output exceeded its limit.",
					),
				);
		});
		child.stderr.on("data", (chunk: string) => {
			if (failure) return;
			stderr += chunk;
			if (Buffer.byteLength(stderr) > 20 * 1024 * 1024)
				terminate(
					new AutomationError(
						"PROCESS_OUTPUT_LIMIT",
						"Job subprocess diagnostics exceeded its limit.",
					),
				);
			else {
				try {
					options.onStderr?.(chunk);
				} catch {
					/* Progress cannot strand a child process. */
				}
			}
		});
		child.once("error", (error) => {
			failure ??= error;
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			if (escalation) clearTimeout(escalation);
			options.signal.removeEventListener("abort", aborted);
			if (failure) reject(failure);
			else if (code !== 0)
				reject(
					Object.assign(
						new Error(
							`Job subprocess exited with ${signal ?? code}. ${stderr.slice(-12000)}`,
						),
						{ stderr, stdout, code },
					),
				);
			else resolve({ stdout, stderr });
		});
		if (options.signal.aborted) aborted();
	});
}

export async function listAutomationModels(): Promise<JobObject> {
	const status = await getWhisperSmallModelStatus();
	let runtime: JobObject;
	try {
		runtime = { available: true, path: await resolveWhisperExecutablePath() };
	} catch (error) {
		runtime = {
			available: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return {
		models: [{ modelId: "small", managed: true, downloaded: status.exists, path: status.path }],
		runtime,
	};
}
export async function deleteAutomationModel(modelId = "small"): Promise<JobObject> {
	if (modelId !== "small")
		throw new AutomationError("INVALID_PARAMS", "Only the managed small model can be deleted.");
	await fs.rm(WHISPER_SMALL_MODEL_PATH, { force: true });
	return { modelId, deleted: true };
}

export async function downloadAutomationModel(context: AutomationJobContext): Promise<JobObject> {
	if (context.input.modelId !== undefined && context.input.modelId !== "small")
		throw new AutomationError("INVALID_PARAMS", "Unknown managed model.");
	context.signal.throwIfAborted();
	const existing = await getWhisperSmallModelStatus();
	if (existing.exists && existing.path)
		return { modelId: "small", path: existing.path, downloaded: true, alreadyPresent: true };
	await fs.mkdir(WHISPER_MODEL_DIR, { recursive: true, mode: 0o700 });
	const temporary = path.join(WHISPER_MODEL_DIR, `.small-${context.jobId}.download`);
	try {
		context.progress({ phase: "downloading", percentage: 0 });
		await downloadJobModel(
			WHISPER_MODEL_DOWNLOAD_URL,
			temporary,
			context.signal,
			(received, total) =>
				context.progress({
					phase: "downloading",
					...(total ? { percentage: Math.min(99, (received / total) * 100) } : {}),
					downloadedBytes: received,
					...(total ? { totalBytes: total } : {}),
				}),
		);
		context.signal.throwIfAborted();
		const metadata = await fs.stat(temporary);
		if (metadata.size < 1024 * 1024)
			throw new AutomationError(
				"INVALID_MODEL",
				"Downloaded Whisper model is unexpectedly small.",
			);
		const file = await fs.open(temporary, "r");
		try {
			await file.sync();
		} finally {
			await file.close();
		}
		context.beginCommit();
		try {
			await fs.link(temporary, WHISPER_SMALL_MODEL_PATH);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		context.progress({ phase: "downloaded", percentage: 100 });
		return { modelId: "small", path: WHISPER_SMALL_MODEL_PATH, downloaded: true };
	} finally {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
	}
}

export async function downloadJobModel(
	url: string,
	destination: string,
	signal: AbortSignal,
	progress: (received: number, total: number) => void,
	redirects = 0,
): Promise<void> {
	signal.throwIfAborted();
	if (new URL(url).protocol !== "https:" || redirects > 5)
		throw new AutomationError("DOWNLOAD_FAILED", "Invalid model download redirect.");
	return new Promise<void>((resolve, reject) => {
		const request = httpsGet(url, { timeout: 30000 }, (response) => {
			const location = response.headers.location;
			if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400 && location) {
				response.resume();
				cleanup();
				void downloadJobModel(
					new URL(location, url).toString(),
					destination,
					signal,
					progress,
					redirects + 1,
				).then(resolve, reject);
				return;
			}
			if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
				response.resume();
				cleanup();
				reject(
					new AutomationError(
						"DOWNLOAD_FAILED",
						`Whisper model server returned HTTP ${response.statusCode}.`,
					),
				);
				return;
			}
			const total = Number(response.headers["content-length"] ?? 0);
			let received = 0;
			const file = createWriteStream(destination, { flags: "wx", mode: 0o600 });
			response.on("data", (chunk: Buffer) => {
				received += chunk.length;
				if (received > 2 * 1024 * 1024 * 1024) {
					request.destroy(new Error("Model download exceeds size limit."));
					return;
				}
				try {
					progress(received, Number.isFinite(total) ? total : 0);
				} catch (error) {
					request.destroy(error instanceof Error ? error : new Error(String(error)));
				}
			});
			void pipeline(response, file, { signal }).then(
				() => {
					cleanup();
					resolve();
				},
				(error) => {
					cleanup();
					reject(error);
				},
			);
		});
		const aborted = () =>
			request.destroy(new AutomationError("CANCELLED", "Model download was cancelled."));
		const cleanup = () => signal.removeEventListener("abort", aborted);
		signal.addEventListener("abort", aborted, { once: true });
		request.once("error", (error) => {
			cleanup();
			reject(error);
		});
		request.once("timeout", () =>
			request.destroy(new AutomationError("TIMEOUT", "Model download stalled.")),
		);
		if (signal.aborted) aborted();
	});
}

/** Capture the actual available recording companions once; retries never discover new media. */
export async function captureAutomationCaptionAudio(snapshot: JobJson): Promise<JobJson> {
	if (
		!snapshot ||
		typeof snapshot !== "object" ||
		Array.isArray(snapshot) ||
		typeof snapshot.videoPath !== "string" ||
		!path.isAbsolute(snapshot.videoPath)
	)
		throw new AutomationError(
			"INVALID_SNAPSHOT",
			"Caption jobs need an absolute frozen source.",
		);
	const candidates = await resolveCaptionAudioCandidates(snapshot.videoPath);
	const frozen: Array<{ path: string; label: string }> = [];
	for (const candidate of candidates) {
		if (!path.isAbsolute(candidate.path))
			throw new AutomationError("INVALID_SNAPSHOT", "Caption audio paths must be absolute.");
		const metadata = await fs.stat(candidate.path).catch(() => null);
		if (metadata?.isFile()) frozen.push({ path: candidate.path, label: candidate.label });
	}
	return { ...snapshot, _audioCandidates: frozen };
}

/** Reuses existing runtime discovery, recording audio candidates and Whisper parsers. */
export async function generateAutomationCaptions(
	context: AutomationJobContext,
): Promise<JobObject> {
	const snapshot = context.snapshot as JobObject | undefined;
	const videoPath = context.input.videoPath ?? snapshot?.videoPath;
	const modelPath = context.input.modelPath ?? snapshot?.whisperModelPath;
	const executable = context.input.executablePath ?? snapshot?.whisperExecutablePath;
	const language = context.input.language ?? snapshot?.language ?? "auto";
	if (
		typeof videoPath !== "string" ||
		!path.isAbsolute(videoPath) ||
		typeof modelPath !== "string" ||
		!path.isAbsolute(modelPath) ||
		(executable !== undefined && executable !== null && typeof executable !== "string") ||
		typeof language !== "string"
	)
		throw new AutomationError(
			"INVALID_PARAMS",
			"Caption jobs need a frozen absolute source and Whisper model path.",
		);
	context.signal.throwIfAborted();
	const runtime = await resolveWhisperExecutablePath(
		typeof executable === "string" ? executable : undefined,
	);
	await ensureReadableFile(modelPath);
	await ensureReadableFile(videoPath);
	const base = path.join(app.getPath("temp"), `screendance-job-${context.jobId}`);
	const wav = `${base}.wav`;
	const output = `${base}-whisper`;
	const srt = `${output}.srt`;
	const json = `${output}.json`;
	const frozenCandidates = snapshot?._audioCandidates;
	if (
		frozenCandidates !== undefined &&
		(!Array.isArray(frozenCandidates) ||
			frozenCandidates.length > 4096 ||
			frozenCandidates.some(
				(candidate) =>
					!candidate ||
					typeof candidate !== "object" ||
					Array.isArray(candidate) ||
					typeof candidate.path !== "string" ||
					!path.isAbsolute(candidate.path) ||
					typeof candidate.label !== "string",
			))
	)
		throw new AutomationError("INVALID_SNAPSHOT", "Invalid frozen caption audio candidates.");
	const candidates =
		frozenCandidates === undefined
			? await resolveCaptionAudioCandidates(videoPath)
			: (frozenCandidates as Array<{ path: string; label: string }>);
	try {
		context.progress({ phase: "extracting-audio", percentage: 0 });
		let sourceLabel: string | null = null;
		for (const candidate of candidates) {
			context.signal.throwIfAborted();
			try {
				await ensureReadableFile(candidate.path);
				await runJobProcess(
					getFfmpegBinaryPath(),
					[
						"-y",
						"-i",
						candidate.path,
						"-map",
						"0:a:0",
						"-vn",
						"-ac",
						"1",
						"-ar",
						"16000",
						"-c:a",
						"pcm_s16le",
						wav,
					],
					{ signal: context.signal, timeoutMs: 5 * 60 * 1000 },
				);
				sourceLabel = candidate.label;
				break;
			} catch (error) {
				if (context.signal.aborted) throw error;
			}
		}
		if (!sourceLabel)
			throw new AutomationError(
				"NO_AUDIO",
				"No audio track could be extracted from the recording or its linked webcam.",
			);
		context.progress({ phase: "transcribing", percentage: 0 });
		const args = [
			"-m",
			modelPath,
			"-f",
			wav,
			"-osrt",
			"-of",
			output,
			"-l",
			language.trim() || "auto",
			"-np",
		];
		let jsonEnabled = true;
		const processOptions = {
			signal: context.signal,
			onStderr: (text: string) => {
				const match = /(?:progress\s*=\s*|progress:\s*)(\d+(?:\.\d+)?)%/i.exec(text);
				if (match)
					context.progress({
						phase: "transcribing",
						percentage: Math.max(0, Math.min(99, Number(match[1]))),
					});
			},
		};
		try {
			await runJobProcess(runtime, [...args, "-ojf"], processOptions);
		} catch (error) {
			if (context.signal.aborted || !shouldRetryWhisperWithoutJson(error)) throw error;
			jsonEnabled = false;
			await runJobProcess(runtime, args, processOptions);
		}
		context.signal.throwIfAborted();
		context.progress({ phase: "reading-captions", percentage: 99 });
		const timed = jsonEnabled ? parseWhisperJsonCues(await fs.readFile(json, "utf8")) : [];
		const cues = timed.length ? timed : parseSrtCues(await fs.readFile(srt, "utf8"));
		if (!cues.length)
			throw new AutomationError("EMPTY_CAPTIONS", "Whisper completed without caption cues.");
		return {
			cues: cues as unknown as JobJson,
			audioSourceLabel: sourceLabel,
			videoPath,
			language,
		};
	} finally {
		await Promise.allSettled([
			fs.rm(wav, { force: true }),
			fs.rm(srt, { force: true }),
			fs.rm(json, { force: true }),
		]);
	}
}
