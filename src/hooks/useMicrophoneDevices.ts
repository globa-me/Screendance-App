import { useEffect, useState } from "react";

export interface MicrophoneDevice {
	deviceId: string;
	label: string;
	groupId: string;
}

let hasRequestedMicrophoneLabels = false;

const ALIAS_MICROPHONE_DEVICE_IDS = new Set(["default", "communications"]);

function getFallbackMicrophoneLabel(device: MediaDeviceInfo, index: number) {
	return device.label || `Microphone ${index + 1}`;
}

export function createMicrophoneDeviceOptions(devices: MediaDeviceInfo[]): MicrophoneDevice[] {
	const audioInputs = devices.filter((device) => device.kind === "audioinput");
	const concreteInputs = audioInputs.filter(
		(device) => !ALIAS_MICROPHONE_DEVICE_IDS.has(device.deviceId),
	);
	const visibleInputs = concreteInputs.length > 0 ? concreteInputs : audioInputs;
	const seenDeviceIds = new Set<string>();

	return visibleInputs
		.filter((device) => {
			if (seenDeviceIds.has(device.deviceId)) {
				return false;
			}
			seenDeviceIds.add(device.deviceId);
			return true;
		})
		.map((device, index) => ({
			deviceId: device.deviceId,
			label: getFallbackMicrophoneLabel(device, index),
			groupId: device.groupId,
		}));
}

export function useMicrophoneDevices(enabled: boolean = true, preferredDeviceId?: string) {
	const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
	const [selectedDeviceId, setSelectedDeviceId] = useState<string>("default");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!enabled) {
			return;
		}

		let mounted = true;

		const loadDevices = async () => {
			let permissionStream: MediaStream | null = null;

			try {
				setIsLoading(true);
				setError(null);

				let allDevices = await navigator.mediaDevices.enumerateDevices();
				const audioInputDevices = allDevices.filter(
					(device) => device.kind === "audioinput",
				);
				let audioInputs = createMicrophoneDeviceOptions(allDevices);

				const needsLabelPermission =
					audioInputDevices.length > 0 &&
					audioInputDevices.every((device) => !device.label.trim());

				if (needsLabelPermission && !hasRequestedMicrophoneLabels) {
					hasRequestedMicrophoneLabels = true;
					permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
					allDevices = await navigator.mediaDevices.enumerateDevices();
					audioInputs = createMicrophoneDeviceOptions(allDevices);
				}

				if (mounted) {
					setDevices(audioInputs);
					setSelectedDeviceId((currentDeviceId) => {
						const normalizedPreferredDeviceId = preferredDeviceId ?? "default";
						if (
							audioInputs.some(
								(device) => device.deviceId === normalizedPreferredDeviceId,
							)
						) {
							return normalizedPreferredDeviceId;
						}

						if (
							currentDeviceId !== "default" &&
							audioInputs.some((device) => device.deviceId === currentDeviceId)
						) {
							return currentDeviceId;
						}

						return (
							audioInputs.find((device) => device.deviceId !== "default")?.deviceId ??
							audioInputs[0]?.deviceId ??
							"default"
						);
					});
					setIsLoading(false);
				}
			} catch (error) {
				if (mounted) {
					const message =
						error instanceof Error
							? error.message
							: "Failed to enumerate audio devices";
					setError(message);
					setIsLoading(false);
					console.error("Error loading microphone devices:", error);
				}
			} finally {
				permissionStream?.getTracks().forEach((track) => track.stop());
			}
		};

		void loadDevices();

		const handleDeviceChange = () => {
			void loadDevices();
		};

		navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

		return () => {
			mounted = false;
			navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
		};
	}, [enabled, preferredDeviceId]);

	return {
		devices,
		selectedDeviceId,
		setSelectedDeviceId,
		isLoading,
		error,
	};
}
