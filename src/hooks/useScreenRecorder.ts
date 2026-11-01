import { fixWebmDuration } from "@fix-webm-duration/fix";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { getEffectiveRecordingDurationMs } from "@/lib/mediaTiming";
import { AutomationError } from "../../shared/automation";
import {
	assertRecorderTransition,
	claimRecorderMutation,
	commitRecorderControlState,
	deleteOwnedCancelledRecording,
	RecorderResourceLease,
	RecordingFinalizationLatch,
	RecordingStartCoordinator,
	releaseRecorderMutation,
} from "../components/launch/automation/recordingControl";
import {
	getVideoExtensionForMimeType,
	isWebmMimeType,
	selectRecordingMimeType,
	selectWebcamRecordingMimeType,
} from "./recordingMimeType";
import { createMicrophoneDeviceOptions } from "./useMicrophoneDevices";

const TARGET_FRAME_RATE = 60;
const TARGET_WIDTH = 3840;
const TARGET_HEIGHT = 2160;
const FOUR_K_PIXELS = TARGET_WIDTH * TARGET_HEIGHT;
const QHD_WIDTH = 2560;
const QHD_HEIGHT = 1440;
const QHD_PIXELS = QHD_WIDTH * QHD_HEIGHT;
const BITRATE_4K = 45_000_000;
const BITRATE_QHD = 28_000_000;
const BITRATE_BASE = 18_000_000;
const HIGH_FRAME_RATE_THRESHOLD = 60;
const HIGH_FRAME_RATE_BOOST = 1.7;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const CODEC_ALIGNMENT = 2;
const RECORDER_TIMESLICE_MS = 250;
const BITS_PER_MEGABIT = 1_000_000;
const MIN_FRAME_RATE = 30;
const CHROME_MEDIA_SOURCE = "desktop";
const RECORDING_FILE_PREFIX = "recording-";
const VIDEO_FILE_EXTENSION = ".webm";
const AUDIO_BITRATE_VOICE = 128_000;
const AUDIO_BITRATE_SYSTEM = 192_000;
const WEBCAM_BITRATE = 8_000_000;
const WEBCAM_WIDTH = 1280;
const WEBCAM_HEIGHT = 720;
const WEBCAM_FRAME_RATE = 30;
const WEBCAM_SUFFIX = "-webcam";
const MICROPHONE_FALLBACK_ERROR_TOAST_ID = "recording-microphone-fallback-error";
const MICROPHONE_SIDECAR_ERROR_TOAST_ID = "recording-microphone-sidecar-error";
const SILENT_RECORDING_AUDIO_LEVELS: RecordingAudioLevels = {
	system: 0,
	microphone: 0,
	mixed: 0,
};
export type BrowserMicrophoneProfile =
	| "processed"
	| "no-agc"
	| "no-echo"
	| "no-noise-suppression"
	| "raw";
const DEFAULT_BROWSER_MICROPHONE_PROFILE: BrowserMicrophoneProfile = "no-agc";
const BROWSER_MICROPHONE_PROFILES = new Set<BrowserMicrophoneProfile>([
	"processed",
	"no-agc",
	"no-echo",
	"no-noise-suppression",
	"raw",
]);
type MicrophoneTrackSettingsSnapshot = Partial<
	Pick<
		MediaTrackSettings,
		| "autoGainControl"
		| "channelCount"
		| "deviceId"
		| "echoCancellation"
		| "groupId"
		| "noiseSuppression"
		| "sampleRate"
		| "sampleSize"
	>
> & {
	trackId?: string;
	trackLabel?: string;
	trackEnabled?: boolean;
	trackMuted?: boolean;
	trackReadyState?: MediaStreamTrackState;
};
type MicrophoneAudioInputDeviceSnapshot = {
	deviceId: string;
	groupId?: string;
	label: string;
};
type MicrophoneFallbackChunkEvent = {
	index: number;
	size: number;
	elapsedMs: number;
	deltaMs: number | null;
	recordedElapsedMs: number;
	recordedDeltaMs: number | null;
};
type MicrophoneFallbackPauseInterval = {
	startElapsedMs: number;
	endElapsedMs?: number;
	durationMs?: number;
};
type MicrophoneFallbackRecorderMetadata = {
	mimeType: string;
	audioBitsPerSecond: number;
	timesliceMs: number;
};
type MicrophoneSidecarOptions = {
	startDelayMs?: number;
	browserMicrophoneProfile?: BrowserMicrophoneProfile;
	requestedBrowserMicrophoneProfile?: string | null;
	requestedConstraints?: MediaStreamConstraints;
	mediaTrackSettings?: MicrophoneTrackSettingsSnapshot;
	audioInputDevices?: MicrophoneAudioInputDeviceSnapshot[];
	mediaRecorder?: MicrophoneFallbackRecorderMetadata;
	chunkEvents?: MicrophoneFallbackChunkEvent[];
	pauseIntervals?: MicrophoneFallbackPauseInterval[];
};
const LINUX_PORTAL_SOURCE: ProcessedDesktopSource = {
	id: "screen:linux-portal",
	name: "Linux Portal",
	display_id: "",
	thumbnail: null,
	appIcon: null,
	sourceType: "screen",
};

type DesktopCaptureMediaDevices = {
	getUserMedia: (constraints: unknown) => Promise<MediaStream>;
	getDisplayMedia: (constraints: unknown) => Promise<MediaStream>;
};

export type UseScreenRecorderReturn = {
	ready: boolean;
	starting: boolean;
	automation: {
		retain: () => void;
		status: () => {
			recording: boolean;
			paused: boolean;
			starting: boolean;
			countdownActive: boolean;
			finalizing: boolean;
			warnings: string[];
		};
		start: () => Promise<unknown>;
		stop: () => Promise<unknown>;
		pause: () => Promise<unknown>;
		resume: () => Promise<unknown>;
		cancel: () => Promise<unknown>;
		recover: () => Promise<unknown>;
	};
	recording: boolean;
	paused: boolean;
	finalizing: boolean;
	countdownActive: boolean;
	toggleRecording: () => void;
	pauseRecording: () => void;
	resumeRecording: () => void;
	cancelRecording: () => void;
	preparePermissions: (options?: { startup?: boolean }) => Promise<boolean>;
	isMacOS: boolean;
	microphoneEnabled: boolean;
	setMicrophoneEnabled: (enabled: boolean) => void;
	microphoneDeviceId: string | undefined;
	setMicrophoneDeviceId: (deviceId: string | undefined) => void;
	systemAudioEnabled: boolean;
	setSystemAudioEnabled: (enabled: boolean) => void;
	recordingAudioSources: RecordingAudioSources;
	recordingAudioLevels: RecordingAudioLevels;
	webcamEnabled: boolean;
	setWebcamEnabled: (enabled: boolean) => void;
	webcamDeviceId: string | undefined;
	setWebcamDeviceId: (deviceId: string | undefined) => void;
	countdownDelay: number;
	setCountdownDelay: (delay: number) => void;
};

export type RecordingAudioLevels = {
	system: number;
	microphone: number;
	mixed: number;
};

export type RecordingAudioSources = {
	systemAudioEnabled: boolean;
	microphoneEnabled: boolean;
	microphoneDeviceId?: string;
	microphoneLabel?: string;
};

function getErrorMessage(error: unknown) {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	if (typeof error === "string" && error.trim().length > 0) {
		return error;
	}

	if (typeof error === "object" && error !== null) {
		try {
			const serialized = JSON.stringify(error);
			if (serialized && serialized !== "{}") {
				return serialized;
			}
		} catch {
			// Ignore stringify failures and fall through to a generic message.
		}

		if (typeof (error as { toString?: () => string }).toString === "function") {
			const stringified = (error as { toString: () => string }).toString();
			if (stringified && stringified !== "[object Object]") {
				return stringified;
			}
		}
	}

	return "An unexpected error occurred";
}

export function normalizeBrowserMicrophoneProfile(value?: string | null): BrowserMicrophoneProfile {
	const normalized = value?.trim().toLowerCase();
	return normalized && BROWSER_MICROPHONE_PROFILES.has(normalized as BrowserMicrophoneProfile)
		? (normalized as BrowserMicrophoneProfile)
		: DEFAULT_BROWSER_MICROPHONE_PROFILE;
}

export function createProcessedMicrophoneConstraints(
	microphoneDeviceId?: string,
	profile: BrowserMicrophoneProfile = DEFAULT_BROWSER_MICROPHONE_PROFILE,
): MediaStreamConstraints {
	const normalizedProfile = normalizeBrowserMicrophoneProfile(profile);
	const audio: MediaTrackConstraints = {
		echoCancellation: normalizedProfile !== "no-echo" && normalizedProfile !== "raw",
		noiseSuppression:
			normalizedProfile !== "no-noise-suppression" && normalizedProfile !== "raw",
		autoGainControl: normalizedProfile !== "no-agc" && normalizedProfile !== "raw",
		channelCount: { ideal: 1 },
		sampleRate: { ideal: 48000 },
	};

	if (microphoneDeviceId) {
		audio.deviceId = { exact: microphoneDeviceId };
	}

	return { audio, video: false };
}

function createMicrophoneTrackSettingsSnapshot(
	stream: MediaStream,
): MicrophoneTrackSettingsSnapshot | null {
	const track = stream.getAudioTracks()[0];
	const settings = track?.getSettings?.();
	if (!track || !settings) {
		return null;
	}

	const snapshot: MicrophoneTrackSettingsSnapshot = {
		trackId: track.id,
		trackLabel: track.label,
		trackEnabled: track.enabled,
		trackMuted: track.muted,
		trackReadyState: track.readyState,
	};
	for (const key of [
		"autoGainControl",
		"channelCount",
		"deviceId",
		"echoCancellation",
		"groupId",
		"noiseSuppression",
		"sampleRate",
		"sampleSize",
	] as const) {
		const value = settings[key];
		if (value !== undefined) {
			snapshot[key] = value as never;
		}
	}

	return Object.keys(snapshot).length > 0 ? snapshot : null;
}

async function createAudioInputDeviceSnapshot(): Promise<
	MicrophoneAudioInputDeviceSnapshot[] | null
> {
	if (typeof navigator.mediaDevices?.enumerateDevices !== "function") {
		return null;
	}

	const devices = await navigator.mediaDevices.enumerateDevices();
	const audioInputs = devices
		.filter((device) => device.kind === "audioinput")
		.map((device) => ({
			deviceId: device.deviceId,
			...(device.groupId ? { groupId: device.groupId } : {}),
			label: device.label,
		}));

	return audioInputs.length > 0 ? audioInputs : null;
}

async function resolveRecordingMicrophoneDevice(preferredDeviceId?: string) {
	if (typeof navigator.mediaDevices?.enumerateDevices !== "function") {
		return null;
	}

	const devices = createMicrophoneDeviceOptions(await navigator.mediaDevices.enumerateDevices());
	if (devices.length === 0) {
		return null;
	}

	const preferred =
		preferredDeviceId && preferredDeviceId !== "default"
			? devices.find((device) => device.deviceId === preferredDeviceId)
			: undefined;

	if (preferredDeviceId && preferredDeviceId !== "default") {
		return preferred ?? null;
	}

	return devices[0] ?? null;
}

export function useScreenRecorder(): UseScreenRecorderReturn {
	const tLaunch = useScopedT("launch");
	const [recording, setRecordingState] = useState(false);
	const [preferencesReady, setPreferencesReady] = useState(false);
	const [countdownReady, setCountdownReady] = useState(false);
	const [paused, setPausedState] = useState(false);
	const [starting, setStartingState] = useState(false);
	const [finalizing, setFinalizingState] = useState(false);
	const [countdownActive, setCountdownActiveState] = useState(false);
	const [isMacOS, setIsMacOS] = useState(false);
	const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
	const [microphoneDeviceId, setMicrophoneDeviceId] = useState<string | undefined>(undefined);
	const [systemAudioEnabled, setSystemAudioEnabled] = useState(false);
	const [recordingAudioSources, setRecordingAudioSources] = useState<RecordingAudioSources>({
		systemAudioEnabled: false,
		microphoneEnabled: false,
	});
	const [recordingAudioLevels, setRecordingAudioLevels] = useState<RecordingAudioLevels>(
		SILENT_RECORDING_AUDIO_LEVELS,
	);
	const [webcamEnabled, setWebcamEnabled] = useState(false);
	const [webcamDeviceId, setWebcamDeviceId] = useState<string | undefined>(undefined);
	const [countdownDelay, setCountdownDelayState] = useState(3);
	const mediaRecorder = useRef<MediaRecorder | null>(null);
	const webcamRecorder = useRef<MediaRecorder | null>(null);
	const stream = useRef<MediaStream | null>(null);
	const screenStream = useRef<MediaStream | null>(null);
	const microphoneStream = useRef<MediaStream | null>(null);
	const webcamStream = useRef<MediaStream | null>(null);
	const mixingContext = useRef<AudioContext | null>(null);
	const audioLevelContext = useRef<AudioContext | null>(null);
	const audioLevelMonitorStream = useRef<MediaStream | null>(null);
	const audioMonitorLease = useRef(new RecorderResourceLease());
	const captureMutation = useRef<
		"starting" | "stopping" | "cancelling" | "pausing" | "resuming" | null
	>(null);
	const audioLevelAnimationFrame = useRef<number | null>(null);
	const audioLevelSourceKinds = useRef({ system: false, microphone: false });
	const chunks = useRef<Blob[]>([]);
	const webcamChunks = useRef<Blob[]>([]);
	const startTime = useRef<number>(0);
	const webcamStartTime = useRef<number | null>(null);
	const webcamTimeOffsetMs = useRef(0);
	const recordingSessionTimestamp = useRef<number | null>(null);
	const nativeScreenRecording = useRef(false);
	const nativeWindowsRecording = useRef(false);
	const startInFlight = useRef(false);
	const hasPromptedForReselect = useRef(false);
	const hasShownNativeWindowsFallbackToast = useRef(false);
	const countdownDelayLoaded = useRef(false);
	const recordingPrefsLoaded = useRef(false);
	const pendingWebcamPathPromise = useRef<Promise<string | null> | null>(null);
	const webcamStopPromise = useRef<Promise<string | null> | null>(null);
	const webcamStopResolver = useRef<((path: string | null) => void) | null>(null);
	const resolvedWebcamPath = useRef<string | null>(null);
	const accumulatedPausedDurationMs = useRef(0);
	const pauseStartedAtMs = useRef<number | null>(null);
	const micFallbackRecorder = useRef<MediaRecorder | null>(null);
	const micFallbackChunks = useRef<Blob[]>([]);
	const micFallbackStartDelayMs = useRef<number | null>(null);
	const micFallbackTrackSettings = useRef<MicrophoneTrackSettingsSnapshot | null>(null);
	const micFallbackRequestedConstraints = useRef<MediaStreamConstraints | null>(null);
	const micFallbackAudioInputDevices = useRef<MicrophoneAudioInputDeviceSnapshot[] | null>(null);
	const micFallbackRecorderMetadata = useRef<MicrophoneFallbackRecorderMetadata | null>(null);
	const micFallbackChunkEvents = useRef<MicrophoneFallbackChunkEvent[]>([]);
	const micFallbackRecorderStartedAt = useRef<number | null>(null);
	const micFallbackPauseStartedAt = useRef<number | null>(null);
	const micFallbackPausedDurationMs = useRef(0);
	const micFallbackPauseIntervals = useRef<MicrophoneFallbackPauseInterval[]>([]);
	const pendingBrowserMicSidecarBlobPromise = useRef<Promise<Blob | null> | null>(null);
	const browserMicrophoneProfile = useRef<BrowserMicrophoneProfile>(
		DEFAULT_BROWSER_MICROPHONE_PROFILE,
	);
	const requestedBrowserMicrophoneProfile = useRef<string | null>(null);
	const hideEditorOverlayCursorByDefault = useRef(false);
	const retainRecorderForAutomation = useRef(false);
	const finalizationLatch = useRef(new RecordingFinalizationLatch());
	const recordingWarnings = useRef<string[]>([]);
	const recordingStartError = useRef<string | null>(null);
	const activeNativePath = useRef<string | null>(null);
	const startCoordinator = useRef(new RecordingStartCoordinator());
	const assemblyInFlight = useRef(false);
	const finalizedVideoPath = useRef<string | null>(null);
	const recorderStateRef = useRef({ recording, paused, starting, countdownActive, finalizing });
	// Commit control state before resolving promises; React may render later.
	const setRecording = useCallback((value: boolean) => {
		commitRecorderControlState(recorderStateRef, "recording", value, setRecordingState);
	}, []);
	const setPaused = useCallback((value: boolean) => {
		commitRecorderControlState(recorderStateRef, "paused", value, setPausedState);
	}, []);
	const setStarting = useCallback((value: boolean) => {
		commitRecorderControlState(recorderStateRef, "starting", value, setStartingState);
	}, []);
	const setFinalizing = useCallback((value: boolean) => {
		commitRecorderControlState(recorderStateRef, "finalizing", value, setFinalizingState);
	}, []);
	const setCountdownActive = useCallback((value: boolean) => {
		commitRecorderControlState(
			recorderStateRef,
			"countdownActive",
			value,
			setCountdownActiveState,
		);
	}, []);
	const completeFinalization = useCallback(() => {
		assemblyInFlight.current = false;
		if (captureMutation.current === "stopping") captureMutation.current = null;
		setFinalizing(false);
		finalizationLatch.current.complete();
	}, [setFinalizing]);

	const logNativeCaptureDiagnostics = useCallback(async (context: string) => {
		if (typeof window.electronAPI?.getLastNativeCaptureDiagnostics !== "function") {
			return;
		}

		try {
			const result = await window.electronAPI.getLastNativeCaptureDiagnostics();
			if (result.success && result.diagnostics) {
				console.warn(`[NativeCaptureDiagnostics:${context}]`, result.diagnostics);
			}
		} catch (error) {
			console.warn("Failed to load native capture diagnostics:", error);
		}
	}, []);

	const buildNativeCaptureFailureMessage = useCallback(
		async (context: string, fallbackMessage: string) => {
			if (typeof window.electronAPI?.getLastNativeCaptureDiagnostics !== "function") {
				return fallbackMessage;
			}

			try {
				const result = await window.electronAPI.getLastNativeCaptureDiagnostics();
				const diagnostics = result.success ? (result.diagnostics ?? null) : null;
				if (!diagnostics) {
					return fallbackMessage;
				}

				console.warn(`[NativeCaptureDiagnostics:${context}]`, diagnostics);

				const details: string[] = [];
				if (diagnostics.error) {
					details.push(diagnostics.error);
				}
				if (diagnostics.outputPath) {
					details.push(`Saved file: ${diagnostics.outputPath}`);
				}

				return details.length > 0
					? `${fallbackMessage} ${details.join(". ")}`
					: fallbackMessage;
			} catch (error) {
				console.warn("Failed to load native capture diagnostics:", error);
				return fallbackMessage;
			}
		},
		[],
	);

	const resetRecordingClock = useCallback((startedAt: number) => {
		startTime.current = startedAt;
		accumulatedPausedDurationMs.current = 0;
		pauseStartedAtMs.current = null;
	}, []);

	const markRecordingPaused = useCallback((pausedAt: number) => {
		if (pauseStartedAtMs.current === null) {
			pauseStartedAtMs.current = pausedAt;
		}
	}, []);

	const markRecordingResumed = useCallback((resumedAt: number) => {
		if (pauseStartedAtMs.current === null) {
			return;
		}

		const pauseStart = pauseStartedAtMs.current;
		const pauseDurationMs = Math.max(0, resumedAt - pauseStart);
		accumulatedPausedDurationMs.current += pauseDurationMs;
		pauseStartedAtMs.current = null;
	}, []);

	const getRecordingDurationMs = useCallback((endedAt: number) => {
		return getEffectiveRecordingDurationMs({
			startTimeMs: startTime.current,
			endTimeMs: endedAt,
			accumulatedPausedDurationMs: accumulatedPausedDurationMs.current,
			pauseStartedAtMs: pauseStartedAtMs.current,
		});
	}, []);

	const getMicFallbackRecordedElapsedMs = useCallback((now = performance.now()) => {
		const startedAt = micFallbackRecorderStartedAt.current;
		if (startedAt === null) {
			return 0;
		}

		const currentPauseDurationMs =
			micFallbackPauseStartedAt.current === null
				? 0
				: Math.max(0, now - micFallbackPauseStartedAt.current);
		return Math.max(
			0,
			Math.round(
				now - startedAt - micFallbackPausedDurationMs.current - currentPauseDurationMs,
			),
		);
	}, []);

	const resetMicFallbackTimingDiagnostics = useCallback(() => {
		micFallbackChunkEvents.current = [];
		micFallbackRecorderStartedAt.current = null;
		micFallbackPauseStartedAt.current = null;
		micFallbackPausedDurationMs.current = 0;
		micFallbackPauseIntervals.current = [];
	}, []);

	const preparePermissions = useCallback(async (options: { startup?: boolean } = {}) => {
		const platform = await window.electronAPI.getPlatform();
		if (platform !== "darwin") {
			return true;
		}

		const accessibilityPermission = await window.electronAPI.getAccessibilityPermissionStatus();
		if (!accessibilityPermission.success) {
			return false;
		}

		if (accessibilityPermission.trusted) {
			return true;
		}

		const requestedAccessibility = await window.electronAPI.requestAccessibilityPermission();
		if (requestedAccessibility.success && requestedAccessibility.trusted) {
			return true;
		}

		await window.electronAPI.openAccessibilityPreferences();
		toast.error(tLaunch(options.startup ? "permissions.accessibilityNeeded" : "permissions.accessibilityMissing"), { duration: 12000 });

		return false;
	}, [tLaunch]);

	const selectMimeType = useCallback(() => {
		return selectRecordingMimeType();
	}, []);

	const selectWebcamMimeType = useCallback(() => {
		return selectWebcamRecordingMimeType();
	}, []);

	const computeBitrate = (width: number, height: number) => {
		const pixels = width * height;
		const highFrameRateBoost =
			TARGET_FRAME_RATE >= HIGH_FRAME_RATE_THRESHOLD ? HIGH_FRAME_RATE_BOOST : 1;

		if (pixels >= FOUR_K_PIXELS) {
			return Math.round(BITRATE_4K * highFrameRateBoost);
		}

		if (pixels >= QHD_PIXELS) {
			return Math.round(BITRATE_QHD * highFrameRateBoost);
		}

		return Math.round(BITRATE_BASE * highFrameRateBoost);
	};

	const stopAudioLevelMonitor = useCallback(() => {
		audioMonitorLease.current.invalidate();
		if (audioLevelAnimationFrame.current !== null) {
			cancelAnimationFrame(audioLevelAnimationFrame.current);
			audioLevelAnimationFrame.current = null;
		}

		if (audioLevelContext.current) {
			audioLevelContext.current.close().catch(() => undefined);
			audioLevelContext.current = null;
		}

		if (audioLevelMonitorStream.current) {
			audioLevelMonitorStream.current.getTracks().forEach((track) => track.stop());
			audioLevelMonitorStream.current = null;
		}

		audioLevelSourceKinds.current = { system: false, microphone: false };
		setRecordingAudioLevels(SILENT_RECORDING_AUDIO_LEVELS);
	}, []);

	const notifyRecordingFinalizationFailure = useCallback(
		async (message: string) => {
			stopAudioLevelMonitor();
			if (captureMutation.current === "stopping") captureMutation.current = null;
			assemblyInFlight.current = false;
			setFinalizing(false);
			finalizationLatch.current.fail(new AutomationError("FINALIZATION_FAILED", message));
			toast.error(message, { duration: 10000 });
		},
		[stopAudioLevelMonitor, setFinalizing],
	);

	const startAudioLevelMonitor = useCallback(
		(
			mediaStream: MediaStream,
			sources: { system: boolean; microphone: boolean },
			ownStream = false,
		) => {
			const audioTracks = mediaStream.getAudioTracks();
			if (audioTracks.length === 0) {
				if (ownStream) {
					mediaStream.getTracks().forEach((track) => track.stop());
				}
				stopAudioLevelMonitor();
				return;
			}

			stopAudioLevelMonitor();
			audioLevelSourceKinds.current = sources;
			if (ownStream) {
				audioLevelMonitorStream.current = mediaStream;
			}

			try {
				const context = new AudioContext({ sampleRate: 48000 });
				audioLevelContext.current = context;
				const analyser = context.createAnalyser();
				analyser.fftSize = 256;
				analyser.smoothingTimeConstant = 0.72;
				context.createMediaStreamSource(new MediaStream(audioTracks)).connect(analyser);
				const samples = new Uint8Array(analyser.frequencyBinCount);

				const updateLevel = () => {
					analyser.getByteFrequencyData(samples);
					let sum = 0;
					for (const sample of samples) {
						sum += sample * sample;
					}
					const rms = Math.sqrt(sum / samples.length);
					const level = Math.min(100, Math.round((rms / 255) * 180));
					const activeSources = audioLevelSourceKinds.current;
					setRecordingAudioLevels((current) => ({
						system: activeSources.system ? level : current.system,
						microphone: activeSources.microphone ? level : current.microphone,
						mixed:
							activeSources.system && activeSources.microphone
								? level
								: current.mixed,
					}));
					audioLevelAnimationFrame.current = requestAnimationFrame(updateLevel);
				};

				void context.resume().catch(() => undefined);
				updateLevel();
			} catch (error) {
				console.warn("Failed to start recording audio level monitor:", error);
				setRecordingAudioLevels(SILENT_RECORDING_AUDIO_LEVELS);
			}
		},
		[stopAudioLevelMonitor],
	);

	const startMicrophoneLevelMonitor = useCallback(
		async (deviceId?: string) => {
			try {
				await audioMonitorLease.current.acquire(
					() =>
						navigator.mediaDevices.getUserMedia(
							createProcessedMicrophoneConstraints(
								deviceId,
								browserMicrophoneProfile.current,
							),
						),
					(monitorStream) => monitorStream.getTracks().forEach((track) => track.stop()),
					(monitorStream) =>
						startAudioLevelMonitor(
							monitorStream,
							{ system: false, microphone: true },
							true,
						),
				);
			} catch (error) {
				console.warn("Failed to start microphone level monitor:", error);
			}
		},
		[startAudioLevelMonitor],
	);

	const cleanupCapturedMedia = useCallback(() => {
		stopAudioLevelMonitor();

		if (stream.current) {
			stream.current.getTracks().forEach((track) => track.stop());
			stream.current = null;
		}

		if (screenStream.current) {
			screenStream.current.getTracks().forEach((track) => track.stop());
			screenStream.current = null;
		}

		if (microphoneStream.current) {
			microphoneStream.current.getTracks().forEach((track) => track.stop());
			microphoneStream.current = null;
		}

		if (webcamStream.current) {
			webcamStream.current.getTracks().forEach((track) => track.stop());
			webcamStream.current = null;
		}

		if (mixingContext.current) {
			mixingContext.current.close().catch(() => undefined);
			mixingContext.current = null;
		}

		if (micFallbackRecorder.current) {
			try {
				if (micFallbackRecorder.current.state !== "inactive") {
					micFallbackRecorder.current.stop();
				}
				micFallbackRecorder.current.stream?.getTracks().forEach((track) => track.stop());
			} catch {
				/* ignore */
			}
			micFallbackRecorder.current = null;
			micFallbackChunks.current = [];
			micFallbackTrackSettings.current = null;
			micFallbackRequestedConstraints.current = null;
			micFallbackAudioInputDevices.current = null;
			micFallbackRecorderMetadata.current = null;
			resetMicFallbackTimingDiagnostics();
		}
		pendingBrowserMicSidecarBlobPromise.current = null;
	}, [resetMicFallbackTimingDiagnostics, stopAudioLevelMonitor]);

	const appendMicFallbackChunk = useCallback(
		(event: BlobEvent) => {
			if (event.data.size <= 0) {
				return;
			}

			micFallbackChunks.current.push(event.data);
			const startedAt = micFallbackRecorderStartedAt.current;
			if (startedAt === null) {
				return;
			}

			const now = performance.now();
			const elapsedMs = Math.max(0, Math.round(now - startedAt));
			const recordedElapsedMs = getMicFallbackRecordedElapsedMs(now);
			const previous =
				micFallbackChunkEvents.current[micFallbackChunkEvents.current.length - 1];
			micFallbackChunkEvents.current.push({
				index: micFallbackChunkEvents.current.length,
				size: event.data.size,
				elapsedMs,
				deltaMs: previous ? Math.max(0, elapsedMs - previous.elapsedMs) : null,
				recordedElapsedMs,
				recordedDeltaMs: previous
					? Math.max(0, recordedElapsedMs - previous.recordedElapsedMs)
					: null,
			});
		},
		[getMicFallbackRecordedElapsedMs],
	);

	const resolveBrowserCaptureSource = useCallback(async (source: ProcessedDesktopSource) => {
		if (!source?.id?.startsWith("screen:")) {
			return source;
		}

		// Linux/Wayland portal sentinel: do NOT call getSources here, because
		// on Wayland that triggers an additional xdg-desktop-portal dialog.
		// The sentinel is handled later by routing through getDisplayMedia,
		// which lets the portal pick the source in a single dialog.
		if (source.id === "screen:linux-portal") {
			return source;
		}

		try {
			const liveSources = await window.electronAPI.getSources({
				types: ["screen"],
				thumbnailSize: { width: 1, height: 1 },
				fetchWindowIcons: false,
			});

			const exactMatch = liveSources.find((candidate) => candidate.id === source.id);
			if (exactMatch) {
				return {
					...source,
					id: exactMatch.id,
					name: exactMatch.name ?? source.name,
					display_id: exactMatch.display_id ?? source.display_id,
				};
			}

			const displayMatch = liveSources.find(
				(candidate) =>
					String(candidate.display_id ?? "") === String(source.display_id ?? ""),
			);
			if (displayMatch) {
				return {
					...source,
					id: displayMatch.id,
					name: displayMatch.name ?? source.name,
					display_id: displayMatch.display_id ?? source.display_id,
				};
			}
		} catch (error) {
			console.warn("Failed to resolve browser capture source:", error);
		}

		return source;
	}, []);

	const finalizeRecordingSession = useCallback(
		async (
			videoPath: string,
			webcamPath: string | null,
			assetStatus: "assembling" | "ready" | "degraded" = "ready",
		) => {
			const start = performance.now();
			console.log("[PERF:RENDERER] Finalize Session & Switch to Editor: STARTED");
			finalizedVideoPath.current = videoPath;
			const shouldHideOverlayCursor = hideEditorOverlayCursorByDefault.current;
			try {
				await window.electronAPI.setCurrentRecordingSession({
					videoPath,
					webcamPath,
					timeOffsetMs: webcamTimeOffsetMs.current,
					hideOverlayCursorByDefault: shouldHideOverlayCursor,
					assetStatus,
					assetMessage: null,
				});
			} catch (error) {
				console.error("Failed to persist recording session metadata:", error);

				try {
					await window.electronAPI.setCurrentVideoPath(videoPath, {
						hideOverlayCursorByDefault: shouldHideOverlayCursor,
					});
				} catch (fallbackError) {
					console.error("Failed to persist fallback video path:", fallbackError);
				}
			}

			if (!retainRecorderForAutomation.current) setFinalizing(false);
			await window.electronAPI.switchToEditor();
			console.log(
				`[PERF:RENDERER] Finalize Session & Switch to Editor: COMPLETED in ${(performance.now() - start).toFixed(2)}ms`,
			);
		},
		[setFinalizing],
	);

	const closeMicFallbackPauseInterval = useCallback((now = performance.now()) => {
		const pauseStartedAt = micFallbackPauseStartedAt.current;
		if (pauseStartedAt === null) {
			return;
		}

		const durationMs = Math.max(0, Math.round(now - pauseStartedAt));
		micFallbackPausedDurationMs.current += durationMs;
		const startedAt = micFallbackRecorderStartedAt.current ?? now;
		const lastInterval =
			micFallbackPauseIntervals.current[micFallbackPauseIntervals.current.length - 1];
		if (lastInterval && lastInterval.endElapsedMs === undefined) {
			lastInterval.endElapsedMs = Math.max(
				lastInterval.startElapsedMs,
				Math.round(now - startedAt),
			);
			lastInterval.durationMs = durationMs;
		}
		micFallbackPauseStartedAt.current = null;
	}, []);

	const stopMicFallbackRecorder = useCallback((): Promise<Blob | null> => {
		return new Promise((resolve) => {
			const recorder = micFallbackRecorder.current;
			if (!recorder || recorder.state === "inactive") {
				micFallbackRecorder.current = null;
				resolve(null);
				return;
			}
			closeMicFallbackPauseInterval();
			recorder.ondataavailable = appendMicFallbackChunk;
			recorder.onstop = () => {
				const blob =
					micFallbackChunks.current.length > 0
						? new Blob(micFallbackChunks.current, { type: recorder.mimeType })
						: null;
				micFallbackChunks.current = [];
				recorder.stream.getTracks().forEach((track) => track.stop());
				micFallbackRecorder.current = null;
				micFallbackRecorderStartedAt.current = null;
				resolve(blob);
			};
			recorder.stop();
		});
	}, [appendMicFallbackChunk, closeMicFallbackPauseInterval]);

	const pauseMicFallbackRecorder = useCallback(() => {
		const recorder = micFallbackRecorder.current;
		if (recorder?.state !== "recording") {
			return;
		}

		try {
			recorder.requestData();
		} catch (error) {
			console.warn("Failed to flush microphone fallback chunk before pause:", error);
		}

		recorder.pause();
		const now = performance.now();
		const startedAt = micFallbackRecorderStartedAt.current ?? now;
		micFallbackPauseStartedAt.current = now;
		micFallbackPauseIntervals.current.push({
			startElapsedMs: Math.max(0, Math.round(now - startedAt)),
		});
	}, []);

	const resumeMicFallbackRecorder = useCallback(() => {
		const recorder = micFallbackRecorder.current;
		if (recorder?.state !== "paused") {
			return;
		}

		closeMicFallbackPauseInterval();
		recorder.resume();
	}, [closeMicFallbackPauseInterval]);

	const startMicrophoneSidecarRecorder = useCallback(
		async (micStream: MediaStream, mainStartedAt: number) => {
			micFallbackTrackSettings.current = createMicrophoneTrackSettingsSnapshot(micStream);
			micFallbackAudioInputDevices.current = await createAudioInputDeviceSnapshot().catch(
				() => null,
			);
			console.info("Browser microphone track settings:", micFallbackTrackSettings.current);
			console.info(
				"Browser microphone audio input devices:",
				micFallbackAudioInputDevices.current,
			);

			micFallbackChunks.current = [];
			const recorder = new MediaRecorder(micStream, {
				mimeType: "audio/webm;codecs=opus",
				audioBitsPerSecond: AUDIO_BITRATE_VOICE,
			});
			micFallbackRecorderMetadata.current = {
				mimeType: recorder.mimeType,
				audioBitsPerSecond: AUDIO_BITRATE_VOICE,
				timesliceMs: RECORDER_TIMESLICE_MS,
			};
			resetMicFallbackTimingDiagnostics();
			micFallbackRecorderStartedAt.current = performance.now();
			recorder.ondataavailable = appendMicFallbackChunk;
			micFallbackStartDelayMs.current = Math.max(0, Date.now() - mainStartedAt);
			recorder.start(RECORDER_TIMESLICE_MS);
			micFallbackRecorder.current = recorder;
		},
		[appendMicFallbackChunk, resetMicFallbackTimingDiagnostics],
	);

	const storeMicrophoneSidecar = useCallback(
		async (
			micFallbackBlobPromise: Promise<Blob | null> | null | undefined,
			finalPath: string,
			startDelayMs?: number | null,
			mediaTrackSettings?: MicrophoneTrackSettingsSnapshot | null,
		) => {
			const micFallbackBlob = await micFallbackBlobPromise;
			if (!micFallbackBlob) {
				micFallbackStartDelayMs.current = null;
				micFallbackTrackSettings.current = null;
				micFallbackRequestedConstraints.current = null;
				micFallbackAudioInputDevices.current = null;
				micFallbackRecorderMetadata.current = null;
				resetMicFallbackTimingDiagnostics();
				return;
			}

			try {
				const arrayBuffer = await micFallbackBlob.arrayBuffer();
				const effectiveStartDelayMs = startDelayMs ?? micFallbackStartDelayMs.current;
				const effectiveTrackSettings =
					mediaTrackSettings ?? micFallbackTrackSettings.current;
				const sidecarOptions: MicrophoneSidecarOptions = {
					...(Number.isFinite(effectiveStartDelayMs) && (effectiveStartDelayMs ?? 0) >= 0
						? { startDelayMs: effectiveStartDelayMs ?? 0 }
						: {}),
					browserMicrophoneProfile: browserMicrophoneProfile.current,
					...(requestedBrowserMicrophoneProfile.current
						? {
								requestedBrowserMicrophoneProfile:
									requestedBrowserMicrophoneProfile.current,
							}
						: {}),
					...(micFallbackRequestedConstraints.current
						? { requestedConstraints: micFallbackRequestedConstraints.current }
						: {}),
					...(effectiveTrackSettings
						? { mediaTrackSettings: effectiveTrackSettings }
						: {}),
					...(micFallbackAudioInputDevices.current
						? { audioInputDevices: micFallbackAudioInputDevices.current }
						: {}),
					...(micFallbackRecorderMetadata.current
						? { mediaRecorder: micFallbackRecorderMetadata.current }
						: {}),
					...(micFallbackChunkEvents.current.length > 0
						? { chunkEvents: [...micFallbackChunkEvents.current] }
						: {}),
					...(micFallbackPauseIntervals.current.length > 0
						? {
								pauseIntervals: micFallbackPauseIntervals.current.map(
									(interval) => ({ ...interval }),
								),
							}
						: {}),
				};
				const result = await window.electronAPI.storeMicrophoneSidecar(
					arrayBuffer,
					finalPath,
					sidecarOptions,
				);
				if (!result.success) {
					const errorMessage =
						result.error || "Failed to save the fallback microphone audio track";
					recordingWarnings.current.push(errorMessage);
					console.warn("Failed to store microphone sidecar:", errorMessage);
					toast.error(
						`${errorMessage}. Recording was saved without the fallback microphone track.`,
						{ id: MICROPHONE_SIDECAR_ERROR_TOAST_ID, duration: 10000 },
					);
				}
			} catch (error) {
				recordingWarnings.current.push(
					`Microphone sidecar unavailable: ${getErrorMessage(error)}`,
				);
				console.warn("Failed to store microphone sidecar:", error);
				toast.error(
					`${getErrorMessage(error)}. Recording was saved without the fallback microphone track.`,
					{ id: MICROPHONE_SIDECAR_ERROR_TOAST_ID, duration: 10000 },
				);
			} finally {
				micFallbackStartDelayMs.current = null;
				micFallbackTrackSettings.current = null;
				micFallbackRequestedConstraints.current = null;
				micFallbackAudioInputDevices.current = null;
				micFallbackRecorderMetadata.current = null;
				resetMicFallbackTimingDiagnostics();
			}
		},
		[resetMicFallbackTimingDiagnostics],
	);

	const stopWebcamRecorder = useCallback(async () => {
		const recorder = webcamRecorder.current;
		const pending = webcamStopPromise.current;

		if (!recorder) {
			const result = pending ? await pending : resolvedWebcamPath.current;
			webcamStopPromise.current = null;
			pendingWebcamPathPromise.current = null;
			resolvedWebcamPath.current = result ?? null;
			return result ?? null;
		}

		if (recorder.state !== "inactive") {
			recorder.stop();
		} else if (pending && webcamStopResolver.current) {
			webcamStopResolver.current(resolvedWebcamPath.current);
			webcamStopResolver.current = null;
		}

		const result = pending ? await pending : resolvedWebcamPath.current;
		webcamStopPromise.current = null;
		pendingWebcamPathPromise.current = null;
		resolvedWebcamPath.current = result ?? null;
		return result ?? null;
	}, []);

	const recoverNativeRecordingSession = useCallback(
		async (
			micFallbackBlobPromise?: Promise<Blob | null> | null,
			startDelayMs?: number | null,
		) => {
			stopAudioLevelMonitor();
			if (typeof window.electronAPI?.recoverNativeScreenRecording !== "function") {
				return null;
			}

			const result = await window.electronAPI.recoverNativeScreenRecording();
			if (!result.success || !result.path) {
				return null;
			}

			const resolvedMicFallbackBlobPromise =
				micFallbackBlobPromise ?? stopMicFallbackRecorder();
			const webcamPath = await stopWebcamRecorder();
			await storeMicrophoneSidecar(resolvedMicFallbackBlobPromise, result.path, startDelayMs);
			await finalizeRecordingSession(
				result.path,
				webcamPath,
				recordingWarnings.current.length ? "degraded" : "ready",
			);
			completeFinalization();

			if (
				!retainRecorderForAutomation.current &&
				typeof window.electronAPI?.hudOverlayClose === "function"
			) {
				window.electronAPI.hudOverlayClose();
			}

			return result.path;
		},
		[
			finalizeRecordingSession,
			completeFinalization,
			stopAudioLevelMonitor,
			stopMicFallbackRecorder,
			stopWebcamRecorder,
			storeMicrophoneSidecar,
		],
	);

	/**
	 * Acquire the webcam stream and prepare the MediaRecorder, but do NOT start
	 * recording yet. Call {@link beginWebcamCapture} after the main recording
	 * has started so both begin at approximately the same time.
	 */
	const prepareWebcamRecorder = useCallback(async () => {
		if (!webcamEnabled) {
			resolvedWebcamPath.current = null;
			pendingWebcamPathPromise.current = Promise.resolve(null);
			webcamStartTime.current = null;
			webcamTimeOffsetMs.current = 0;
			return;
		}

		try {
			webcamStream.current = await navigator.mediaDevices.getUserMedia({
				video: webcamDeviceId
					? {
							deviceId: { exact: webcamDeviceId },
							width: { ideal: WEBCAM_WIDTH },
							height: { ideal: WEBCAM_HEIGHT },
							frameRate: { ideal: WEBCAM_FRAME_RATE, max: WEBCAM_FRAME_RATE },
						}
					: {
							width: { ideal: WEBCAM_WIDTH },
							height: { ideal: WEBCAM_HEIGHT },
							frameRate: { ideal: WEBCAM_FRAME_RATE, max: WEBCAM_FRAME_RATE },
						},
				audio: false,
			});

			const mimeType = selectWebcamMimeType();
			webcamChunks.current = [];
			resolvedWebcamPath.current = null;
			webcamStopPromise.current = new Promise((resolve) => {
				webcamStopResolver.current = resolve;
			});
			pendingWebcamPathPromise.current = webcamStopPromise.current;

			const recorder = new MediaRecorder(webcamStream.current, {
				videoBitsPerSecond: WEBCAM_BITRATE,
				...(mimeType ? { mimeType } : {}),
			});

			webcamRecorder.current = recorder;
			recorder.ondataavailable = (event) => {
				if (event.data && event.data.size > 0) {
					webcamChunks.current.push(event.data);
				}
			};
			recorder.onerror = () => {
				webcamStopResolver.current?.(null);
				webcamStopResolver.current = null;
			};
			recorder.onstop = async () => {
				const sessionTimestamp = recordingSessionTimestamp.current ?? Date.now();
				const webcamMimeType = recorder.mimeType || mimeType;
				const webcamFileName = `${RECORDING_FILE_PREFIX}${sessionTimestamp}${WEBCAM_SUFFIX}${getVideoExtensionForMimeType(webcamMimeType)}`;

				try {
					if (webcamChunks.current.length === 0) {
						webcamStopResolver.current?.(null);
						return;
					}

					const duration = Math.max(
						0,
						getRecordingDurationMs(Date.now()) - webcamTimeOffsetMs.current,
					);
					const webcamBlob = new Blob(
						webcamChunks.current,
						webcamMimeType ? { type: webcamMimeType } : undefined,
					);
					webcamChunks.current = [];
					const finalBlob = isWebmMimeType(webcamMimeType)
						? await fixWebmDuration(webcamBlob, duration)
						: webcamBlob;
					const arrayBuffer = await finalBlob.arrayBuffer();
					const result = await window.electronAPI.storeRecordedVideo(
						arrayBuffer,
						webcamFileName,
					);
					if (!result.success)
						recordingWarnings.current.push(
							result.message || "Webcam footage could not be saved.",
						);
					webcamStopResolver.current?.(result.success ? (result.path ?? null) : null);
				} catch (error) {
					recordingWarnings.current.push(
						`Webcam footage unavailable: ${getErrorMessage(error)}`,
					);
					console.error("Error saving webcam recording:", error);
					webcamStopResolver.current?.(null);
				} finally {
					webcamStopResolver.current = null;
					webcamRecorder.current = null;
					webcamStartTime.current = null;
					if (webcamStream.current) {
						webcamStream.current.getTracks().forEach((track) => track.stop());
						webcamStream.current = null;
					}
				}
			};
		} catch (error) {
			recordingWarnings.current.push(`Webcam unavailable: ${getErrorMessage(error)}`);
			console.warn(
				"Failed to start webcam recording; continuing without webcam layer:",
				error,
			);
			resolvedWebcamPath.current = null;
			pendingWebcamPathPromise.current = Promise.resolve(null);
			webcamStopPromise.current = Promise.resolve(null);
			webcamRecorder.current = null;
			webcamStartTime.current = null;
			webcamTimeOffsetMs.current = 0;
			if (webcamStream.current) {
				webcamStream.current.getTracks().forEach((track) => track.stop());
				webcamStream.current = null;
			}
		}
	}, [getRecordingDurationMs, selectWebcamMimeType, webcamDeviceId, webcamEnabled]);

	/** Start the prepared webcam MediaRecorder. Call after main recording begins. */
	const beginWebcamCapture = useCallback(() => {
		const recorder = webcamRecorder.current;
		if (recorder && recorder.state === "inactive") {
			webcamStartTime.current = Date.now();
			try {
				recorder.start(RECORDER_TIMESLICE_MS);
			} catch (error) {
				recordingWarnings.current.push(
					`Webcam capture unavailable: ${getErrorMessage(error)}`,
				);
				webcamStream.current?.getTracks().forEach((track) => track.stop());
				webcamStream.current = null;
				webcamRecorder.current = null;
				webcamStopResolver.current?.(null);
				webcamStopResolver.current = null;
				webcamStopPromise.current = Promise.resolve(null);
				pendingWebcamPathPromise.current = Promise.resolve(null);
			}
		}
	}, []);

	const stopRecording = useRef(() => {
		if (!claimRecorderMutation(captureMutation, "stopping")) return false;
		stopAudioLevelMonitor();
		assemblyInFlight.current = true;
		setPaused(false);
		if (nativeScreenRecording.current) {
			nativeScreenRecording.current = false;
			setRecording(false);
			setRecordingAudioLevels(SILENT_RECORDING_AUDIO_LEVELS);
			setFinalizing(true);

			void (async () => {
				const stopStart = performance.now();
				console.log("[PERF:RENDERER] Total Stop Sequence: STARTED");

				const fallbackStartDelayMs = micFallbackStartDelayMs.current;
				const fallbackTrackSettings = micFallbackTrackSettings.current;
				const stoppedAtMs = Date.now();
				markRecordingResumed(stoppedAtMs);
				const expectedDurationMs = getRecordingDurationMs(stoppedAtMs);
				const micFallbackBlobPromise = stopMicFallbackRecorder();
				const webcamPathPromise = stopWebcamRecorder();
				const isNativeWindows = nativeWindowsRecording.current;
				nativeWindowsRecording.current = false;

				const ipcStopStart = performance.now();
				console.log("[PERF:RENDERER] IPC: stopNativeScreenRecording: STARTED");
				const result = await window.electronAPI.stopNativeScreenRecording();
				console.log(
					`[PERF:RENDERER] IPC: stopNativeScreenRecording: COMPLETED in ${(performance.now() - ipcStopStart).toFixed(2)}ms`,
				);

				await window.electronAPI?.setRecordingState(false);

				if (!result.success || !result.path) {
					console.error(
						"Failed to stop native screen recording:",
						result.error ?? result.message,
					);
					void logNativeCaptureDiagnostics("stop-native-screen-recording");
					try {
						const recoveredPath = await recoverNativeRecordingSession(
							micFallbackBlobPromise,
							fallbackStartDelayMs,
						);
						if (recoveredPath) {
							console.log(
								`[PERF:RENDERER] Total Stop Sequence (RECOVERED) in ${(performance.now() - stopStart).toFixed(2)}ms`,
							);
							return;
						}
					} catch (recoveryError) {
						console.error("Failed to recover native screen recording:", recoveryError);
					}

					const failureMessage = await buildNativeCaptureFailureMessage(
						"stop-native-screen-recording",
						isMacOS
							? "Failed to finish the macOS recording, so the editor was not opened."
							: "Failed to finish the recording, so the editor was not opened.",
					);
					await notifyRecordingFinalizationFailure(failureMessage);
					return;
				}

				const finalPath = result.path;

				// 1. Finalize the session and switch to editor immediately (Optimistic UI)
				// We pass null for webcamPath initially to avoid blocking on webcam disk writes/muxing.
				await finalizeRecordingSession(finalPath, null, "assembling");

				// 2. Perform background finalization (webcam, muxing, sidecars)
				// We don't await this to keep the UI responsive
				void (async () => {
					try {
						// Await the webcam path in the background
						const webcamPath = await webcamPathPromise;
						console.log(
							"[useScreenRecorder] Background native processing: webcamPath is",
							webcamPath,
						);

						// Store sidecars
						await storeMicrophoneSidecar(
							micFallbackBlobPromise,
							finalPath,
							fallbackStartDelayMs,
							fallbackTrackSettings,
						);

						// Perform muxing/renaming if on Windows
						if (isNativeWindows) {
							await window.electronAPI.muxNativeWindowsRecording(expectedDurationMs);
						}

						console.log(
							"[useScreenRecorder] Emitting setCurrentRecordingSession with:",
							{ finalPath, webcamPath },
						);

						// Update the session state to notify the editor that all background assets (webcam, mic, etc.) are now ready.
						// This broadcasts a 'recording-session-changed' event that the open editor listens to for re-scanning assets.
						await window.electronAPI.setCurrentRecordingSession({
							videoPath: finalPath,
							webcamPath,
							timeOffsetMs: webcamTimeOffsetMs.current,
							hideOverlayCursorByDefault: hideEditorOverlayCursorByDefault.current,
							assetStatus: recordingWarnings.current.length ? "degraded" : "ready",
							assetMessage: recordingWarnings.current.length
								? recordingWarnings.current.join("; ")
								: null,
						});

						console.log(
							`[PERF:RENDERER] Background Stop Sequence: COMPLETED in ${(performance.now() - stopStart).toFixed(2)}ms`,
						);
					} catch (bgError) {
						console.error("Error in background finalization:", bgError);
						await window.electronAPI.setCurrentRecordingSession({
							videoPath: finalPath,
							webcamPath: null,
							timeOffsetMs: webcamTimeOffsetMs.current,
							hideOverlayCursorByDefault: hideEditorOverlayCursorByDefault.current,
							assetStatus: "degraded",
							assetMessage:
								bgError instanceof Error
									? bgError.message
									: "Some recording assets could not be finalized.",
						});
					} finally {
						completeFinalization();
						// After all background tasks are done (webcam, mic sidecars, muxing),
						// we can safely close the HUD window to release hardware and resources.
						if (
							!retainRecorderForAutomation.current &&
							typeof window.electronAPI?.hudOverlayClose === "function"
						) {
							console.log(
								"[useScreenRecorder] All background tasks finished, closing HUD",
							);
							window.electronAPI.hudOverlayClose();
						}
					}
				})();
			})().catch(async (error) => {
				await notifyRecordingFinalizationFailure(getErrorMessage(error));
			});
			return true;
		}

		const recorder = mediaRecorder.current;
		const recorderState = recorder?.state;
		if (recorder && (recorderState === "recording" || recorderState === "paused")) {
			if (recorderState === "paused") {
				try {
					recorder.resume();
					markRecordingResumed(Date.now());
				} catch (error) {
					console.warn("Failed to resume recorder before stopping:", error);
				}
			}
			pendingWebcamPathPromise.current = stopWebcamRecorder();
			pendingBrowserMicSidecarBlobPromise.current = stopMicFallbackRecorder();
			try {
				recorder.requestData();
			} catch (error) {
				console.warn("Failed to flush recorder before stopping:", error);
			}
			recorder.stop();
			setRecording(false);
			setFinalizing(true);
			window.electronAPI?.setRecordingState(false);
			return true;
		}
		captureMutation.current = null;
		assemblyInFlight.current = false;
		return false;
	});

	useEffect(() => {
		void (async () => {
			const platform = await window.electronAPI.getPlatform();
			setIsMacOS(platform === "darwin");
		})();
	}, []);

	useEffect(() => {
		if (typeof window.electronAPI?.getRecordingAudioLabConfig !== "function") {
			return;
		}

		void (async () => {
			const result = await window.electronAPI.getRecordingAudioLabConfig();
			browserMicrophoneProfile.current = normalizeBrowserMicrophoneProfile(
				result.browserMicrophoneProfile,
			);
			requestedBrowserMicrophoneProfile.current =
				result.requestedBrowserMicrophoneProfile ?? null;
			console.info("Browser microphone profile:", browserMicrophoneProfile.current);
		})();
	}, []);

	useEffect(() => {
		if (countdownDelayLoaded.current) return;
		countdownDelayLoaded.current = true;

		void (async () => {
			try {
				const result = await window.electronAPI.getCountdownDelay();
				if (result.success && typeof result.delay === "number")
					setCountdownDelayState(result.delay);
			} catch (error) {
				recordingWarnings.current.push(
					`Countdown preferences unavailable: ${getErrorMessage(error)}`,
				);
			} finally {
				setCountdownReady(true);
			}
		})();
	}, []);

	const setCountdownDelay = useCallback((delay: number) => {
		setCountdownDelayState(delay);
		void window.electronAPI.setCountdownDelay(delay);
	}, []);

	useEffect(() => {
		if (recordingPrefsLoaded.current) return;
		recordingPrefsLoaded.current = true;

		void (async () => {
			try {
				const result = await window.electronAPI.getRecordingPreferences();
				if (result.success) {
					setMicrophoneEnabled(result.microphoneEnabled);
					if (result.microphoneDeviceId) {
						setMicrophoneDeviceId(result.microphoneDeviceId);
					}
					setSystemAudioEnabled(result.systemAudioEnabled);
				}
			} catch (error) {
				recordingWarnings.current.push(
					`Recording preferences unavailable: ${getErrorMessage(error)}`,
				);
			} finally {
				setPreferencesReady(true);
			}
		})();
	}, []);

	const persistMicrophoneEnabled = useCallback((enabled: boolean) => {
		setMicrophoneEnabled(enabled);
		void window.electronAPI.setRecordingPreferences({ microphoneEnabled: enabled });
	}, []);

	const persistMicrophoneDeviceId = useCallback((deviceId: string | undefined) => {
		setMicrophoneDeviceId(deviceId);
		void window.electronAPI.setRecordingPreferences({ microphoneDeviceId: deviceId });
	}, []);

	const persistSystemAudioEnabled = useCallback((enabled: boolean) => {
		setSystemAudioEnabled(enabled);
		void window.electronAPI.setRecordingPreferences({ systemAudioEnabled: enabled });
	}, []);

	useEffect(() => {
		let cleanup: (() => void) | undefined;

		if (window.electronAPI?.onStopRecordingFromTray) {
			cleanup = window.electronAPI.onStopRecordingFromTray(() => {
				stopRecording.current();
			});
		}

		const removeRecordingStateListener = window.electronAPI?.onRecordingStateChanged?.(
			(state) => {
				setRecording(state.recording);
				if (!state.recording) {
					setRecordingAudioSources({
						systemAudioEnabled: false,
						microphoneEnabled: false,
					});
					setRecordingAudioLevels(SILENT_RECORDING_AUDIO_LEVELS);
				}
			},
		);

		const removeRecordingAudioLevelsListener = window.electronAPI?.onRecordingAudioLevels?.(
			(levels) => {
				setRecordingAudioLevels((current) => ({
					system:
						typeof levels.system === "number"
							? Math.max(0, Math.min(100, levels.system))
							: current.system,
					microphone:
						typeof levels.microphone === "number"
							? Math.max(0, Math.min(100, levels.microphone))
							: current.microphone,
					mixed:
						typeof levels.mixed === "number"
							? Math.max(0, Math.min(100, levels.mixed))
							: current.mixed,
				}));
			},
		);

		const removeRecordingInterruptedListener = window.electronAPI?.onRecordingInterrupted?.(
			(state) => {
				if (
					captureMutation.current === "stopping" ||
					captureMutation.current === "cancelling"
				)
					return;
				void (async () => {
					setRecording(false);
					nativeScreenRecording.current = false;
					cleanupCapturedMedia();
					await window.electronAPI.setRecordingState(false);

					if (state.reason !== "window-unavailable") {
						try {
							const recoveredPath = await recoverNativeRecordingSession();
							if (recoveredPath) {
								return;
							}
						} catch (recoveryError) {
							console.error(
								"Failed to recover interrupted native screen recording:",
								recoveryError,
							);
						}
					}

					if (state.reason === "window-unavailable" && !hasPromptedForReselect.current) {
						hasPromptedForReselect.current = true;
						toast.error(state.message, { duration: 12000 });
						await window.electronAPI.openSourceSelector();
					} else {
						console.error(state.message);
						toast.error(state.message);
					}
				})();
			},
		);

		return () => {
			cleanup?.();
			removeRecordingStateListener?.();
			removeRecordingAudioLevelsListener?.();
			removeRecordingInterruptedListener?.();

			if (nativeScreenRecording.current) {
				nativeScreenRecording.current = false;
				void window.electronAPI.stopNativeScreenRecording();
			}

			const recorder = mediaRecorder.current;
			const recorderState = recorder?.state;
			if (recorder && (recorderState === "recording" || recorderState === "paused")) {
				recorder.stop();
			}

			cleanupCapturedMedia();
		};
	}, [cleanupCapturedMedia, recoverNativeRecordingSession, setRecording]);

	const startRecording = async () => {
		if (startInFlight.current || captureMutation.current) {
			return;
		}

		hasPromptedForReselect.current = false;
		startInFlight.current = true;
		captureMutation.current = "starting";
		setStarting(true);

		try {
			const platform = await window.electronAPI.getPlatform();
			hideEditorOverlayCursorByDefault.current = false;
			const existingSource = await window.electronAPI.getSelectedSource();
			const selectedSource =
				existingSource ?? (platform === "linux" ? LINUX_PORTAL_SOURCE : null);
			if (!selectedSource) {
				recordingStartError.current = "Select a capture source before recording.";
				toast.error(tLaunch("permissions.selectSource"));
				return;
			}
			// Persist the synthetic Linux portal sentinel to main so that the
			// setDisplayMediaRequestHandler can short-circuit getSources() and
			// avoid triggering an extra portal dialog.
			if (!existingSource && selectedSource.id === "screen:linux-portal") {
				try {
					await window.electronAPI.selectSource(selectedSource);
				} catch (err) {
					console.warn("Failed to persist Linux portal sentinel source:", err);
				}
			}

			const permissionsReady = await preparePermissions();
			if (!permissionsReady) {
				recordingStartError.current = "Required recording permissions are unavailable.";
				return;
			}

			recordingSessionTimestamp.current = Date.now();
			resetRecordingClock(recordingSessionTimestamp.current);
			await prepareWebcamRecorder();
			const recordingMicrophoneDevice = microphoneEnabled
				? await resolveRecordingMicrophoneDevice(microphoneDeviceId).catch((error) => {
						console.warn("Failed to resolve microphone device:", error);
						return null;
					})
				: null;
			const selectedMicrophoneUnavailable =
				microphoneEnabled &&
				Boolean(microphoneDeviceId) &&
				microphoneDeviceId !== "default" &&
				!recordingMicrophoneDevice;
			const recordingMicrophoneDeviceId = selectedMicrophoneUnavailable
				? undefined
				: (recordingMicrophoneDevice?.deviceId ?? microphoneDeviceId);
			const recordingMicrophoneLabel = recordingMicrophoneDevice?.label;
			if (microphoneEnabled && !recordingMicrophoneDeviceId) {
				throw new Error(
					selectedMicrophoneUnavailable
						? "Selected microphone is not available. Please choose another microphone."
						: "No microphone is available. Please choose a microphone or turn microphone recording off.",
				);
			}
			if (
				microphoneEnabled &&
				recordingMicrophoneDeviceId &&
				recordingMicrophoneDeviceId !== microphoneDeviceId
			) {
				setMicrophoneDeviceId(recordingMicrophoneDeviceId);
				void window.electronAPI.setRecordingPreferences({
					microphoneDeviceId: recordingMicrophoneDeviceId,
				});
			}
			setRecordingAudioSources({
				systemAudioEnabled,
				microphoneEnabled,
				...(recordingMicrophoneDeviceId
					? { microphoneDeviceId: recordingMicrophoneDeviceId }
					: {}),
				...(recordingMicrophoneLabel ? { microphoneLabel: recordingMicrophoneLabel } : {}),
			});
			setRecordingAudioLevels(SILENT_RECORDING_AUDIO_LEVELS);
			const useNativeMacScreenCapture =
				platform === "darwin" &&
				(selectedSource.id?.startsWith("screen:") ||
					selectedSource.id?.startsWith("window:")) &&
				typeof window.electronAPI.startNativeScreenRecording === "function";

			let useNativeWindowsCapture = false;
			if (
				platform === "win32" &&
				(selectedSource.id?.startsWith("screen:") ||
					selectedSource.id?.startsWith("window:")) &&
				typeof window.electronAPI.isNativeWindowsCaptureAvailable === "function"
			) {
				try {
					const nativeWindowsResult =
						await window.electronAPI.isNativeWindowsCaptureAvailable();
					useNativeWindowsCapture = nativeWindowsResult.available;
					if (!useNativeWindowsCapture && !hasShownNativeWindowsFallbackToast.current) {
						void logNativeCaptureDiagnostics("is-native-windows-capture-available");
						hasShownNativeWindowsFallbackToast.current = true;
						toast.info(
							"Native Windows capture is unavailable. Falling back to browser capture.",
						);
					}
				} catch {
					useNativeWindowsCapture = false;
					if (!hasShownNativeWindowsFallbackToast.current) {
						hasShownNativeWindowsFallbackToast.current = true;
						toast.info(
							"Unable to check native Windows capture. Falling back to browser capture.",
						);
					}
				}
			}

			if (useNativeMacScreenCapture || useNativeWindowsCapture) {
				// Resolve the selected mic label for native capture backends.
				const micLabel = microphoneEnabled ? recordingMicrophoneLabel : undefined;

				const nativeResult = await window.electronAPI.startNativeScreenRecording(
					selectedSource,
					{
						capturesSystemAudio: systemAudioEnabled,
						capturesMicrophone: microphoneEnabled,
						microphoneDeviceId: recordingMicrophoneDeviceId,
						microphoneLabel: micLabel,
					},
				);
				if (!nativeResult.success) {
					if (useNativeWindowsCapture) {
						hideEditorOverlayCursorByDefault.current = true;
						console.warn(
							"Native Windows capture failed, falling back to browser capture:",
							nativeResult.error ?? nativeResult.message,
						);
						void logNativeCaptureDiagnostics("start-native-screen-recording");
						if (!hasShownNativeWindowsFallbackToast.current) {
							hasShownNativeWindowsFallbackToast.current = true;
							toast.warning(
								"Native Windows capture failed to start. Falling back to browser capture.",
							);
						}
					} else if (!nativeResult.userNotified) {
						throw new Error(
							nativeResult.error ??
								nativeResult.message ??
								"Failed to start native screen recording",
						);
					} else {
						setRecording(false);
						cleanupCapturedMedia();
						await stopWebcamRecorder();
						return;
					}
				}

				if (nativeResult.success) {
					activeNativePath.current = nativeResult.path ?? null;
					const mainStartedAt = Date.now();
					micFallbackStartDelayMs.current = null;
					beginWebcamCapture();
					nativeScreenRecording.current = true;
					nativeWindowsRecording.current = useNativeWindowsCapture;
					resetRecordingClock(mainStartedAt);
					webcamTimeOffsetMs.current =
						webcamStartTime.current === null
							? 0
							: webcamStartTime.current - mainStartedAt;

					// When native mic capture is unavailable or explicitly bypassed,
					// record mic via browser getUserMedia as a sidecar file.
					if (nativeResult.microphoneFallbackRequired && microphoneEnabled) {
						void logNativeCaptureDiagnostics("start-browser-microphone-fallback");
						console.info("Using browser microphone processing for this recording.");
						let fallbackStream: MediaStream | null = null;
						try {
							const microphoneConstraints = createProcessedMicrophoneConstraints(
								recordingMicrophoneDeviceId,
								browserMicrophoneProfile.current,
							);
							micFallbackRequestedConstraints.current = microphoneConstraints;
							fallbackStream =
								await navigator.mediaDevices.getUserMedia(microphoneConstraints);
							await startMicrophoneSidecarRecorder(fallbackStream, mainStartedAt);
							startAudioLevelMonitor(fallbackStream, {
								system: false,
								microphone: true,
							});
						} catch (micError) {
							fallbackStream?.getTracks().forEach((track) => track.stop());
							micFallbackStartDelayMs.current = null;
							micFallbackTrackSettings.current = null;
							micFallbackRequestedConstraints.current = null;
							micFallbackAudioInputDevices.current = null;
							micFallbackRecorderMetadata.current = null;
							resetMicFallbackTimingDiagnostics();
							recordingWarnings.current.push(
								`Microphone unavailable: ${getErrorMessage(micError)}`,
							);
							console.warn("Browser microphone fallback failed:", micError);
							const permissionDenied =
								micError instanceof DOMException &&
								(micError.name === "NotAllowedError" ||
									micError.name === "SecurityError");
							toast.error(
								permissionDenied
									? "Microphone permission denied. Recording will continue without microphone audio."
									: `${getErrorMessage(micError)}. Recording will continue without microphone audio.`,
								{ id: MICROPHONE_FALLBACK_ERROR_TOAST_ID, duration: 10000 },
							);
						}
					} else if (microphoneEnabled) {
						void startMicrophoneLevelMonitor(recordingMicrophoneDeviceId);
					}

					setRecording(true);
					window.electronAPI?.setRecordingState(true);

					return;
				}
			}

			hideEditorOverlayCursorByDefault.current = true;

			const wantsAudioCapture = microphoneEnabled || systemAudioEnabled;
			const browserCaptureSource = await resolveBrowserCaptureSource(selectedSource);

			if (
				browserCaptureSource?.id?.startsWith("screen:fallback:") ||
				browserCaptureSource?.id?.startsWith("window:fallback:")
			) {
				throw new Error(
					"Selected display is not available for browser capture on this system.",
				);
			}

			try {
				await window.electronAPI.hideOsCursor?.();
			} catch {
				console.warn("Could not hide OS cursor before recording.");
			}

			let videoTrack: MediaStreamTrack | undefined;
			let systemAudioIncluded = false;
			let recordingMicrophoneAsSidecar = false;
			const mediaDevices = navigator.mediaDevices as DesktopCaptureMediaDevices;
			const useLinuxPortal = selectedSource.id === "screen:linux-portal";
			const browserScreenVideoConstraints = {
				mandatory: {
					chromeMediaSource: CHROME_MEDIA_SOURCE,
					chromeMediaSourceId: browserCaptureSource.id,
					maxWidth: TARGET_WIDTH,
					maxHeight: TARGET_HEIGHT,
					maxFrameRate: TARGET_FRAME_RATE,
					minFrameRate: MIN_FRAME_RATE,
					googCaptureCursor: false,
				},
				cursor: "never" as const,
			};

			if (wantsAudioCapture) {
				let screenMediaStream: MediaStream;
				const acquireLinuxPortalStream = (withAudio: boolean) =>
					mediaDevices.getDisplayMedia({
						audio: withAudio,
						video: {
							displaySurface: "monitor",
							width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
							height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
							frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
							cursor: "never",
						},
						selfBrowserSurface: "exclude",
						surfaceSwitching: "exclude",
					});

				if (systemAudioEnabled) {
					try {
						screenMediaStream = useLinuxPortal
							? await acquireLinuxPortalStream(true)
							: await mediaDevices.getUserMedia({
									audio: {
										mandatory: {
											chromeMediaSource: CHROME_MEDIA_SOURCE,
											chromeMediaSourceId: browserCaptureSource.id,
										},
									},
									video: browserScreenVideoConstraints,
								});
					} catch (audioError) {
						console.warn(
							"System audio capture failed, falling back to video-only:",
							audioError,
						);
						toast.warning(tLaunch("permissions.systemAudioUnavailable"), { duration: 10000 });
						screenMediaStream = useLinuxPortal
							? await acquireLinuxPortalStream(false)
							: await mediaDevices.getUserMedia({
									audio: false,
									video: browserScreenVideoConstraints,
								});
					}
				} else {
					screenMediaStream = useLinuxPortal
						? await acquireLinuxPortalStream(false)
						: await mediaDevices.getUserMedia({
								audio: false,
								video: browserScreenVideoConstraints,
							});
				}

				screenStream.current = screenMediaStream;
				stream.current = new MediaStream();

				videoTrack = screenMediaStream.getVideoTracks()[0];
				if (!videoTrack) {
					throw new Error("Video track is not available.");
				}

				stream.current.addTrack(videoTrack);

				if (microphoneEnabled) {
					try {
						microphoneStream.current = await navigator.mediaDevices.getUserMedia(
							createProcessedMicrophoneConstraints(
								recordingMicrophoneDeviceId,
								browserMicrophoneProfile.current,
							),
						);
					} catch (audioError) {
						console.warn("Failed to get microphone access:", audioError);
						toast.warning(tLaunch("permissions.microphoneDenied"), { duration: 10000 });
						setMicrophoneEnabled(false);
					}
				}

				const systemAudioTrack = screenMediaStream.getAudioTracks()[0];
				const micAudioTrack = microphoneStream.current?.getAudioTracks()[0];

				if (systemAudioTrack && micAudioTrack) {
					stream.current.addTrack(systemAudioTrack);
					systemAudioIncluded = true;
					recordingMicrophoneAsSidecar = true;
				} else if (systemAudioTrack) {
					stream.current.addTrack(systemAudioTrack);
					systemAudioIncluded = true;
				} else if (micAudioTrack) {
					stream.current.addTrack(micAudioTrack);
				}
			} else {
				const mediaStream = useLinuxPortal
					? await mediaDevices.getDisplayMedia({
							audio: false,
							video: {
								displaySurface: selectedSource.id?.startsWith("window:")
									? "window"
									: "monitor",
								width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
								height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
								frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
								cursor: "never",
							},
							selfBrowserSurface: "exclude",
							surfaceSwitching: "exclude",
						})
					: await mediaDevices.getUserMedia({
							audio: false,
							video: browserScreenVideoConstraints,
						});

				stream.current = mediaStream;
				videoTrack = mediaStream.getVideoTracks()[0];
			}

			if (!stream.current || !videoTrack) {
				throw new Error("Media stream is not available.");
			}

			try {
				await videoTrack.applyConstraints({
					frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
					width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
					height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
				} as MediaTrackConstraints);
			} catch (error) {
				console.warn(
					"Unable to lock 4K/60fps constraints, using best available track settings.",
					error,
				);
			}

			let {
				width = DEFAULT_WIDTH,
				height = DEFAULT_HEIGHT,
				frameRate = TARGET_FRAME_RATE,
			} = videoTrack.getSettings();

			width = Math.floor(width / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;
			height = Math.floor(height / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;

			const videoBitsPerSecond = computeBitrate(width, height);
			const mimeType = selectMimeType();

			console.log(
				`Recording at ${width}x${height} @ ${frameRate ?? TARGET_FRAME_RATE}fps using ${mimeType ?? "browser default"} / ${Math.round(
					videoBitsPerSecond / BITS_PER_MEGABIT,
				)} Mbps`,
			);

			chunks.current = [];
			const hasAudio = stream.current.getAudioTracks().length > 0;
			if (hasAudio && !recordingMicrophoneAsSidecar) {
				startAudioLevelMonitor(stream.current, {
					system: systemAudioEnabled,
					microphone: microphoneEnabled,
				});
			}
			const recorder = new MediaRecorder(stream.current, {
				videoBitsPerSecond,
				...(mimeType ? { mimeType } : {}),
				...(hasAudio
					? {
							audioBitsPerSecond: systemAudioIncluded
								? AUDIO_BITRATE_SYSTEM
								: AUDIO_BITRATE_VOICE,
						}
					: {}),
			});

			mediaRecorder.current = recorder;
			recorder.ondataavailable = (event) => {
				if (event.data && event.data.size > 0) chunks.current.push(event.data);
			};
			recorder.onstop = async () => {
				const micSidecarBlobPromise =
					pendingBrowserMicSidecarBlobPromise.current ?? stopMicFallbackRecorder();
				pendingBrowserMicSidecarBlobPromise.current = null;
				if (chunks.current.length === 0) {
					await micSidecarBlobPromise.catch(() => null);
					cleanupCapturedMedia();
					setFinalizing(false);
					assemblyInFlight.current = false;
					if (captureMutation.current === "stopping") captureMutation.current = null;
					finalizationLatch.current.fail(
						new AutomationError(
							"EMPTY_RECORDING",
							"The recorder produced no video data.",
						),
					);
					return;
				}

				const duration = getRecordingDurationMs(Date.now());
				const recordedChunks = chunks.current;
				const recordingBlobType = recorder.mimeType || mimeType;
				const buggyBlob = new Blob(
					recordedChunks,
					recordingBlobType ? { type: recordingBlobType } : undefined,
				);
				chunks.current = [];
				const timestamp = recordingSessionTimestamp.current ?? Date.now();
				const videoFileName = `${RECORDING_FILE_PREFIX}${timestamp}${VIDEO_FILE_EXTENSION}`;

				try {
					const videoBlob = await fixWebmDuration(buggyBlob, duration);
					const arrayBuffer = await videoBlob.arrayBuffer();
					const videoResult = await window.electronAPI.storeRecordedVideo(
						arrayBuffer,
						videoFileName,
					);
					if (!videoResult.success) {
						console.error("Failed to store video:", videoResult.message);
						await micSidecarBlobPromise.catch(() => null);
						cleanupCapturedMedia();
						await notifyRecordingFinalizationFailure(
							videoResult.message || "Failed to store the recording.",
						);
						return;
					}

					if (videoResult.path) {
						const finalVideoPath = videoResult.path;
						await storeMicrophoneSidecar(micSidecarBlobPromise, finalVideoPath);
						cleanupCapturedMedia();
						// 1. Launch editor immediately (Optimistic UI)
						await finalizeRecordingSession(finalVideoPath, null, "assembling");

						// 2. Background webcam processing
						void (async () => {
							const webcamPath = pendingWebcamPathPromise.current
								? await pendingWebcamPathPromise.current
								: resolvedWebcamPath.current;

							try {
								await window.electronAPI.setCurrentRecordingSession({
									videoPath: finalVideoPath,
									webcamPath,
									timeOffsetMs: webcamTimeOffsetMs.current,
									hideOverlayCursorByDefault:
										hideEditorOverlayCursorByDefault.current,
									assetStatus: recordingWarnings.current.length
										? "degraded"
										: "ready",
									assetMessage: recordingWarnings.current.length
										? recordingWarnings.current.join("; ")
										: null,
								});
							} catch (webcamError) {
								await window.electronAPI.setCurrentRecordingSession({
									videoPath: finalVideoPath,
									webcamPath: null,
									timeOffsetMs: webcamTimeOffsetMs.current,
									hideOverlayCursorByDefault:
										hideEditorOverlayCursorByDefault.current,
									assetStatus: "degraded",
									assetMessage:
										webcamError instanceof Error
											? webcamError.message
											: "Webcam footage could not be finalized.",
								});
							} finally {
								completeFinalization();
								// After all background tasks are done (webcam),
								// we can safely close the HUD window to release hardware and resources.
								if (
									!retainRecorderForAutomation.current &&
									typeof window.electronAPI?.hudOverlayClose === "function"
								) {
									console.log(
										"[useScreenRecorder:browser] All background tasks finished, closing HUD",
									);
									window.electronAPI.hudOverlayClose();
								}
							}
						})().catch(async (error) => {
							await notifyRecordingFinalizationFailure(getErrorMessage(error));
						});
					} else {
						await micSidecarBlobPromise.catch(() => null);
						cleanupCapturedMedia();
						await notifyRecordingFinalizationFailure("Failed to save the recording.");
					}
				} catch (error) {
					await micSidecarBlobPromise.catch(() => null);
					cleanupCapturedMedia();
					console.error("Error saving recording:", error);
					const message = error instanceof Error ? error.message : String(error);
					await notifyRecordingFinalizationFailure(
						`Failed to finalize the recording. ${message}`,
					);
				}
			};
			recorder.onerror = () => {
				setRecording(false);
			};
			const mainStartedAt = Date.now();
			beginWebcamCapture();
			resetRecordingClock(mainStartedAt);
			webcamTimeOffsetMs.current =
				webcamStartTime.current === null ? 0 : webcamStartTime.current - mainStartedAt;
			if (recordingMicrophoneAsSidecar && microphoneStream.current) {
				try {
					micFallbackRequestedConstraints.current = createProcessedMicrophoneConstraints(
						recordingMicrophoneDeviceId,
						browserMicrophoneProfile.current,
					);
					await startMicrophoneSidecarRecorder(microphoneStream.current, mainStartedAt);
					startAudioLevelMonitor(microphoneStream.current, {
						system: false,
						microphone: true,
					});
				} catch (micSidecarError) {
					recordingWarnings.current.push(
						`Microphone sidecar unavailable: ${getErrorMessage(micSidecarError)}`,
					);
					console.warn("Failed to start browser microphone sidecar:", micSidecarError);
					toast.error(
						`${getErrorMessage(micSidecarError)}. Recording will continue without microphone audio.`,
						{ id: MICROPHONE_FALLBACK_ERROR_TOAST_ID, duration: 10000 },
					);
				}
			}
			recorder.start(RECORDER_TIMESLICE_MS);
			setRecording(true);
			window.electronAPI?.setRecordingState(true);
		} catch (error) {
			recordingStartError.current = getErrorMessage(error);
			console.error("Failed to start recording:", error);
			toast.error(
				error instanceof Error
					? tLaunch("permissions.failedToStart", undefined, { error: error.message })
					: tLaunch("permissions.failedToStartGeneric"),
				{ duration: 12000 },
			);
			setRecording(false);
			setRecordingAudioSources({
				systemAudioEnabled: false,
				microphoneEnabled: false,
			});
			setRecordingAudioLevels(SILENT_RECORDING_AUDIO_LEVELS);
			try {
				await window.electronAPI?.setRecordingState(false);
			} catch (stateError) {
				console.warn("Failed to reset main-process recording state:", stateError);
			} finally {
				cleanupCapturedMedia();
				await stopWebcamRecorder();
			}
		} finally {
			startInFlight.current = false;
			if (captureMutation.current === "starting") captureMutation.current = null;
			setStarting(false);
		}
	};

	const pauseRecording = useCallback(async () => {
		if (!claimRecorderMutation(captureMutation, "pausing")) return false;
		try {
			if (!recorderStateRef.current.recording || recorderStateRef.current.paused)
				return false;
			if (nativeScreenRecording.current) {
				const result = await window.electronAPI.pauseNativeScreenRecording();
				if (!result.success) {
					recordingWarnings.current.push(
						result.error || result.message || "Native pause failed.",
					);
					return false;
				}
			} else if (mediaRecorder.current?.state === "recording") {
				mediaRecorder.current.pause();
			} else return false;
			if (webcamRecorder.current?.state === "recording") webcamRecorder.current.pause();
			pauseMicFallbackRecorder();
			const boundaryMs = Date.now();
			markRecordingPaused(boundaryMs);
			setPaused(true);
			try {
				await window.electronAPI.pauseCursorCapture(boundaryMs);
			} catch (error) {
				recordingWarnings.current.push(`Cursor pause failed: ${getErrorMessage(error)}`);
			}
			return true;
		} finally {
			releaseRecorderMutation(captureMutation, "pausing");
		}
	}, [markRecordingPaused, pauseMicFallbackRecorder, setPaused]);

	const resumeRecording = useCallback(async () => {
		if (!claimRecorderMutation(captureMutation, "resuming")) return false;
		try {
			if (!recorderStateRef.current.recording || !recorderStateRef.current.paused)
				return false;
			if (nativeScreenRecording.current) {
				const result = await window.electronAPI.resumeNativeScreenRecording();
				if (!result.success) {
					recordingWarnings.current.push(
						result.error || result.message || "Native resume failed.",
					);
					return false;
				}
			} else if (mediaRecorder.current?.state === "paused") {
				mediaRecorder.current.resume();
			} else return false;
			if (webcamRecorder.current?.state === "paused") webcamRecorder.current.resume();
			resumeMicFallbackRecorder();
			const boundaryMs = Date.now();
			markRecordingResumed(boundaryMs);
			setPaused(false);
			try {
				await window.electronAPI.resumeCursorCapture(boundaryMs);
			} catch (error) {
				recordingWarnings.current.push(`Cursor resume failed: ${getErrorMessage(error)}`);
			}
			return true;
		} finally {
			releaseRecorderMutation(captureMutation, "resuming");
		}
	}, [markRecordingResumed, resumeMicFallbackRecorder, setPaused]);

	const cancelRecording = useCallback(async () => {
		if (!recorderStateRef.current.recording)
			throw new AutomationError("NOT_RECORDING", "No recording is active.");
		if (!claimRecorderMutation(captureMutation, "cancelling"))
			throw new AutomationError("BUSY", "Another recorder operation is running.");
		setFinalizing(true);
		stopAudioLevelMonitor();
		try {
			const retainedPaths: string[] = [];
			if (nativeScreenRecording.current) {
				const result = await window.electronAPI.stopNativeScreenRecording({ discard: true });
				if (!result.success)
					throw new AutomationError(
						"CANCEL_FAILED",
						result.error || result.message || "Failed to stop native recording.",
					);
				nativeScreenRecording.current = false;
				nativeWindowsRecording.current = false;
				retainedPaths.push(
					...(await deleteOwnedCancelledRecording(
						activeNativePath.current,
						result.path,
						window.electronAPI.deleteRecordingFile,
					)),
				);
			}
			// Disable saving handlers before stop events, so cancellation cannot create sidecar files.
			const webcamCapture = webcamRecorder.current;
			if (webcamCapture) {
				webcamCapture.ondataavailable = null;
				webcamCapture.onstop = null;
				if (webcamCapture.state !== "inactive") webcamCapture.stop();
			}
			webcamStopResolver.current?.(null);
			webcamStopResolver.current = null;
			webcamStopPromise.current = null;
			webcamRecorder.current = null;
			webcamChunks.current = [];
			webcamStartTime.current = null;
			webcamTimeOffsetMs.current = 0;
			pendingWebcamPathPromise.current = null;
			resolvedWebcamPath.current = null;
			const recorder = mediaRecorder.current;
			if (recorder) {
				recorder.ondataavailable = null;
				recorder.onstop = null;
				if (recorder.state !== "inactive") recorder.stop();
			}
			chunks.current = [];
			cleanupCapturedMedia();
			mediaRecorder.current = null;
			activeNativePath.current = null;
			setPaused(false);
			markRecordingResumed(Date.now());
			setRecording(false);
			setRecordingAudioSources({ systemAudioEnabled: false, microphoneEnabled: false });
			setRecordingAudioLevels(SILENT_RECORDING_AUDIO_LEVELS);
			await window.electronAPI.setRecordingState(false);
			return { cancelled: true, retainedPaths };
		} finally {
			releaseRecorderMutation(captureMutation, "cancelling");
			setFinalizing(false);
		}
	}, [
		cleanupCapturedMedia,
		markRecordingResumed,
		stopAudioLevelMonitor,
		setFinalizing,
		setPaused,
		setRecording,
	]);

	const toggleRecording = async () => {
		if (
			starting ||
			countdownActive ||
			finalizing ||
			startCoordinator.current.starting ||
			startInFlight.current ||
			captureMutation.current ||
			assemblyInFlight.current
		) {
			return;
		}

		if (
			recorderStateRef.current.recording ||
			nativeScreenRecording.current ||
			mediaRecorder.current?.state === "recording" ||
			mediaRecorder.current?.state === "paused"
		) {
			stopRecording.current();
			return;
		}

		try {
			await startCoordinator.current.start({
				delaySeconds: countdownDelay,
				countdown: window.electronAPI.startCountdown,
				onCountdown: setCountdownActive,
				start: startRecording,
			});
		} catch (error) {
			if (!(error instanceof AutomationError && error.code === "CANCELLED"))
				toast.error(getErrorMessage(error));
		}
	};

	const automationStatus = () => ({
		...recorderStateRef.current,
		recording:
			nativeScreenRecording.current ||
			mediaRecorder.current?.state === "recording" ||
			mediaRecorder.current?.state === "paused" ||
			recorderStateRef.current.recording,
		starting:
			startInFlight.current ||
			startCoordinator.current.starting ||
			recorderStateRef.current.starting,
		countdownActive:
			startCoordinator.current.countdownActive || recorderStateRef.current.countdownActive,
		finalizing:
			captureMutation.current === "stopping" ||
			captureMutation.current === "cancelling" ||
			assemblyInFlight.current ||
			finalizationLatch.current.pending ||
			recorderStateRef.current.finalizing,
		warnings: [...recordingWarnings.current],
	});
	const finalSession = async () => {
		const result = await window.electronAPI.getCurrentRecordingSession();
		if (
			!result.success ||
			!result.session ||
			result.session.videoPath !== finalizedVideoPath.current ||
			result.session.assetStatus === "assembling"
		)
			throw new AutomationError(
				"SESSION_NOT_READY",
				"Recording session was not fully handed off to the editor.",
			);
		return { session: result.session, warnings: [...recordingWarnings.current] };
	};
	const cancelAutomationCountdown = async () => {
		await startCoordinator.current.cancelCountdown(window.electronAPI.cancelCountdown);
		return { cancelled: true, countdownCancelled: true };
	};
	const automation = {
		retain: () => {
			retainRecorderForAutomation.current = true;
		},
		status: automationStatus,
		start: async () => {
			assertRecorderTransition(automationStatus(), "start");
			retainRecorderForAutomation.current = true;
			recordingWarnings.current = [];
			recordingStartError.current = null;
			return startCoordinator.current.start({
				delaySeconds: countdownDelay,
				countdown: window.electronAPI.startCountdown,
				onCountdown: setCountdownActive,
				start: async () => {
					await startRecording();
					if (
						recordingStartError.current ||
						(!nativeScreenRecording.current &&
							mediaRecorder.current?.state !== "recording")
					)
						throw new AutomationError(
							"START_FAILED",
							recordingStartError.current || "Recording did not start.",
							{ recordingMayBeActive: nativeScreenRecording.current },
						);
					return {
						...automationStatus(),
						recording: true,
						starting: false,
						countdownActive: false,
					};
				},
			});
		},
		stop: async () => {
			const state = automationStatus();
			assertRecorderTransition(state, "stop");
			if (state.countdownActive) return cancelAutomationCountdown();
			if (
				!nativeScreenRecording.current &&
				mediaRecorder.current?.state !== "recording" &&
				mediaRecorder.current?.state !== "paused"
			)
				throw new AutomationError(
					"NOT_RECORDING",
					"This recorder does not own an active capture.",
				);
			const completed = finalizationLatch.current.wait();
			try {
				if (!stopRecording.current())
					finalizationLatch.current.fail(
						new AutomationError("BUSY", "Another recorder operation is running."),
					);
			} catch (error) {
				void notifyRecordingFinalizationFailure(getErrorMessage(error));
			}
			await completed;
			return finalSession();
		},
		pause: async () => {
			assertRecorderTransition(automationStatus(), "pause");
			if (!(await pauseRecording()))
				throw new AutomationError("PAUSE_FAILED", "Recording could not be paused.");
			return { ...automationStatus(), paused: true };
		},
		resume: async () => {
			assertRecorderTransition(automationStatus(), "resume");
			if (!(await resumeRecording()))
				throw new AutomationError("RESUME_FAILED", "Recording could not be resumed.");
			return { ...automationStatus(), paused: false };
		},
		cancel: async () => {
			const state = automationStatus();
			assertRecorderTransition(state, "cancel");
			if (state.countdownActive) return cancelAutomationCountdown();
			return cancelRecording();
		},
		recover: async () => {
			assertRecorderTransition(automationStatus(), "recover");
			retainRecorderForAutomation.current = true;
			if (!claimRecorderMutation(captureMutation, "stopping"))
				throw new AutomationError("BUSY", "Another recorder operation is running.");
			setFinalizing(true);
			try {
				const path = await recoverNativeRecordingSession();
				if (!path)
					throw new AutomationError(
						"NOTHING_TO_RECOVER",
						"No recoverable native recording is available.",
					);
				return await finalSession();
			} finally {
				releaseRecorderMutation(captureMutation, "stopping");
				setFinalizing(false);
			}
		},
	};

	return {
		ready: preferencesReady && countdownReady,
		starting,
		automation,
		recording,
		paused,
		finalizing,
		countdownActive,
		toggleRecording,
		pauseRecording: () => {
			void pauseRecording().catch((error) => toast.error(getErrorMessage(error)));
		},
		resumeRecording: () => {
			void resumeRecording().catch((error) => toast.error(getErrorMessage(error)));
		},
		cancelRecording: () => {
			void cancelRecording().catch((error) => toast.error(getErrorMessage(error)));
		},
		preparePermissions,
		isMacOS,
		microphoneEnabled,
		setMicrophoneEnabled: persistMicrophoneEnabled,
		microphoneDeviceId,
		setMicrophoneDeviceId: persistMicrophoneDeviceId,
		systemAudioEnabled,
		setSystemAudioEnabled: persistSystemAudioEnabled,
		recordingAudioSources,
		recordingAudioLevels,
		webcamEnabled,
		setWebcamEnabled,
		webcamDeviceId,
		setWebcamDeviceId,
		countdownDelay,
		setCountdownDelay,
	};
}
