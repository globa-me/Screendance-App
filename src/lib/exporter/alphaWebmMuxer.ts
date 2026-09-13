import {
	BufferTarget,
	CanvasSource,
	canEncodeVideo,
	type Target as MediabunnyTarget,
	Output,
	StreamTarget,
	type VideoCodec,
	WebMOutputFormat,
} from "mediabunny";

const EXPORT_STREAM_CHUNK_BYTES = 16 * 1024 * 1024;

type IpcStreamSink = {
	readonly streamId: string;
	readonly tempPath: string;
};

export type AlphaWebmFinalizeResult =
	| { mode: "stream"; tempFilePath: string; bytesWritten: number }
	| { mode: "buffer"; blob: Blob };

async function openIpcWebmExportStream(): Promise<IpcStreamSink> {
	if (typeof window === "undefined" || !window.electronAPI?.openExportStream) {
		throw new Error("openExportStream IPC is unavailable in this environment");
	}

	const result = await window.electronAPI.openExportStream({ extension: "webm" });
	if (!result.success || !result.streamId || !result.tempPath) {
		throw new Error(result.error || "Failed to open WebM export stream");
	}

	return { streamId: result.streamId, tempPath: result.tempPath };
}

async function writeIpcExportStream(
	streamId: string,
	position: number,
	chunk: Uint8Array,
): Promise<void> {
	const copy = new Uint8Array(chunk.byteLength);
	copy.set(chunk);
	const result = await window.electronAPI!.writeExportStreamChunk(streamId, position, copy);
	if (!result.success) {
		throw new Error(result.error || "Failed to write WebM export chunk");
	}
}

async function closeIpcExportStream(
	streamId: string,
	options?: { abort?: boolean },
): Promise<{ tempPath: string; bytesWritten: number }> {
	const result = await window.electronAPI!.closeExportStream(streamId, options);
	if (!result.success || !result.tempPath) {
		throw new Error(result.error || "Failed to close WebM export stream");
	}

	return { tempPath: result.tempPath, bytesWritten: result.bytesWritten ?? 0 };
}

function shouldUseStreamTarget(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.electronAPI?.openExportStream === "function" &&
		typeof window.electronAPI?.writeExportStreamChunk === "function" &&
		typeof window.electronAPI?.closeExportStream === "function"
	);
}

export class AlphaWebmMuxer {
	private readonly width: number;
	private readonly height: number;
	private readonly frameRate: number;
	private readonly bitrate: number;
	private readonly keyFrameIntervalFrames: number;
	private codec: VideoCodec = "vp9";
	private output: Output | null = null;
	private source: CanvasSource | null = null;
	private target: MediabunnyTarget | null = null;
	private streamSink: IpcStreamSink | null = null;
	private mode: "stream" | "buffer" = "buffer";

	constructor(config: {
		width: number;
		height: number;
		frameRate: number;
		bitrate: number;
	}) {
		this.width = config.width;
		this.height = config.height;
		this.frameRate = config.frameRate;
		this.bitrate = config.bitrate;
		this.keyFrameIntervalFrames = Math.max(1, Math.round(config.frameRate * 5));
	}

	async initialize(canvas: HTMLCanvasElement): Promise<void> {
		if (canvas.width !== this.width || canvas.height !== this.height) {
			throw new Error(
				`Alpha WebM canvas size mismatch: expected ${this.width}x${this.height}, got ${canvas.width}x${canvas.height}`,
			);
		}

		this.mode = shouldUseStreamTarget() ? "stream" : "buffer";

		if (this.mode === "stream") {
			const sink = await openIpcWebmExportStream();
			this.streamSink = sink;
			const streamId = sink.streamId;
			const writableStream = new WritableStream<{
				type: "write";
				data: Uint8Array;
				position: number;
			}>({
				async write(chunk) {
					if (chunk.type !== "write") {
						return;
					}
					await writeIpcExportStream(streamId, chunk.position, chunk.data);
				},
			});
			this.target = new StreamTarget(writableStream, {
				chunked: true,
				chunkSize: EXPORT_STREAM_CHUNK_BYTES,
			});
		} else {
			this.target = new BufferTarget();
		}

		this.output = new Output({
			format: new WebMOutputFormat(),
			target: this.target,
		});

		this.codec = await this.resolveAlphaCodec();
		this.source = new CanvasSource(canvas, {
			codec: this.codec,
			bitrate: this.bitrate,
			alpha: "keep",
			keyFrameInterval: 5,
			latencyMode: "quality",
			contentHint: "detail",
		});
		this.output.addVideoTrack(this.source, {
			frameRate: this.frameRate,
		});

		await this.output.start();
	}

	private async resolveAlphaCodec(): Promise<VideoCodec> {
		for (const codec of ["vp9", "vp8"] as const) {
			const supported = await canEncodeVideo(codec, {
				width: this.width,
				height: this.height,
				bitrate: this.bitrate,
				alpha: "keep",
				latencyMode: "quality",
			}).catch(() => false);
			if (supported) {
				return codec;
			}
		}

		throw new Error("Transparent WebM export is not supported by this WebCodecs runtime.");
	}

	async addFrame(timestampUs: number, durationUs: number, frameIndex: number): Promise<void> {
		if (!this.source) {
			throw new Error("Alpha WebM muxer is not initialized");
		}

		await this.source.add(timestampUs / 1_000_000, durationUs / 1_000_000, {
			keyFrame: frameIndex % this.keyFrameIntervalFrames === 0,
		});
	}

	async finalize(): Promise<AlphaWebmFinalizeResult> {
		if (!this.output || !this.target) {
			throw new Error("Alpha WebM muxer is not initialized");
		}

		await this.output.finalize();

		if (this.mode === "stream") {
			const sink = this.streamSink;
			if (!sink) {
				throw new Error("WebM stream target closed before finalization");
			}

			this.streamSink = null;
			const closeResult = await closeIpcExportStream(sink.streamId);
			return {
				mode: "stream",
				tempFilePath: closeResult.tempPath,
				bytesWritten: closeResult.bytesWritten,
			};
		}

		const buffer = (this.target as BufferTarget).buffer;
		if (!buffer) {
			throw new Error("Failed to finalize alpha WebM output");
		}

		return { mode: "buffer", blob: new Blob([buffer], { type: "video/webm" }) };
	}

	async abortStream(): Promise<void> {
		if (this.mode !== "stream" || !this.streamSink) {
			return;
		}

		try {
			await closeIpcExportStream(this.streamSink.streamId, { abort: true });
		} catch {
			// Best-effort cleanup; the main process also reaps stale streams on quit.
		} finally {
			this.streamSink = null;
		}
	}

	destroy(): void {
		this.output = null;
		this.source = null;
		this.target = null;
		if (this.streamSink) {
			void this.abortStream();
		}
	}
}
