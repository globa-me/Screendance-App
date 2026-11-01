/**
 * Draws the active camera into a canvas and exposes the canvas as the stream
 * the webcam MediaRecorder records. Because the recorder never sees the camera
 * track directly, the camera can be turned off, turned back on or swapped for
 * another device while a recording is paused without ending the webcam file.
 *
 * While no camera is attached the canvas is filled with black; the recorder
 * tracks those spans as hidden ranges so the editor hides the overlay there.
 */
export class LiveWebcamCompositor {
	readonly canvas: HTMLCanvasElement;
	private readonly context: CanvasRenderingContext2D;
	private readonly video: HTMLVideoElement;
	private cameraStream: MediaStream | null = null;
	private drawTimer: ReturnType<typeof setInterval> | null = null;
	private outputStream: MediaStream | null = null;

	constructor(
		width: number,
		height: number,
		private readonly frameRate: number,
	) {
		this.canvas = document.createElement("canvas");
		this.canvas.width = Math.max(2, Math.round(width));
		this.canvas.height = Math.max(2, Math.round(height));
		const context = this.canvas.getContext("2d", { alpha: false });
		if (!context) {
			throw new Error("Canvas 2D context is unavailable for the webcam compositor.");
		}
		this.context = context;
		this.video = document.createElement("video");
		this.video.muted = true;
		this.video.playsInline = true;
		this.fillBlack();
	}

	get hasCamera(): boolean {
		return this.cameraStream !== null;
	}

	/** Starts drawing and returns the stream to record. */
	start(): MediaStream {
		if (!this.outputStream) {
			this.outputStream = this.canvas.captureStream(this.frameRate);
		}
		if (!this.drawTimer) {
			// Timers keep running in the background-throttling-disabled HUD even
			// when it is hidden, unlike requestAnimationFrame.
			this.drawTimer = setInterval(() => this.drawFrame(), 1000 / this.frameRate);
		}
		return this.outputStream;
	}

	/** Attaches a camera stream (stopping the previous one) or detaches with `null`. */
	async setCamera(stream: MediaStream | null): Promise<void> {
		const previous = this.cameraStream;
		this.cameraStream = stream;
		if (previous && previous !== stream) {
			for (const track of previous.getTracks()) track.stop();
		}
		if (!stream) {
			this.video.srcObject = null;
			this.fillBlack();
			return;
		}
		this.video.srcObject = stream;
		try {
			await this.video.play();
		} catch {
			// The draw loop keeps the canvas black until frames arrive.
		}
	}

	dispose(): void {
		if (this.drawTimer) {
			clearInterval(this.drawTimer);
			this.drawTimer = null;
		}
		for (const track of this.outputStream?.getTracks() ?? []) track.stop();
		this.outputStream = null;
		void this.setCamera(null);
	}

	private fillBlack(): void {
		this.context.fillStyle = "#000";
		this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
	}

	private drawFrame(): void {
		const { videoWidth, videoHeight } = this.video;
		if (!this.cameraStream || videoWidth <= 0 || videoHeight <= 0) {
			this.fillBlack();
			return;
		}
		// Cover-fit so a camera with another aspect ratio keeps the canvas filled.
		const scale = Math.max(this.canvas.width / videoWidth, this.canvas.height / videoHeight);
		const drawWidth = videoWidth * scale;
		const drawHeight = videoHeight * scale;
		this.context.drawImage(
			this.video,
			(this.canvas.width - drawWidth) / 2,
			(this.canvas.height - drawHeight) / 2,
			drawWidth,
			drawHeight,
		);
	}
}

export type TimeRange = { startMs: number; endMs: number };

/** Tracks spans of recording time during which the webcam was off. */
export class HiddenRangeTracker {
	private readonly ranges: TimeRange[] = [];
	private hiddenSinceMs: number | null = null;

	get isHidden(): boolean {
		return this.hiddenSinceMs !== null;
	}

	hide(atMs: number): void {
		if (this.hiddenSinceMs === null) this.hiddenSinceMs = Math.max(0, atMs);
	}

	show(atMs: number): void {
		if (this.hiddenSinceMs === null) return;
		this.push(this.hiddenSinceMs, atMs);
		this.hiddenSinceMs = null;
	}

	/** Closes an open range at `endMs` and returns all ranges. */
	finish(endMs: number): TimeRange[] {
		if (this.hiddenSinceMs !== null) {
			this.push(this.hiddenSinceMs, endMs);
			this.hiddenSinceMs = null;
		}
		return [...this.ranges];
	}

	private push(startMs: number, endMs: number): void {
		const start = Math.max(0, Math.round(startMs));
		const end = Math.round(endMs);
		if (end <= start) return;
		const last = this.ranges[this.ranges.length - 1];
		if (last && start <= last.endMs) {
			last.endMs = Math.max(last.endMs, end);
			return;
		}
		this.ranges.push({ startMs: start, endMs: end });
	}
}
