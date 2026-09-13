import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { SaveDialogOptions } from "electron";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import {
	closeExportStream,
	isOwnedExportPath,
	openExportStream,
	registerOwnedExportPath,
	releaseOwnedExportPath,
	writeToExportStream,
} from "../export/exportStream";
import {
	enqueueNativeVideoExportFrameWrite,
	enqueueNativeVideoExportFrameWrites,
	exportNativeStaticLayoutVideo,
	flushNativeVideoExportPendingWriteRequests,
	getNativeVideoExportMaxQueuedWriteBytes,
	getNativeVideoExportSessionError,
	isHardwareAcceleratedVideoEncoder,
	isIgnorableNativeVideoExportStreamError,
	muxExportedVideoAudioBuffer,
	muxNativeVideoExportAudio,
	type NativeStaticLayoutExportOptions,
	type NativeVideoExportSession,
	nativeStaticLayoutExportSessions,
	nativeVideoExportSessions,
	probeNativeVideoMetadata,
	removeTemporaryExportFile,
	resolveNativeVideoEncoder,
	sendNativeVideoExportWriteFrameResult,
	settleNativeVideoExportWriteFrameRequest,
} from "../export/native-video";
import {
	getFfmpegBinaryPath,
	getFfprobeBinaryPath,
	resolveSystemFfmpegBinaryPath,
} from "../ffmpeg/binary";
import {
	buildNativeH264StreamExportArgs,
	buildNativeProresAlphaExportArgs,
	buildNativeVideoExportArgs,
	getNativeVideoInputByteSize,
	type NativeExportEncodingMode,
	type NativeVideoExportFinishOptions,
} from "../nativeVideoExport";
import { isAllowedLocalReadPath, resolveApprovedLocalMediaPath } from "../project/manager";
import { approveUserPath } from "../utils";

function getPartialExportDestinationPath(destinationPath: string) {
	const parsed = path.parse(destinationPath);
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	return path.join(parsed.dir, `.recordly-partial-${parsed.name}-${suffix}${parsed.ext}`);
}

const MAX_IN_MEMORY_EXPORT_BYTES = 0x7fffffff;

function ensureFileExtension(filePath: string, extension: string): string {
	const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
	const parsed = path.parse(filePath);
	if (parsed.ext.toLowerCase() === normalizedExtension.toLowerCase()) {
		return filePath;
	}
	return path.join(parsed.dir, `${parsed.name}${normalizedExtension}`);
}

function getInMemoryExportTooLargeMessage(byteLength: number) {
	if (byteLength <= MAX_IN_MEMORY_EXPORT_BYTES) {
		return null;
	}

	return "Export is too large for the legacy in-memory save path. Please retry with temp-file streaming enabled.";
}

export async function moveExportedTempFile(tempPath: string, destinationPath: string) {
	await fs.mkdir(path.dirname(destinationPath), { recursive: true });
	try {
		await fs.rename(tempPath, destinationPath);
		return;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTEMPTY" && code !== "EEXIST") {
			throw error;
		}
		// Cross-device or Windows permission quirks — fall back to copy + unlink so
		// exporting to a different volume still works.
	}

	const partialDestinationPath = getPartialExportDestinationPath(destinationPath);
	try {
		await fs.copyFile(tempPath, partialDestinationPath);
		try {
			await fs.rename(partialDestinationPath, destinationPath);
		} catch (renameError) {
			const code = (renameError as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "EPERM") {
				throw renameError;
			}

			const backupDestinationPath = getPartialExportDestinationPath(destinationPath);
			let movedExistingDestination = false;
			try {
				await fs.rename(destinationPath, backupDestinationPath);
				movedExistingDestination = true;
			} catch (backupError) {
				if ((backupError as NodeJS.ErrnoException).code !== "ENOENT") {
					throw backupError;
				}
			}

			try {
				await fs.rename(partialDestinationPath, destinationPath);
			} catch (replaceError) {
				if (movedExistingDestination) {
					await fs.rename(backupDestinationPath, destinationPath).catch(() => undefined);
				}
				throw replaceError;
			}

			if (movedExistingDestination) {
				await fs.rm(backupDestinationPath, { force: true }).catch((cleanupError) => {
					console.warn(
						`[export] Failed to remove backup file after replace (${backupDestinationPath}):`,
						cleanupError,
					);
				});
			}
		}
		try {
			await fs.rm(tempPath, { force: true });
		} catch (unlinkError) {
			// Copy succeeded, so the export itself is safe; surface the leaked temp
			// path instead of silently swallowing the failure so operators can
			// reclaim disk space manually if the OS temp reaper misses it.
			console.warn(
				`[export] Failed to remove temp file after cross-volume copy (${tempPath}):`,
				unlinkError,
			);
		}
	} catch (error) {
		await fs.rm(partialDestinationPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

type ProcessOutput = {
	stdout: string;
	stderr: string;
};

type ProResAlphaProbeStream = {
	codec_type?: string;
	codec_name?: string;
	profile?: string;
	codec_tag_string?: string;
	pix_fmt?: string;
	tags?: Record<string, string>;
};

type ProResAlphaProbeOutput = {
	streams?: ProResAlphaProbeStream[];
};

export type AlphaSignalStats = {
	frameCount: number;
	min: number | null;
	max: number | null;
	avg: number | null;
};

export function buildWebmToProResArgs(tempPath: string, destinationPath: string): string[] {
	return [
		"-y",
		"-c:v",
		"libvpx-vp9",
		"-i",
		tempPath,
		"-map",
		"0:v:0",
		"-map",
		"0:a?",
		"-c:v",
		"prores_ks",
		"-profile:v",
		"4",
		"-pix_fmt",
		"yuva444p10le",
		"-metadata:s:v:0",
		"alpha_mode=1",
		"-alpha_bits",
		"16",
		"-c:a",
		"pcm_s16le",
		destinationPath,
	];
}

function runProcess(
	binaryPath: string,
	args: string[],
	logPrefix: string,
	options: { stdout?: "ignore" | "pipe" } = {},
): Promise<ProcessOutput> {
	return new Promise((resolve, reject) => {
		const proc = spawn(binaryPath, args, {
			stdio: ["ignore", options.stdout ?? "ignore", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			console.log(`${logPrefix} process closed with code ${code}`);
			if (stderr.trim()) {
				console.log(`${logPrefix} STDERR:\n${stderr.trim()}`);
			}
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				const errorMsg = `${logPrefix} failed with code ${code}. Stderr: ${stderr}`;
				console.error(logPrefix, errorMsg);
				reject(new Error(errorMsg));
			}
		});

		proc.on("error", (err) => {
			console.error(`${logPrefix} process error:`, err);
			reject(err);
		});
	});
}

function hasAlphaPixelFormat(pixelFormat: string | undefined): boolean {
	return /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(pixelFormat ?? "");
}

export function getProResAlphaValidationError(probe: ProResAlphaProbeOutput): string | null {
	const videoStream =
		probe.streams?.find((stream) => stream.codec_type === "video") ?? probe.streams?.[0];
	if (!videoStream) {
		return "FFprobe did not find a video stream in the ProRes export";
	}

	if (videoStream.codec_name !== "prores") {
		return `Expected ProRes video, got ${videoStream.codec_name || "unknown codec"}`;
	}

	const isProRes4444 =
		videoStream.codec_tag_string === "ap4h" ||
		videoStream.profile?.toLowerCase().includes("4444") === true;
	if (!isProRes4444) {
		return `Expected ProRes 4444/ap4h, got ${videoStream.profile || "unknown profile"} ${
			videoStream.codec_tag_string || ""
		}`.trim();
	}

	if (!hasAlphaPixelFormat(videoStream.pix_fmt)) {
		return `Expected an alpha-capable pixel format, got ${
			videoStream.pix_fmt || "unknown pix_fmt"
		}`;
	}

	return null;
}

export function parseAlphaSignalStats(output: string): AlphaSignalStats {
	const mins = [...output.matchAll(/lavfi\.signalstats\.YMIN=([0-9.]+)/g)].map((match) =>
		Number(match[1]),
	);
	const maxes = [...output.matchAll(/lavfi\.signalstats\.YMAX=([0-9.]+)/g)].map((match) =>
		Number(match[1]),
	);
	const avgs = [...output.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map((match) =>
		Number(match[1]),
	);

	return {
		frameCount: Math.max(mins.length, maxes.length, avgs.length),
		min: mins.length > 0 ? Math.min(...mins) : null,
		max: maxes.length > 0 ? Math.max(...maxes) : null,
		avg: avgs.length > 0 ? avgs.reduce((sum, value) => sum + value, 0) / avgs.length : null,
	};
}

async function verifyProResAlphaChannel(destinationPath: string): Promise<void> {
	const ffprobePath = getFfprobeBinaryPath();
	const ffprobeArgs = [
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=codec_type,codec_name,profile,codec_tag_string,pix_fmt:stream_tags=vendor_id,handler_name",
		"-of",
		"json",
		destinationPath,
	];

	console.log("[transcode] Validating ProRes alpha metadata...");
	console.log("[transcode] FFprobe Path:", ffprobePath);
	console.log("[transcode] FFprobe Args:", ffprobeArgs.join(" "));
	const ffprobeOutput = await runProcess(ffprobePath, ffprobeArgs, "[transcode:ffprobe]", {
		stdout: "pipe",
	});
	const probe = JSON.parse(ffprobeOutput.stdout) as ProResAlphaProbeOutput;
	const validationError = getProResAlphaValidationError(probe);
	if (validationError) {
		throw new Error(`ProRes alpha validation failed: ${validationError}`);
	}

	const stream = probe.streams?.[0];
	console.log(
		`[transcode] ProRes alpha metadata ok: codec=${stream?.codec_name} profile=${stream?.profile} tag=${stream?.codec_tag_string} pix_fmt=${stream?.pix_fmt} vendor=${stream?.tags?.vendor_id ?? "unknown"}`,
	);

	const ffmpegPath = getFfmpegBinaryPath();
	const alphaArgs = [
		"-hide_banner",
		"-v",
		"error",
		"-i",
		destinationPath,
		"-vf",
		"alphaextract,signalstats,metadata=print:file=-",
		"-frames:v",
		"10",
		"-f",
		"null",
		"-",
	];
	console.log("[transcode] Validating decoded alpha plane...");
	console.log("[transcode] Alpha Validation Args:", alphaArgs.join(" "));
	const alphaOutput = await runProcess(ffmpegPath, alphaArgs, "[transcode:alpha]", {
		stdout: "pipe",
	});
	const stats = parseAlphaSignalStats(`${alphaOutput.stdout}\n${alphaOutput.stderr}`);
	console.log(
		`[transcode] Alpha plane sample: frames=${stats.frameCount} min=${stats.min ?? "n/a"} max=${stats.max ?? "n/a"} avg=${stats.avg === null ? "n/a" : stats.avg.toFixed(2)}`,
	);
}

function getProResTranscodeFfmpegPath(): string {
	if (process.platform === "darwin") {
		const systemFfmpeg = resolveSystemFfmpegBinaryPath();
		if (systemFfmpeg) {
			return systemFfmpeg;
		}
	}

	return getFfmpegBinaryPath();
}

export async function transcodeWebmToProRes(
	tempPath: string,
	destinationPath: string,
): Promise<void> {
	const ffmpegPath = getProResTranscodeFfmpegPath();
	const partialDestinationPath = getPartialExportDestinationPath(destinationPath);
	const ffmpegArgs = buildWebmToProResArgs(tempPath, partialDestinationPath);

	console.log("[transcode] Starting WebM to ProRes transcoding...");
	console.log("[transcode] FFmpeg Path:", ffmpegPath);
	console.log("[transcode] FFmpeg Args:", ffmpegArgs.join(" "));

	try {
		await fs.mkdir(path.dirname(destinationPath), { recursive: true });
		await runProcess(ffmpegPath, ffmpegArgs, "[transcode]");
		await verifyProResAlphaChannel(partialDestinationPath);
		await moveExportedTempFile(partialDestinationPath, destinationPath);
		console.log("[transcode] Transcoding completed successfully with verified alpha.");
	} catch (error) {
		await fs.rm(partialDestinationPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function resolveAllowedReadableFilePath(
	filePath: string,
	label: string,
	options: { mediaOnly?: boolean } = {},
) {
	if (typeof filePath !== "string" || filePath.trim().length === 0) {
		throw new Error(`${label} requires a file path`);
	}

	if (options.mediaOnly ?? true) {
		const resolvedMediaPath = await resolveApprovedLocalMediaPath(filePath);
		if (!resolvedMediaPath) {
			throw new Error(`${label} is not an approved readable media file`);
		}

		return resolvedMediaPath;
	}

	const resolvedPath = path.resolve(filePath);
	if (!isAllowedLocalReadPath(resolvedPath)) {
		throw new Error(`${label} is not approved for local reads`);
	}

	const realPath = await fs.realpath(resolvedPath).catch(() => null);
	if (!realPath) {
		throw new Error(`${label} does not exist`);
	}

	const stat = await fs.stat(realPath).catch(() => null);
	if (!stat?.isFile()) {
		throw new Error(`${label} is not a readable file`);
	}

	if (!isAllowedLocalReadPath(realPath)) {
		throw new Error(`${label} is not approved for local reads`);
	}

	return realPath;
}

async function sanitizeNativeStaticLayoutExportOptions(
	options: NativeStaticLayoutExportOptions,
): Promise<NativeStaticLayoutExportOptions> {
	const sanitized: NativeStaticLayoutExportOptions = {
		...options,
		inputPath: await resolveAllowedReadableFilePath(options.inputPath, "Native input"),
	};
	const mutableOptions = sanitized as unknown as Record<string, unknown>;

	for (const [field, label] of [
		["backgroundImagePath", "Native background image"],
		["webcamInputPath", "Native webcam input"],
		["cursorAtlasPath", "Native cursor atlas"],
	] as const) {
		const value = mutableOptions[field];
		if (typeof value === "string" && value.trim().length > 0) {
			mutableOptions[field] = await resolveAllowedReadableFilePath(value, label);
		} else if (value === "" || value === undefined) {
			mutableOptions[field] = null;
		} else if (value !== null) {
			throw new Error(`${label} must be a file path`);
		}
	}

	for (const [field, label] of [
		["cursorTelemetryPath", "Native cursor telemetry"],
		["cursorAtlasMetadataPath", "Native cursor atlas metadata"],
		["zoomTelemetryPath", "Native zoom telemetry"],
		["timelineMapPath", "Native timeline map"],
	] as const) {
		const value = mutableOptions[field];
		if (typeof value === "string" && value.trim().length > 0) {
			mutableOptions[field] = await resolveAllowedReadableFilePath(value, label, {
				mediaOnly: false,
			});
		} else if (value === "" || value === undefined) {
			mutableOptions[field] = null;
		} else if (value !== null) {
			throw new Error(`${label} must be a file path`);
		}
	}

	const audioOptions = sanitized.audioOptions;
	if (audioOptions?.audioSourcePath) {
		sanitized.audioOptions = {
			...audioOptions,
			audioSourcePath: await resolveAllowedReadableFilePath(
				audioOptions.audioSourcePath,
				"Native audio source",
			),
		};
	}

	return sanitized;
}

function isTempPathSafe(tempPath: string): boolean {
	const tempRoot = path.resolve(app.getPath("temp"));
	const candidate = path.resolve(tempPath);
	if (candidate === tempRoot) {
		return false;
	}
	const withSep = tempRoot.endsWith(path.sep) ? tempRoot : tempRoot + path.sep;
	return candidate.startsWith(withSep);
}

export function registerExportHandlers() {
	ipcMain.handle(
		"native-video-export-start",
		async (
			event,
			options: {
				width: number;
				height: number;
				frameRate: number;
				bitrate: number;
				encodingMode: NativeExportEncodingMode;
				inputMode?: "rawvideo" | "h264-stream";
				outputProfile?: "mp4-h264" | "mov-prores-4444";
			},
		) => {
			try {
				if (options.width % 2 !== 0 || options.height % 2 !== 0) {
					throw new Error("Native export requires even output dimensions");
				}

				const inputMode = options.inputMode ?? "rawvideo";
				const outputProfile = options.outputProfile ?? "mp4-h264";
				const ffmpegPath =
					outputProfile === "mov-prores-4444" ? getProResTranscodeFfmpegPath() : getFfmpegBinaryPath();
				const sessionId = `recordly-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				const outputPath = path.join(
					app.getPath("temp"),
					`${sessionId}${outputProfile === "mov-prores-4444" ? ".mov" : ".mp4"}`,
				);

				let encoderName: string;
				let ffmpegArgs: string[];

				if (outputProfile === "mov-prores-4444") {
					if (inputMode !== "rawvideo") {
						throw new Error("ProRes alpha export requires rawvideo input");
					}
					encoderName = "prores_ks-4444-alpha";
					ffmpegArgs = buildNativeProresAlphaExportArgs(options, outputPath);
				} else if (inputMode === "h264-stream") {
					// Pre-encoded H.264 Annex B from browser VideoEncoder — just stream-copy into MP4
					encoderName = "h264-stream-copy";
					ffmpegArgs = buildNativeH264StreamExportArgs({
						frameRate: options.frameRate,
						outputPath,
					});
				} else {
					encoderName = await resolveNativeVideoEncoder(ffmpegPath, options.encodingMode);
					ffmpegArgs = buildNativeVideoExportArgs(encoderName, options, outputPath);
				}

				console.log(
					`[native-export] Spawning FFmpeg process: ${ffmpegPath} ${ffmpegArgs.join(" ")}`,
				);
				const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
					stdio: ["pipe", "ignore", "pipe"],
				}) as ChildProcessByStdio<Writable, null, Readable>;
				// For rawvideo, frames are a fixed RGBA size. For h264-stream, chunks are variable.
				const inputByteSize =
					inputMode === "rawvideo"
						? getNativeVideoInputByteSize(options.width, options.height)
						: 0;

				const session: NativeVideoExportSession = {
					ffmpegProcess,
					outputPath,
					inputByteSize,
					inputMode,
					maxQueuedWriteBytes:
						inputMode === "h264-stream"
							? 32 * 1024 * 1024
							: getNativeVideoExportMaxQueuedWriteBytes(inputByteSize),
					stderrOutput: "",
					encoderName,
					processError: null,
					stdinError: null,
					terminating: false,
					writeSequence: Promise.resolve(),
					sender: event.sender,
					pendingWriteRequestIds: new Set<number>(),
					completionPromise: new Promise<void>((resolve, reject) => {
						ffmpegProcess.once("error", (error) => {
							const processError =
								error instanceof Error ? error : new Error(String(error));
							if (session.terminating) {
								resolve();
								return;
							}

							session.processError = processError;
							reject(processError);
						});
						ffmpegProcess.stdin.once("error", (error) => {
							const stdinError =
								error instanceof Error ? error : new Error(String(error));
							if (
								session.terminating &&
								isIgnorableNativeVideoExportStreamError(stdinError)
							) {
								return;
							}

							session.stdinError = stdinError;
						});
						ffmpegProcess.once("close", (code, signal) => {
							if (session.terminating) {
								resolve();
								return;
							}

							if (code === 0) {
								resolve();
								return;
							}

							reject(
								new Error(
									getNativeVideoExportSessionError(
										session,
										`FFmpeg exited with code ${code ?? "unknown"}${signal ? ` (signal ${signal})` : ""}`,
									),
								),
							);
						});
					}),
				};
				void session.completionPromise.catch(() => undefined);

				ffmpegProcess.stderr.on("data", (chunk: Buffer) => {
					session.stderrOutput += chunk.toString();
				});

				nativeVideoExportSessions.set(sessionId, session);

				console.log(
					`[native-export] Started ${isHardwareAcceleratedVideoEncoder(encoderName) ? "hardware" : "software"} session ${sessionId} with ${encoderName}`,
				);

				return {
					success: true,
					sessionId,
					encoderName,
				};
			} catch (error) {
				console.error(
					"[native-export] Failed to start native video export session:",
					error,
				);
				return {
					success: false,
					error: String(error),
				};
			}
		},
	);

	ipcMain.handle("probe-native-video-metadata", async (_, filePath: string) => {
		try {
			if (typeof filePath !== "string" || filePath.trim().length === 0) {
				throw new Error("Native metadata probe requires a file path");
			}

			const resolvedFilePath = await resolveAllowedReadableFilePath(
				filePath,
				"Native metadata probe",
			);
			const metadata = await probeNativeVideoMetadata(
				getFfmpegBinaryPath(),
				resolvedFilePath,
			);
			return {
				success: true,
				metadata,
			};
		} catch (error) {
			console.warn("[probe-native-video-metadata] Failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});

	ipcMain.handle(
		"native-static-layout-export",
		async (event, options: NativeStaticLayoutExportOptions) => {
			try {
				if (!options || typeof options.inputPath !== "string") {
					throw new Error("Native static layout export requires an input path");
				}
				const sanitizedOptions = await sanitizeNativeStaticLayoutExportOptions(options);

				const result = await exportNativeStaticLayoutVideo(
					getFfmpegBinaryPath(),
					sanitizedOptions,
					(progress) => {
						if (event.sender.isDestroyed()) {
							return;
						}

						event.sender.send("native-static-layout-export-progress", progress);
					},
				);
				registerOwnedExportPath(result.outputPath);
				const primaryBackend = result.metrics.chunks[0]?.backend;
				return {
					success: true,
					tempPath: result.outputPath,
					encoderName:
						primaryBackend === "nvidia-cuda-compositor"
							? "nvidia-cuda-compositor"
							: primaryBackend === "windows-d3d11-compositor"
								? "windows-d3d11-compositor"
								: result.metrics.chunkCount > 1
									? "chunked-h264-nvenc"
									: "static-layout-h264-nvenc",
					metrics: result.metrics,
				};
			} catch (error) {
				console.warn("[native-static-layout-export] Failed:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
	);

	ipcMain.handle("native-static-layout-export-cancel", async (_, sessionId: string) => {
		const session = nativeStaticLayoutExportSessions.get(sessionId);
		if (!session) {
			return { success: true };
		}

		session.terminating = true;
		try {
			session.currentProcess?.kill("SIGKILL");
		} catch {
			// Process may already be closed.
		}

		return { success: true };
	});

	ipcMain.on(
		"native-video-export-write-frames-async",
		(
			event,
			payload: {
				sessionId: string;
				requestId: number;
				frameDataList: Uint8Array[];
			},
		) => {
			const sessionId = payload?.sessionId;
			const requestId = payload?.requestId;
			const frameDataList = payload?.frameDataList;

			if (
				typeof sessionId !== "string" ||
				typeof requestId !== "number" ||
				!Array.isArray(frameDataList) ||
				frameDataList.length === 0
			) {
				return;
			}

			const session = nativeVideoExportSessions.get(sessionId);
			if (!session) {
				sendNativeVideoExportWriteFrameResult(event.sender, sessionId, requestId, {
					success: false,
					error: "Invalid native export session",
				});
				return;
			}

			session.sender = event.sender;
			session.pendingWriteRequestIds.add(requestId);

			if (session.terminating) {
				settleNativeVideoExportWriteFrameRequest(sessionId, session, requestId, {
					success: false,
					error: "Native video export session was cancelled",
				});
				return;
			}

			if (
				session.inputMode !== "h264-stream" &&
				frameDataList.some((frameData) => frameData.byteLength !== session.inputByteSize)
			) {
				settleNativeVideoExportWriteFrameRequest(sessionId, session, requestId, {
					success: false,
					error: "Native video export batch contained invalid frame sizes",
				});
				return;
			}

			void enqueueNativeVideoExportFrameWrites(session, frameDataList)
				.then(() => {
					settleNativeVideoExportWriteFrameRequest(sessionId, session, requestId, {
						success: true,
					});
				})
				.catch((error) => {
					session.stdinError = error instanceof Error ? error : new Error(String(error));
					settleNativeVideoExportWriteFrameRequest(sessionId, session, requestId, {
						success: false,
						error: getNativeVideoExportSessionError(
							session,
							session.stdinError.message,
						),
					});
				});
		},
	);

	ipcMain.on(
		"native-video-export-write-frame-async",
		(
			event,
			payload: {
				sessionId: string;
				requestId: number;
				frameData: Uint8Array;
			},
		) => {
			const sessionId = payload?.sessionId;
			const requestId = payload?.requestId;
			const frameData = payload?.frameData;

			if (typeof sessionId !== "string" || typeof requestId !== "number" || !frameData) {
				return;
			}

			const session = nativeVideoExportSessions.get(sessionId);
			if (!session) {
				sendNativeVideoExportWriteFrameResult(event.sender, sessionId, requestId, {
					success: false,
					error: "Invalid native export session",
				});
				return;
			}

			session.sender = event.sender;
			session.pendingWriteRequestIds.add(requestId);

			if (session.terminating) {
				settleNativeVideoExportWriteFrameRequest(sessionId, session, requestId, {
					success: false,
					error: "Native video export session was cancelled",
				});
				return;
			}

			if (
				session.inputMode !== "h264-stream" &&
				frameData.byteLength !== session.inputByteSize
			) {
				settleNativeVideoExportWriteFrameRequest(sessionId, session, requestId, {
					success: false,
					error: `Native video export expected ${session.inputByteSize} bytes per frame but received ${frameData.byteLength}`,
				});
				return;
			}

			void enqueueNativeVideoExportFrameWrite(session, frameData)
				.then(() => {
					settleNativeVideoExportWriteFrameRequest(sessionId, session, requestId, {
						success: true,
					});
				})
				.catch((error) => {
					session.stdinError = error instanceof Error ? error : new Error(String(error));
					settleNativeVideoExportWriteFrameRequest(sessionId, session, requestId, {
						success: false,
						error: getNativeVideoExportSessionError(
							session,
							session.stdinError.message,
						),
					});
				});
		},
	);

	ipcMain.handle(
		"native-video-export-finish",
		async (_, sessionId: string, options?: NativeVideoExportFinishOptions) => {
			const session = nativeVideoExportSessions.get(sessionId);
			if (!session) {
				return { success: false, error: "Invalid native export session" };
			}

			try {
				await session.writeSequence;
				if (
					!session.ffmpegProcess.stdin.destroyed &&
					!session.ffmpegProcess.stdin.writableEnded
				) {
					session.ffmpegProcess.stdin.end();
				}
				await session.completionPromise;

				const finalized = await muxNativeVideoExportAudio(
					session.outputPath,
					options ?? {},
				);
				nativeVideoExportSessions.delete(sessionId);
				// Register the finalized path so only app-produced paths can flow back
				// through finalize-exported-video / discard-exported-temp.
				registerOwnedExportPath(finalized.outputPath);
				if (finalized.outputPath !== session.outputPath) {
					// muxNativeVideoExportAudio removes the intermediate on success, but
					// clear our registry entry defensively in case a future refactor
					// changes that contract.
					releaseOwnedExportPath(session.outputPath);
				}

				// Return a temp path instead of reading the file back into memory so we
				// never hit V8's per-ArrayBuffer limit on >2 GiB exports. The renderer
				// uses finalize-exported-video to move the file to its final path.
				return {
					success: true,
					tempPath: finalized.outputPath,
					encoderName: session.encoderName,
					metrics: finalized.metrics,
				};
			} catch (error) {
				flushNativeVideoExportPendingWriteRequests(sessionId, session, String(error));
				nativeVideoExportSessions.delete(sessionId);
				await removeTemporaryExportFile(session.outputPath);
				const finalizedSuffix = session.outputPath.replace(/\.mp4$/, "-final.mp4");
				await removeTemporaryExportFile(finalizedSuffix);
				return {
					success: false,
					error: String(error),
				};
			}
		},
	);

	ipcMain.handle(
		"mux-exported-video-audio-from-path",
		async (_, videoPath: string, options?: NativeVideoExportFinishOptions) => {
			if (typeof videoPath !== "string" || !isOwnedExportPath(videoPath)) {
				return {
					success: false,
					error: "Video path is not an app-managed export temp",
				};
			}
			try {
				const finalized = await muxNativeVideoExportAudio(videoPath, options ?? {});
				if (finalized.outputPath !== videoPath) {
					registerOwnedExportPath(finalized.outputPath);
					// muxNativeVideoExportAudio removes the intermediate on success, so
					// the input is no longer owned by the registry after the call
					// returns.
					releaseOwnedExportPath(videoPath);
				}
				return {
					success: true,
					tempPath: finalized.outputPath,
					metrics: finalized.metrics,
				};
			} catch (error) {
				// Only clean up the input path if it is still an owned temp (i.e.
				// muxNativeVideoExportAudio failed before consuming it).
				if (isOwnedExportPath(videoPath)) {
					await removeTemporaryExportFile(videoPath);
					releaseOwnedExportPath(videoPath);
				}
				return { success: false, error: String(error) };
			}
		},
	);

	ipcMain.handle(
		"mux-exported-video-audio",
		async (_, videoData: ArrayBuffer, options?: NativeVideoExportFinishOptions) => {
			try {
				const sizeError = getInMemoryExportTooLargeMessage(videoData.byteLength);
				if (sizeError) {
					return {
						success: false,
						error: sizeError,
					};
				}

				const result = await muxExportedVideoAudioBuffer(videoData, options ?? {});
				// Register the muxed output so finalize-exported-video / discard-
				// exported-temp accept it. Returning a temp path (instead of the
				// muxed bytes) keeps us off Node's >2 GiB fs.readFile cap and
				// avoids a redundant copy through the renderer.
				registerOwnedExportPath(result.outputPath);
				return {
					success: true,
					tempPath: result.outputPath,
					metrics: result.metrics,
				};
			} catch (error) {
				return {
					success: false,
					error: String(error),
				};
			}
		},
	);

	ipcMain.handle("export-stream-open", async (_event, options?: { extension?: string }) => {
		try {
			const result = await openExportStream(options);
			return { success: true, streamId: result.streamId, tempPath: result.tempPath };
		} catch (error) {
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle(
		"export-stream-write",
		async (_event, streamId: string, position: number, chunk: Uint8Array) => {
			try {
				await writeToExportStream(streamId, position, chunk);
				return { success: true };
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);

	ipcMain.handle(
		"export-stream-close",
		async (_event, streamId: string, options?: { abort?: boolean }) => {
			try {
				const result = await closeExportStream(streamId, options);
				return {
					success: true,
					tempPath: result.tempPath,
					bytesWritten: result.bytesWritten,
				};
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);

	ipcMain.handle("native-video-export-cancel", async (_, sessionId: string) => {
		const session = nativeVideoExportSessions.get(sessionId);
		if (!session) {
			return { success: true };
		}

		session.terminating = true;
		nativeVideoExportSessions.delete(sessionId);
		flushNativeVideoExportPendingWriteRequests(
			sessionId,
			session,
			"Native video export session was cancelled",
		);

		try {
			if (
				!session.ffmpegProcess.stdin.destroyed &&
				!session.ffmpegProcess.stdin.writableEnded
			) {
				session.ffmpegProcess.stdin.destroy();
			}
		} catch {
			// Stream may already be closed.
		}

		try {
			session.ffmpegProcess.kill("SIGKILL");
		} catch {
			// Process may already be closed.
		}

		await session.completionPromise.catch(() => undefined);
		await removeTemporaryExportFile(session.outputPath);
		return { success: true };
	});

	ipcMain.handle(
		"save-exported-video",
		async (event, videoData: ArrayBuffer, fileName: string) => {
			try {
				const sizeError = getInMemoryExportTooLargeMessage(videoData.byteLength);
				if (sizeError) {
					return {
						success: false,
						message: sizeError,
						error: sizeError,
					};
				}

				const isWebmData =
					videoData.byteLength >= 4 &&
					new Uint8Array(videoData, 0, 4)[0] === 0x1a &&
					new Uint8Array(videoData, 0, 4)[1] === 0x45 &&
					new Uint8Array(videoData, 0, 4)[2] === 0xdf &&
					new Uint8Array(videoData, 0, 4)[3] === 0xa3;

				// Determine file type from extension
				const lowerFileName = fileName.toLowerCase();
				const isGif = lowerFileName.endsWith(".gif");
				const isAlphaQuickTime = isWebmData || lowerFileName.endsWith(".mov");
				const defaultFileName =
					isAlphaQuickTime && !lowerFileName.endsWith(".webm")
						? ensureFileExtension(fileName, ".mov")
						: fileName;
				const filters = isGif
					? [{ name: "GIF Image", extensions: ["gif"] }]
					: isAlphaQuickTime
						? [
								{
									name: "QuickTime Alpha Video (ProRes 4444)",
									extensions: ["mov"],
								},
								{ name: "WebM Video", extensions: ["webm"] },
							]
						: [{ name: "MP4 Video", extensions: ["mp4"] }];
				const parentWindow = BrowserWindow.fromWebContents(event.sender);
				const saveDialogOptions: SaveDialogOptions = {
					title: isGif
						? "Save Exported GIF"
						: isAlphaQuickTime
							? "Save Exported Alpha Video"
							: "Save Exported Video",
					defaultPath: path.join(app.getPath("downloads"), defaultFileName),
					filters,
					properties: ["createDirectory", "showOverwriteConfirmation"],
				};

				const result = parentWindow
					? await dialog.showSaveDialog(parentWindow, saveDialogOptions)
					: await dialog.showSaveDialog(saveDialogOptions);

				if (result.canceled || !result.filePath) {
					return {
						success: false,
						canceled: true,
						message: "Export canceled",
					};
				}

				const destinationPath =
					isAlphaQuickTime && !result.filePath.toLowerCase().endsWith(".webm")
						? ensureFileExtension(result.filePath, ".mov")
						: result.filePath;

				if (isWebmData && destinationPath.toLowerCase().endsWith(".mov")) {
					const tempPath = path.join(
						app.getPath("temp"),
						`recordly-export-temp-${Date.now()}.webm`,
					);
					await fs.writeFile(tempPath, Buffer.from(videoData));
					try {
						await transcodeWebmToProRes(tempPath, destinationPath);
					} finally {
						await fs.rm(tempPath, { force: true }).catch(() => undefined);
					}
				} else {
					await fs.writeFile(destinationPath, Buffer.from(videoData));
				}
				approveUserPath(destinationPath);

				return {
					success: true,
					path: destinationPath,
					message: "Video exported successfully",
				};
			} catch (error) {
				console.error("Failed to save exported video:", error);
				return {
					success: false,
					message: "Failed to save exported video",
					error: String(error),
				};
			}
		},
	);

	ipcMain.handle(
		"write-exported-video-to-path",
		async (_event, videoData: ArrayBuffer, outputPath: string) => {
			try {
				const sizeError = getInMemoryExportTooLargeMessage(videoData.byteLength);
				if (sizeError) {
					return {
						success: false,
						message: sizeError,
						canceled: false,
						error: sizeError,
					};
				}

				const resolvedPath = path.resolve(outputPath);
				await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
				await fs.writeFile(resolvedPath, Buffer.from(videoData));
				approveUserPath(resolvedPath);

				return {
					success: true,
					path: resolvedPath,
					message: "Video exported successfully",
					canceled: false,
				};
			} catch (error) {
				console.error("Failed to write exported video to path:", error);
				return {
					success: false,
					message: "Failed to write exported video",
					canceled: false,
					error: String(error),
				};
			}
		},
	);

	ipcMain.handle(
		"finalize-exported-video",
		async (
			event,
			payload: {
				tempPath: string;
				fileName: string;
				outputPath?: string | null;
			},
		) => {
			const tempPath = payload?.tempPath;
			const fileName = payload?.fileName;
			if (typeof tempPath !== "string" || typeof fileName !== "string") {
				return { success: false, error: "Invalid finalize-exported-video payload" };
			}

			if (!isTempPathSafe(tempPath) || !isOwnedExportPath(tempPath)) {
				return {
					success: false,
					error: "Temp path is not an app-managed export temp",
				};
			}

			try {
				await fs.access(tempPath);
			} catch {
				return {
					success: false,
					error: `Exported video temp file is missing: ${tempPath}`,
				};
			}

			try {
				const lowerTempPath = tempPath.toLowerCase();
				const lowerFileName = fileName.toLowerCase();
				const isWebm = lowerTempPath.endsWith(".webm");
				const isProResAlphaMov = lowerTempPath.endsWith(".mov");
				const isAlphaQuickTime =
					isWebm || isProResAlphaMov || lowerFileName.endsWith(".mov");

				if (payload.outputPath) {
					const requestedPath = path.resolve(payload.outputPath);
					const resolvedPath =
						isAlphaQuickTime && !requestedPath.toLowerCase().endsWith(".webm")
							? ensureFileExtension(requestedPath, ".mov")
							: requestedPath;
					if (isWebm && resolvedPath.toLowerCase().endsWith(".mov")) {
						await transcodeWebmToProRes(tempPath, resolvedPath);
						await fs.rm(tempPath, { force: true }).catch(() => undefined);
					} else {
						await moveExportedTempFile(tempPath, resolvedPath);
					}
					releaseOwnedExportPath(tempPath);
					approveUserPath(resolvedPath);
					return {
						success: true,
						path: resolvedPath,
						canceled: false,
						message: "Video exported successfully",
					};
				}

				const isGif = lowerFileName.endsWith(".gif");
				const defaultFileName =
					isAlphaQuickTime && !lowerFileName.endsWith(".webm")
						? ensureFileExtension(fileName, ".mov")
						: fileName;
				const filters = isGif
					? [{ name: "GIF Image", extensions: ["gif"] }]
					: isAlphaQuickTime
						? [
								{
									name: "QuickTime Alpha Video (ProRes 4444)",
									extensions: ["mov"],
								},
								{ name: "WebM Video", extensions: ["webm"] },
							]
						: [{ name: "MP4 Video", extensions: ["mp4"] }];
				const parentWindow = BrowserWindow.fromWebContents(event.sender);
				const saveDialogOptions: SaveDialogOptions = {
					title: isGif
						? "Save Exported GIF"
						: isAlphaQuickTime
							? "Save Exported Alpha Video"
							: "Save Exported Video",
					defaultPath: path.join(app.getPath("downloads"), defaultFileName),
					filters,
					properties: ["createDirectory", "showOverwriteConfirmation"],
				};

				const result = parentWindow
					? await dialog.showSaveDialog(parentWindow, saveDialogOptions)
					: await dialog.showSaveDialog(saveDialogOptions);

				if (result.canceled || !result.filePath) {
					// Leave the temp file in place so the renderer can offer "Save Again"
					// without re-rendering. The renderer owns cleanup on discard.
					return {
						success: false,
						canceled: true,
						message: "Export canceled",
					};
				}

				const destinationPath =
					isAlphaQuickTime && !result.filePath.toLowerCase().endsWith(".webm")
						? ensureFileExtension(result.filePath, ".mov")
						: result.filePath;

				if (isWebm && destinationPath.toLowerCase().endsWith(".mov")) {
					await transcodeWebmToProRes(tempPath, destinationPath);
					await fs.rm(tempPath, { force: true }).catch(() => undefined);
				} else {
					await moveExportedTempFile(tempPath, destinationPath);
				}
				releaseOwnedExportPath(tempPath);
				approveUserPath(destinationPath);

				return {
					success: true,
					path: destinationPath,
					canceled: false,
					message: "Video exported successfully",
				};
			} catch (error) {
				console.error("Failed to finalize exported video:", error);
				return {
					success: false,
					canceled: false,
					message: "Failed to save exported video",
					error: String(error),
				};
			}
		},
	);

	ipcMain.handle("discard-exported-temp", async (_event, tempPath: string) => {
		if (typeof tempPath !== "string" || tempPath.length === 0) {
			return { success: false, error: "Invalid temp path" };
		}
		if (!isTempPathSafe(tempPath) || !isOwnedExportPath(tempPath)) {
			return {
				success: false,
				error: "Temp path is not an app-managed export temp",
			};
		}
		try {
			await removeTemporaryExportFile(tempPath);
			releaseOwnedExportPath(tempPath);
			return { success: true };
		} catch (error) {
			return { success: false, error: String(error) };
		}
	});
}
