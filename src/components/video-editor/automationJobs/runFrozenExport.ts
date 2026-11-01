import { AutomationError } from "../../../../shared/automation";
import { cloneJobJson, type JobJson, type JobObject } from "../../../../shared/jobAutomation";
import { getMp4ExportBitrate, getSourceQualityBitrate } from "../../../lib/exporter/exportBitrate";
import { calculateOutputDimensions, GifExporter } from "../../../lib/exporter/gifExporter";
import { getLocalFilePath } from "../../../lib/exporter/localMediaSource";
import { ModernVideoExporter } from "../../../lib/exporter/modernVideoExporter";
import { DEFAULT_MP4_CODEC, probeSupportedMp4Dimensions } from "../../../lib/exporter/mp4Support";
import {
	type ExportProgress,
	type ExportResult,
	type ExportSettings,
	GIF_SIZE_PRESETS,
	type GifFrameRate,
	type GifSizePreset,
} from "../../../lib/exporter/types";
import { VideoExporter } from "../../../lib/exporter/videoExporter";
import type { AspectRatio } from "../../../utils/aspectRatioUtils";
import {
	calculateAlphaSafeCanvasDimensions,
	calculateMp4ExportDimensions,
	calculateMp4SourceDimensions,
	normalizeAlphaSafeCanvasScale,
} from "../exportDimensions";
import { resolveVideoUrl } from "../projectPersistence";
import type { RendererAutomationJobContext } from "./useAutomationJobs";

type CommonConfig = Omit<
	ConstructorParameters<typeof ModernVideoExporter>[0],
	"videoUrl" | "width" | "height" | "frameRate" | "bitrate"
>;
export interface FrozenExportSnapshot {
	videoPath: string;
	videoWidth: number;
	videoHeight: number;
	previewWidth?: number;
	previewHeight?: number;
	aspectRatio?: AspectRatio;
	revision?: number;
	commonConfig: CommonConfig;
	defaults: Partial<ExportSettings> & {
		exportFormat?: "mp4" | "gif";
		exportTransparentBackground?: boolean;
		exportAlphaSafeCanvas?: boolean;
		exportAlphaSafeCanvasScale?: number;
		exportAlphaFormat?: "mov" | "webm";
		gifFrameRate?: GifFrameRate;
		gifLoop?: boolean;
		gifSizePreset?: GifSizePreset;
	};
}

/** Same codecs/compositor as UI export, but all document values come from a frozen snapshot. */
export async function runFrozenExport(
	snapshotValue: JobJson,
	input: JobObject,
	context: RendererAutomationJobContext,
): Promise<JobObject> {
	const snapshot = cloneJobJson(snapshotValue) as unknown as FrozenExportSnapshot;
	if (
		!snapshot ||
		typeof snapshot !== "object" ||
		typeof snapshot.videoPath !== "string" ||
		!snapshot.videoPath ||
		!snapshot.commonConfig ||
		!snapshot.defaults ||
		!Number.isFinite(snapshot.videoWidth) ||
		!Number.isFinite(snapshot.videoHeight) ||
		snapshot.videoWidth < 1 ||
		snapshot.videoHeight < 1 ||
		snapshot.videoWidth > 16384 ||
		snapshot.videoHeight > 16384
	)
		throw new AutomationError(
			"INVALID_SNAPSHOT",
			"Frozen export needs source dimensions, composition and settings.",
		);
	context.signal.throwIfAborted();
	const defaults = snapshot.defaults;
	const overrides = (input.settings ?? {}) as Partial<ExportSettings>;
	const settings: ExportSettings = {
		format: defaults.format ?? defaults.exportFormat ?? "mp4",
		...defaults,
		transparentBackground:
			defaults.transparentBackground ?? defaults.exportTransparentBackground ?? false,
		alphaSafeCanvas: defaults.alphaSafeCanvas ?? defaults.exportAlphaSafeCanvas ?? false,
		alphaSafeCanvasScale:
			defaults.alphaSafeCanvasScale ?? defaults.exportAlphaSafeCanvasScale ?? 1.5,
		alphaFormat: defaults.alphaFormat ?? defaults.exportAlphaFormat ?? "mov",
		...overrides,
	};
	const format =
		settings.format === "gif"
			? "gif"
			: settings.transparentBackground
				? (settings.alphaFormat ?? "mov")
				: "mp4";
	if (
		typeof input.outputPath !== "string" ||
		!input.outputPath.toLowerCase().endsWith(`.${format}`)
	)
		throw new AutomationError(
			"INVALID_PARAMS",
			`Output path must use .${format} for these frozen export settings.`,
		);
	const fileName = input.outputPath.split(/[\\/]/).pop() || `export-${context.jobId}.${format}`;
	const common = snapshot.commonConfig;
	// Stored media-server URLs may refer to a prior desktop process; always refresh local sources.
	const sourcePath = getLocalFilePath(snapshot.videoPath) ?? snapshot.videoPath;
	const videoUrl = await resolveVideoUrl(sourcePath);
	const cameraSource =
		common.webcam?.sourcePath ?? (common.webcamUrl ? getLocalFilePath(common.webcamUrl) : null);
	const webcamUrl = cameraSource
		? await resolveVideoUrl(cameraSource)
		: (common.webcamUrl ?? null);
	const wallpaperPath = getLocalFilePath(common.wallpaper);
	const wallpaper = wallpaperPath ? await resolveVideoUrl(wallpaperPath) : common.wallpaper;
	context.signal.throwIfAborted();
	let width: number;
	let height: number;
	let exporter: { export(): Promise<ExportResult>; cancel(): void | Promise<void> };
	const onProgress = (progress: ExportProgress) => {
		const report: { phase: string; [key: string]: string | number | string[] } = {
			phase: progress.phase ?? "rendering",
		};
		for (const [key, value] of Object.entries(progress))
			if (
				(typeof value === "number" && Number.isFinite(value)) ||
				typeof value === "string" ||
				(Array.isArray(value) && value.every((entry) => typeof entry === "string"))
			)
				report[key] = value;
		if (typeof report.percentage === "number")
			report.percentage = Math.min(100, Math.max(0, report.percentage));
		context.progress(report);
	};
	if (settings.format === "gif") {
		const sizePreset = settings.gifConfig?.sizePreset ?? defaults.gifSizePreset ?? "medium";
		const dimensions = calculateOutputDimensions(
			snapshot.videoWidth,
			snapshot.videoHeight,
			sizePreset,
			GIF_SIZE_PRESETS,
		);
		width = settings.gifConfig?.width ?? dimensions.width;
		height = settings.gifConfig?.height ?? dimensions.height;
		exporter = new GifExporter({
			...common,
			videoUrl,
			webcamUrl,
			wallpaper,
			videoPadding: common.padding,
			width,
			height,
			frameRate: settings.gifConfig?.frameRate ?? defaults.gifFrameRate ?? 15,
			loop: settings.gifConfig?.loop ?? defaults.gifLoop ?? true,
			sizePreset,
			previewWidth: snapshot.previewWidth ?? common.previewWidth,
			previewHeight: snapshot.previewHeight ?? common.previewHeight,
			onProgress,
		} as ConstructorParameters<typeof GifExporter>[0]);
	} else {
		const alpha = settings.transparentBackground === true;
		const pipeline = alpha ? "modern" : (settings.pipelineModel ?? "modern");
		const backend =
			alpha || pipeline === "legacy" ? "webcodecs" : (settings.backendPreference ?? "auto");
		const useNative = !alpha && pipeline === "modern" && backend !== "webcodecs";
		const fps = settings.mp4FrameRate ?? 30;
		const quality = settings.quality ?? "high";
		const encodingMode = settings.encodingMode ?? "balanced";
		const desired = calculateMp4SourceDimensions(
			snapshot.videoWidth,
			snapshot.videoHeight,
			snapshot.aspectRatio ?? "native",
		);
		const supported = alpha
			? { ...desired, encoderPath: null }
			: await probeSupportedMp4Dimensions({
					...desired,
					frameRate: fps,
					codec: DEFAULT_MP4_CODEC,
					getBitrate: getSourceQualityBitrate,
				});
		if (!alpha && !supported.encoderPath)
			throw new AutomationError(
				"ENCODER_UNAVAILABLE",
				`No supported MP4 encoder at ${fps} FPS.`,
			);
		const base = calculateMp4ExportDimensions(supported.width, supported.height, quality);
		const safeCanvas =
			alpha && settings.alphaSafeCanvas === true
				? calculateAlphaSafeCanvasDimensions(
						base.width,
						base.height,
						normalizeAlphaSafeCanvasScale(settings.alphaSafeCanvasScale ?? 1.5),
					)
				: null;
		width = safeCanvas?.width ?? base.width;
		height = safeCanvas?.height ?? base.height;
		const config: ConstructorParameters<typeof ModernVideoExporter>[0] = {
			...common,
			videoUrl,
			webcamUrl,
			wallpaper,
			width,
			height,
			frameRate: fps,
			bitrate: getMp4ExportBitrate({
				width,
				height,
				frameRate: fps,
				quality,
				encodingMode,
				useModernNativeStaticLayout: useNative,
			}),
			codec: DEFAULT_MP4_CODEC,
			encodingMode,
			backendPreference: backend,
			preferredEncoderPath: supported.encoderPath,
			experimentalNativeExport: useNative,
			transparentBackground: alpha,
			alphaSafeCanvas: !!safeCanvas,
			alphaFormat: settings.alphaFormat ?? "mov",
			...(safeCanvas
				? {
						layoutViewport: {
							x: Math.round((width - base.width) / 2),
							y: Math.round((height - base.height) / 2),
							width: base.width,
							height: base.height,
						},
					}
				: {}),
			previewWidth: snapshot.previewWidth ?? common.previewWidth,
			previewHeight: snapshot.previewHeight ?? common.previewHeight,
			onProgress,
		};
		context.signal.throwIfAborted();
		exporter =
			pipeline === "legacy"
				? new VideoExporter({ ...config, videoPadding: undefined })
				: new ModernVideoExporter(config);
	}
	let cancellation: Promise<void> | undefined;
	let outputTemp: string | undefined;
	const cancel = () => {
		cancellation ??= Promise.resolve()
			.then(() => exporter.cancel())
			.catch(() => undefined);
	};
	context.signal.addEventListener("abort", cancel, { once: true });
	try {
		if (context.signal.aborted) {
			cancel();
			context.signal.throwIfAborted();
		}
		const result = await exporter.export();
		outputTemp = result.tempFilePath;
		if (context.signal.aborted) {
			await cancellation;
			context.signal.throwIfAborted();
		}
		if (!result.success || (!result.tempFilePath && !result.blob))
			throw new AutomationError(
				"EXPORT_FAILED",
				result.error ?? "Exporter produced no output.",
			);
		if (!outputTemp && result.blob)
			outputTemp = await streamFrozenExportBlob(result.blob, format, context.signal);
		context.signal.throwIfAborted();
		if (!outputTemp)
			throw new AutomationError(
				"EXPORT_FAILED",
				"Exporter did not produce a managed temporary file.",
			);
		context.checkpoint({
			pendingOutputPath: outputTemp,
			tempFilePath: outputTemp,
			fileName,
			format,
		});
		// External publication is deliberately owned by the main process after this worker returns.
		return JSON.parse(
			JSON.stringify(
				{
					tempFilePath: outputTemp,
					fileName,
					format,
					width,
					height,
					revision: snapshot.revision,
					settings,
					metrics: result.metrics,
				},
				(_key, value) =>
					typeof value === "number" && !Number.isFinite(value) ? null : value,
			),
		) as JobObject;
	} catch (error) {
		if (outputTemp)
			await window.electronAPI.discardExportedTemp(outputTemp).catch(() => undefined);
		throw error;
	} finally {
		context.signal.removeEventListener("abort", cancel);
		await cancellation;
	}
}

/** Stream GIF/legacy output to the same managed main-process temporary-file API as the UI. */
export async function streamFrozenExportBlob(
	blob: Blob,
	extension: string,
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	const opened = await window.electronAPI.openExportStream({ extension });
	if (!opened.success || !opened.streamId || !opened.tempPath)
		throw new AutomationError(
			"EXPORT_STREAM_FAILED",
			opened.error ?? "Cannot open export output stream.",
		);
	try {
		let position = 0;
		while (position < blob.size) {
			signal.throwIfAborted();
			const bytes = new Uint8Array(
				await blob.slice(position, position + 16 * 1024 * 1024).arrayBuffer(),
			);
			const written = await window.electronAPI.writeExportStreamChunk(
				opened.streamId,
				position,
				bytes,
			);
			if (!written.success)
				throw new AutomationError(
					"EXPORT_STREAM_FAILED",
					written.error ?? "Cannot write export output stream.",
				);
			position += bytes.byteLength;
		}
		signal.throwIfAborted();
		const closed = await window.electronAPI.closeExportStream(opened.streamId);
		if (!closed.success || !closed.tempPath)
			throw new AutomationError(
				"EXPORT_STREAM_FAILED",
				closed.error ?? "Cannot finish export output stream.",
			);
		if (signal.aborted) {
			await window.electronAPI.discardExportedTemp(closed.tempPath);
			signal.throwIfAborted();
		}
		return closed.tempPath;
	} catch (error) {
		await window.electronAPI
			.closeExportStream(opened.streamId, { abort: true })
			.catch(() => undefined);
		throw error;
	}
}
