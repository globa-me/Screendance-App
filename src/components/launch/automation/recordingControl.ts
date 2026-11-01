import { AutomationError } from "../../../../shared/automation";

/** Lifecycle completion belongs to the recorder, independently of its MCP connection. */
export class RecordingFinalizationLatch {
	private resolve: (() => void) | null = null;
	private reject: ((error: Error) => void) | null = null;
	get pending(): boolean {
		return this.resolve !== null;
	}
	wait(): Promise<void> {
		if (this.pending)
			throw new AutomationError("BUSY", "Recording finalization is already being awaited.");
		return new Promise<void>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
	complete(): void {
		const resolve = this.resolve;
		this.clear();
		resolve?.();
	}
	fail(error: Error): void {
		const reject = this.reject;
		this.clear();
		reject?.(error);
	}
	private clear(): void {
		this.resolve = null;
		this.reject = null;
	}
}

export interface RecorderControlState {
	recording: boolean;
	paused: boolean;
	starting: boolean;
	countdownActive: boolean;
	finalizing: boolean;
}

export function assertRecorderTransition(
	state: RecorderControlState,
	command: "start" | "pause" | "resume" | "stop" | "cancel" | "configure" | "recover",
): void {
	if (state.finalizing)
		throw new AutomationError("BUSY", "Recording assets are being finalized.");
	if (state.countdownActive && (command === "cancel" || command === "stop")) return;
	if (state.starting || state.countdownActive)
		throw new AutomationError("BUSY", "Recording is starting or counting down.");
	if (command === "start" || command === "configure" || command === "recover") {
		if (state.recording)
			throw new AutomationError(
				command === "start" ? "ALREADY_RECORDING" : "BUSY",
				"A recording is active.",
			);
		return;
	}
	if (!state.recording) throw new AutomationError("NOT_RECORDING", "No recording is active.");
	if (command === "pause" && state.paused)
		throw new AutomationError("ALREADY_PAUSED", "Recording is already paused.");
	if (command === "resume" && !state.paused)
		throw new AutomationError("NOT_PAUSED", "Recording is not paused.");
}

/** Own the countdown/start transition without ever mapping a duplicate start to stop. */
export class RecordingStartCoordinator {
	starting = false;
	countdownActive = false;
	private generation = 0;
	async start<T>(callbacks: {
		delaySeconds: number;
		countdown: (seconds: number) => Promise<{ success: boolean; cancelled?: boolean }>;
		onCountdown: (active: boolean) => void;
		start: () => Promise<T>;
	}): Promise<T> {
		if (this.starting) throw new AutomationError("BUSY", "Recording is already starting.");
		this.starting = true;
		const generation = ++this.generation;
		try {
			if (callbacks.delaySeconds > 0) {
				this.countdownActive = true;
				callbacks.onCountdown(true);
				const result = await callbacks.countdown(callbacks.delaySeconds);
				this.countdownActive = false;
				callbacks.onCountdown(false);
				if (!result.success || result.cancelled || generation !== this.generation)
					throw new AutomationError("CANCELLED", "Recording countdown was cancelled.");
			}
			return await callbacks.start();
		} finally {
			this.starting = false;
			this.countdownActive = false;
			callbacks.onCountdown(false);
		}
	}
	async cancelCountdown(cancel: () => Promise<{ success: boolean }>): Promise<void> {
		if (!this.countdownActive)
			throw new AutomationError("BUSY", "The recorder is past its countdown.");
		this.generation += 1;
		const result = await cancel();
		if (!result.success)
			throw new AutomationError("CANCEL_FAILED", "Could not cancel countdown.");
	}
}

export async function deleteOwnedCancelledRecording(
	startedPath: string | null,
	stoppedPath: string | undefined,
	remove: (path: string) => Promise<{ success: boolean }>,
): Promise<string[]> {
	if (!stoppedPath) return [];
	if (!startedPath || startedPath !== stoppedPath) return [stoppedPath];
	try {
		return (await remove(stoppedPath)).success ? [] : [stoppedPath];
	} catch {
		return [stoppedPath];
	}
}

/** Release an owned resource if async acquisition completes after its recording ended. */
export class RecorderResourceLease {
	private generation = 0;
	invalidate(): void {
		this.generation += 1;
	}
	async acquire<T>(
		acquire: () => Promise<T>,
		release: (resource: T) => void,
		attach: (resource: T) => void,
	): Promise<boolean> {
		const generation = this.generation;
		const resource = await acquire();
		if (generation !== this.generation) {
			release(resource);
			return false;
		}
		try {
			attach(resource);
			return true;
		} catch (error) {
			release(resource);
			throw error;
		}
	}
}

export type RecorderMutation = "starting" | "stopping" | "cancelling" | "pausing" | "resuming";
export function claimRecorderMutation(
	lock: { current: RecorderMutation | null },
	mutation: RecorderMutation,
): boolean {
	if (lock.current) return false;
	lock.current = mutation;
	return true;
}
export function releaseRecorderMutation(
	lock: { current: RecorderMutation | null },
	mutation: RecorderMutation,
): void {
	if (lock.current === mutation) lock.current = null;
}

export function commitRecorderControlState(
	state: { current: RecorderControlState },
	field: keyof RecorderControlState,
	value: boolean,
	dispatch: (value: boolean) => void,
): void {
	state.current[field] = value;
	dispatch(value);
}
