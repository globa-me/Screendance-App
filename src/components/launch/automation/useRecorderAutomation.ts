import { useEffect, useRef } from "react";
import {
	AutomationError,
	type AutomationRequest,
	toAutomationError,
} from "../../../../shared/automation";
import type { UseScreenRecorderReturn } from "../../../hooks/useScreenRecorder";
import { assertRecorderTransition } from "./recordingControl";

interface RecorderAutomationOptions {
	recorder: UseScreenRecorderReturn;
	onSelectedSource: (source: { name?: string } | null | undefined) => void;
	controlledInitially: boolean;
}

const isReadCommand = (method: string) =>
	["recording.status", "sources.list", "devices.list"].includes(method);

async function listSources() {
	if ((await window.electronAPI.getPlatform()) === "darwin") {
		const permission = await window.electronAPI.getScreenRecordingPermissionStatus();
		if (!permission.success || permission.status !== "granted")
			return { sources: [], permission };
	}
	const sources = await window.electronAPI.getSources({
		types: ["screen", "window"],
		thumbnailSize: { width: 1, height: 1 },
		fetchWindowIcons: false,
	});
	return { sources };
}

async function listDevices() {
	const devices = await navigator.mediaDevices.enumerateDevices();
	return {
		microphones: devices
			.filter((device) => device.kind === "audioinput")
			.map((device) => ({
				deviceId: device.deviceId,
				groupId: device.groupId,
				label: device.label,
			})),
		cameras: devices
			.filter((device) => device.kind === "videoinput")
			.map((device) => ({
				deviceId: device.deviceId,
				groupId: device.groupId,
				label: device.label,
			})),
	};
}

async function requestPermission(kind: unknown) {
	if (kind === "accessibility") return window.electronAPI.requestAccessibilityPermission();
	if (kind === "screen") {
		// Enumerating a screen is the normal macOS prompt path; explicit request only.
		await window.electronAPI.getSources({
			types: ["screen"],
			thumbnailSize: { width: 1, height: 1 },
			fetchWindowIcons: false,
		});
		const result = await window.electronAPI.getScreenRecordingPermissionStatus();
		if (result.status !== "granted") await window.electronAPI.openScreenRecordingPreferences();
		return result;
	}
	if (kind === "microphone" || kind === "camera") {
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia(
				kind === "microphone"
					? { audio: true, video: false }
					: { audio: false, video: true },
			);
		} catch (error) {
			throw new AutomationError(
				"PERMISSION_DENIED",
				error instanceof Error ? error.message : "Media access was denied.",
			);
		}
		stream.getTracks().forEach((track) => track.stop());
		return { success: true, kind, status: "granted" };
	}
	throw new AutomationError("INVALID_PARAMS", "Unknown permission kind.");
}

export function useRecorderAutomation(options: RecorderAutomationOptions): void {
	const latest = useRef(options);
	latest.current = options;
	const operation = useRef<string | null>(null);
	const status = async () => {
		const recorder = latest.current.recorder;
		return {
			...recorder.automation.status(),
			phase: recorder.automation.status().finalizing
				? "finalizing"
				: recorder.automation.status().countdownActive
					? "countdown"
					: recorder.automation.status().starting
						? "starting"
						: recorder.automation.status().recording
							? recorder.automation.status().paused
								? "paused"
								: "recording"
							: "idle",
			settings: {
				microphoneEnabled: recorder.microphoneEnabled,
				microphoneDeviceId: recorder.microphoneDeviceId ?? "default",
				systemAudioEnabled: recorder.systemAudioEnabled,
				webcamEnabled: recorder.webcamEnabled,
				webcamDeviceId: recorder.webcamDeviceId ?? "default",
				countdownSeconds: recorder.countdownDelay,
			},
			selectedSource: await window.electronAPI.getSelectedSource(),
		};
	};
	const statusRef = useRef(status);
	statusRef.current = status;

	useEffect(() => {
		const handle = async (request: AutomationRequest): Promise<unknown> => {
			if (!isReadCommand(request.method)) latest.current.recorder.automation.retain();
			await new Promise((resolve) => setTimeout(resolve, 0));
			const recorder = latest.current.recorder;
			if (!recorder.ready)
				throw new AutomationError("BUSY", "Recorder preferences are still loading.");
			if (request.method === "recording.status") return statusRef.current();
			if (request.method === "sources.list") return listSources();
			if (request.method === "devices.list") return listDevices();
			if (request.method === "sources.select") {
				assertRecorderTransition(recorder.automation.status(), "configure");
				const source = (await listSources()).sources.find(
					(item) => item.id === request.params.sourceId,
				);
				if (!source)
					throw new AutomationError(
						"SOURCE_NOT_FOUND",
						"Select an exact sourceId returned by sources.list.",
					);
				assertRecorderTransition(latest.current.recorder.automation.status(), "configure");
				const selected = await window.electronAPI.selectSource(source);
				latest.current.onSelectedSource(selected);
				return { selectedSource: selected };
			}
			if (request.method === "permissions.request")
				return requestPermission(request.params.kind);
			if (request.method === "recording.adjust") {
				const settings = request.params;
				if (!recorder.liveCapture.available)
					throw new AutomationError(
						"INVALID_STATE",
						"Pause a native macOS recording before adjusting it.",
					);
				const devices = await listDevices();
				for (const [key, available] of [
					["microphoneDeviceId", devices.microphones],
					["webcamDeviceId", devices.cameras],
				] as const) {
					if (
						settings[key] !== undefined &&
						settings[key] !== "default" &&
						!available.some((device) => device.deviceId === settings[key])
					)
						throw new AutomationError("DEVICE_NOT_FOUND", `${key} is not available.`);
				}
				const applied: Record<string, unknown> = {};
				const apply = async (
					key: string,
					change: () => Promise<{ success: boolean; message?: string }>,
				) => {
					const result = await change();
					if (!result.success)
						throw new AutomationError(
							"ADJUST_FAILED",
							`${key}: ${result.message ?? "the change could not be applied."}`,
						);
					applied[key] = true;
				};
				if (typeof settings.sourceId === "string") {
					const source = (await listSources()).sources.find(
						(item) => item.id === settings.sourceId,
					);
					if (!source)
						throw new AutomationError(
							"SOURCE_NOT_FOUND",
							"Select an exact sourceId returned by sources.list.",
						);
					await apply("source", () =>
						latest.current.recorder.liveCapture.switchSource(source),
					);
					latest.current.onSelectedSource(source);
				}
				const microphoneDeviceId =
					typeof settings.microphoneDeviceId === "string"
						? settings.microphoneDeviceId
						: undefined;
				if (typeof settings.microphoneEnabled === "boolean" || microphoneDeviceId)
					await apply("microphone", () =>
						latest.current.recorder.liveCapture.setMicrophone(
							typeof settings.microphoneEnabled === "boolean"
								? settings.microphoneEnabled
								: true,
							microphoneDeviceId,
						),
					);
				const webcamDeviceId =
					typeof settings.webcamDeviceId === "string" &&
					settings.webcamDeviceId !== "default"
						? settings.webcamDeviceId
						: undefined;
				if (typeof settings.webcamEnabled === "boolean" || webcamDeviceId)
					await apply("webcam", () =>
						latest.current.recorder.liveCapture.setWebcam(
							typeof settings.webcamEnabled === "boolean"
								? settings.webcamEnabled
								: true,
							webcamDeviceId,
						),
					);
				return { ...(await statusRef.current()), applied };
			}
			if (request.method === "recording.configure") {
				assertRecorderTransition(recorder.automation.status(), "configure");
				const settings = request.params;
				const devices = await listDevices();
				for (const [key, available] of [
					["microphoneDeviceId", devices.microphones],
					["webcamDeviceId", devices.cameras],
				] as const) {
					if (
						settings[key] !== undefined &&
						settings[key] !== "default" &&
						!available.some((device) => device.deviceId === settings[key])
					)
						throw new AutomationError("DEVICE_NOT_FOUND", `${key} is not available.`);
				}
				for (const key of [
					"microphoneEnabled",
					"systemAudioEnabled",
					"webcamEnabled",
				] as const) {
					if (settings[key] !== undefined && typeof settings[key] !== "boolean")
						throw new AutomationError("INVALID_PARAMS", `${key} must be boolean.`);
				}
				if (
					settings.countdownSeconds !== undefined &&
					(typeof settings.countdownSeconds !== "number" ||
						!Number.isInteger(settings.countdownSeconds) ||
						settings.countdownSeconds < 0 ||
						settings.countdownSeconds > 10)
				)
					throw new AutomationError(
						"INVALID_PARAMS",
						"countdownSeconds must be an integer from 0 to 10.",
					);
				assertRecorderTransition(latest.current.recorder.automation.status(), "configure");
				const preferences = await window.electronAPI.setRecordingPreferences({
					...(typeof settings.microphoneEnabled === "boolean"
						? { microphoneEnabled: settings.microphoneEnabled }
						: {}),
					...(typeof settings.systemAudioEnabled === "boolean"
						? { systemAudioEnabled: settings.systemAudioEnabled }
						: {}),
					...(typeof settings.microphoneDeviceId === "string"
						? {
								microphoneDeviceId:
									settings.microphoneDeviceId === "default"
										? undefined
										: settings.microphoneDeviceId,
							}
						: {}),
				});
				if (!preferences.success)
					throw new AutomationError(
						"CONFIGURE_FAILED",
						preferences.error || "Recording preferences could not be saved.",
					);
				if (typeof settings.countdownSeconds === "number") {
					const result = await window.electronAPI.setCountdownDelay(
						settings.countdownSeconds,
					);
					if (!result.success)
						throw new AutomationError(
							"CONFIGURE_FAILED",
							result.error || "Countdown could not be saved.",
						);
				}
				if (typeof settings.microphoneEnabled === "boolean")
					recorder.setMicrophoneEnabled(settings.microphoneEnabled);
				if (typeof settings.systemAudioEnabled === "boolean")
					recorder.setSystemAudioEnabled(settings.systemAudioEnabled);
				if (typeof settings.microphoneDeviceId === "string")
					recorder.setMicrophoneDeviceId(
						settings.microphoneDeviceId === "default"
							? undefined
							: settings.microphoneDeviceId,
					);
				if (typeof settings.webcamEnabled === "boolean")
					recorder.setWebcamEnabled(settings.webcamEnabled);
				if (typeof settings.webcamDeviceId === "string")
					recorder.setWebcamDeviceId(
						settings.webcamDeviceId === "default" ? undefined : settings.webcamDeviceId,
					);
				if (typeof settings.countdownSeconds === "number")
					recorder.setCountdownDelay(settings.countdownSeconds);
				await new Promise((resolve) => setTimeout(resolve, 0));
				return statusRef.current();
			}
			const controls: Record<string, () => Promise<unknown>> = {
				"recording.start": recorder.automation.start,
				"recording.pause": recorder.automation.pause,
				"recording.resume": recorder.automation.resume,
				"recording.stop": recorder.automation.stop,
				"recording.cancel": recorder.automation.cancel,
				"recording.recover": recorder.automation.recover,
			};
			const control = controls[request.method];
			if (!control)
				throw new AutomationError("UNKNOWN_COMMAND", "Unsupported recorder command.");
			const result = await control();
			return {
				...(await statusRef.current()),
				...(result && typeof result === "object" ? result : {}),
			};
		};
		return window.electronAPI.onAutomationRequest((request) => {
			void (async () => {
				const read = isReadCommand(request.method);
				const cancellingCountdown =
					(request.method === "recording.cancel" ||
						request.method === "recording.stop") &&
					operation.current === "recording.start" &&
					latest.current.recorder.automation.status().countdownActive;
				if (!read && operation.current && !cancellingCountdown) {
					window.electronAPI.sendAutomationResponse({
						id: request.id,
						error: { code: "BUSY", message: "Another recorder operation is running." },
					});
					return;
				}
				if (!read && !cancellingCountdown) operation.current = request.method;
				try {
					const result = await handle(request);
					window.electronAPI.sendAutomationResponse({ id: request.id, result });
				} catch (error) {
					window.electronAPI.sendAutomationResponse({
						id: request.id,
						error: toAutomationError(error),
					});
				} finally {
					if (!read && !cancellingCountdown) operation.current = null;
				}
			})();
		});
	}, []);
	useEffect(() => {
		if (options.controlledInitially) options.recorder.automation.retain();
		if (options.recorder.ready) window.electronAPI.automationRecorderReady();
	}, [options.recorder.ready, options.controlledInitially, options.recorder.automation.retain]);
}
