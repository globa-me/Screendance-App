import type { Writable } from "node:stream";

/**
 * Request/response bridge for commands sent to the running macOS
 * ScreenCaptureKit helper while a recording is paused. The helper answers each
 * command with a single stdout line:
 *
 *   SOURCE_SWITCHED {json}      | SOURCE_SWITCH_FAILED <message>
 *   MICROPHONE_UPDATED {json}   | MICROPHONE_UPDATE_FAILED <message>
 */

export type NativeLiveCommandKind = "source" | "microphone";

const COMMAND_NAMES: Record<NativeLiveCommandKind, string> = {
	source: "switch_source",
	microphone: "set_microphone",
};

const RESPONSE_PREFIXES: Record<NativeLiveCommandKind, { ok: string; failed: string }> = {
	source: { ok: "SOURCE_SWITCHED ", failed: "SOURCE_SWITCH_FAILED" },
	microphone: { ok: "MICROPHONE_UPDATED ", failed: "MICROPHONE_UPDATE_FAILED" },
};

type PendingCommand = {
	resolve: (payload: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

const pendingCommands = new Map<NativeLiveCommandKind, PendingCommand>();

export function sendNativeLiveCommand(
	stdin: Writable,
	kind: NativeLiveCommandKind,
	payload: Record<string, unknown>,
	timeoutMs = 8000,
): Promise<unknown> {
	if (pendingCommands.has(kind)) {
		return Promise.reject(new Error(`A ${kind} change is already in progress.`));
	}

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingCommands.delete(kind);
			reject(new Error(`Timed out waiting for the recorder to apply the ${kind} change.`));
		}, timeoutMs);
		pendingCommands.set(kind, { resolve, reject, timer });
		try {
			stdin.write(`${COMMAND_NAMES[kind]} ${JSON.stringify(payload)}\n`);
		} catch (error) {
			clearTimeout(timer);
			pendingCommands.delete(kind);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

/** Returns true when the line was a live-control response. */
export function handleNativeLiveCommandLine(line: string): boolean {
	for (const kind of Object.keys(RESPONSE_PREFIXES) as NativeLiveCommandKind[]) {
		const { ok, failed } = RESPONSE_PREFIXES[kind];
		if (line.startsWith(ok)) {
			const pending = pendingCommands.get(kind);
			if (pending) {
				pendingCommands.delete(kind);
				clearTimeout(pending.timer);
				try {
					pending.resolve(JSON.parse(line.slice(ok.length)));
				} catch (error) {
					pending.reject(error instanceof Error ? error : new Error(String(error)));
				}
			}
			return true;
		}
		if (line.startsWith(failed)) {
			const pending = pendingCommands.get(kind);
			if (pending) {
				pendingCommands.delete(kind);
				clearTimeout(pending.timer);
				pending.reject(
					new Error(
						line.slice(failed.length).trim() || `Failed to apply ${kind} change.`,
					),
				);
			}
			return true;
		}
	}
	return false;
}

/** Rejects every in-flight command, e.g. when the helper exits. */
export function rejectPendingNativeLiveCommands(reason: string): void {
	for (const [kind, pending] of pendingCommands) {
		clearTimeout(pending.timer);
		pending.reject(new Error(reason));
		pendingCommands.delete(kind);
	}
}

export type NormalizedViewport = { x: number; y: number; width: number; height: number };

export function parseSourceSwitchViewport(payload: unknown): NormalizedViewport | null {
	const viewport = (payload as { viewport?: Partial<NormalizedViewport> } | null)?.viewport;
	if (!viewport) return null;
	const { x, y, width, height } = viewport;
	if (
		![x, y, width, height].every(
			(value) => typeof value === "number" && Number.isFinite(value),
		) ||
		(width as number) <= 0 ||
		(height as number) <= 0
	) {
		return null;
	}
	const normalized = {
		x: x as number,
		y: y as number,
		width: width as number,
		height: height as number,
	};
	const isFullFrame =
		Math.abs(normalized.x) < 0.001 &&
		Math.abs(normalized.y) < 0.001 &&
		Math.abs(normalized.width - 1) < 0.001 &&
		Math.abs(normalized.height - 1) < 0.001;
	return isFullFrame ? null : normalized;
}

/** `/x/recording-1.mp4` -> `/x/recording-1.mic.m4a` (the helper's sidecar naming). */
export function deriveMicrophoneSidecarPath(videoPath: string): string {
	return videoPath.replace(/\.(mp4|mov)$/i, "") + ".mic.m4a";
}
