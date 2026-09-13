import {
	MicrophoneIcon,
	MicrophoneSlashIcon,
	MinusIcon,
	PauseIcon,
	PlayIcon,
	SpeakerHighIcon,
	SquareIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useScopedT } from "@/contexts/I18nContext";
import type { RecordingAudioLevels, RecordingAudioSources } from "@/hooks/useScreenRecorder";
import styles from "./LaunchWindow.module.css";

interface RecordingControlsProps {
	paused: boolean;
	microphoneEnabled: boolean;
	systemAudioEnabled: boolean;
	recordingAudioSources: RecordingAudioSources;
	recordingAudioLevels: RecordingAudioLevels;
	elapsed: number;
	onToggleMicrophone: () => void;
	onPauseResume: () => void;
	onStopRecording: () => void;
	onHideHud: () => void;
	onCancelRecording: () => void;
	formatTime: (seconds: number) => string;
}

export const RecordingControls = ({
	paused,
	microphoneEnabled,
	systemAudioEnabled,
	recordingAudioSources,
	recordingAudioLevels,
	elapsed,
	onToggleMicrophone,
	onPauseResume,
	onStopRecording,
	onHideHud,
	onCancelRecording,
	formatTime,
}: RecordingControlsProps) => {
	const t = useScopedT("launch");

	const memoizedControls = useMemo(() => {
		const audioSources = [
			...(recordingAudioSources.systemAudioEnabled || systemAudioEnabled
				? [
						{
							id: "system",
							label: t("recording.systemAudioSource"),
							level: recordingAudioLevels.system,
							icon: <SpeakerHighIcon size={13} />,
						},
					]
				: []),
			...(recordingAudioSources.microphoneEnabled || microphoneEnabled
				? [
						{
							id: "microphone",
							label:
								recordingAudioSources.microphoneLabel ??
								t("recording.microphoneSource"),
							level: recordingAudioLevels.microphone,
							icon: <MicrophoneIcon size={13} />,
						},
					]
				: []),
		];

		return (
			<>
				<div className="flex items-center gap-[5px]">
					<div
						className={`w-[7px] h-[7px] rounded-full ${
							paused ? "bg-[#fbbf24]" : `bg-[#f43f5e] ${styles.recDotBlink}`
						}`}
					/>
					<span
						className={`text-[10px] font-bold tracking-[0.06em] ${
							paused ? "text-[#fbbf24]" : "text-[#f43f5e]"
						}`}
					>
						{paused ? t("recording.paused") : t("recording.rec")}
					</span>
				</div>

				<span
					className={`font-mono text-xs font-semibold min-w-[52px] text-center tracking-[0.02em] ${
						paused ? "text-[#fbbf24]" : "text-[var(--launch-text)]"
					}`}
				>
					{formatTime(elapsed)}
				</span>

				<Separator orientation="vertical" className="mx-[5px] h-6" />

				<div
					className={styles.recordingAudioMonitor}
					title={t("recording.audioMonitor")}
					aria-label={t("recording.audioMonitor")}
				>
					{audioSources.length > 0 ? (
						audioSources.map((source) => (
							<div className={styles.recordingAudioSource} key={source.id}>
								<span className={styles.recordingAudioSourceLabel}>
									{source.icon}
									<span>{source.label}</span>
								</span>
								<RecordingAudioHistogram level={source.level} />
							</div>
						))
					) : (
						<div className={styles.recordingAudioSource}>
							<span className={styles.recordingAudioSourceLabel}>
								<MicrophoneSlashIcon size={13} />
								<span>{t("recording.noAudioSource")}</span>
							</span>
							<RecordingAudioHistogram level={0} />
						</div>
					)}
				</div>

				<Separator orientation="vertical" className="mx-[5px] h-6" />

				<span title={t("recording.micToggleDisabledTip")}>
					<Button
						variant="ghost"
						size="icon"
						iconSize="lg"
						className={microphoneEnabled ? styles.ibActive : ""}
						aria-label={t("recording.micToggleDisabledTip")}
						disabled
						onClick={onToggleMicrophone}
					>
						{microphoneEnabled ? (
							<MicrophoneIcon size={18} />
						) : (
							<MicrophoneSlashIcon size={18} />
						)}
					</Button>
				</span>

				<Separator orientation="vertical" className="mx-[5px] h-6" />

				<Button
					variant={paused ? "default" : "ghost"}
					size="icon"
					iconSize="lg"
					onClick={onPauseResume}
					title={paused ? t("recording.resume") : t("recording.pause")}
					aria-label={paused ? t("recording.resume") : t("recording.pause")}
					className={paused ? styles.ibGreen : ""}
				>
					{paused ? (
						<PlayIcon size={18} fill="currentColor" strokeWidth={0} />
					) : (
						<PauseIcon size={18} />
					)}
				</Button>

				<Button
					variant="ghost"
					size="icon"
					iconSize="lg"
					onClick={onStopRecording}
					title={t("recording.stop")}
					aria-label={t("recording.stop")}
					className={styles.ibRed}
				>
					<SquareIcon size={16} fill="currentColor" strokeWidth={0} />
				</Button>

				<Button
					variant="ghost"
					size="icon"
					iconSize="lg"
					onClick={onHideHud}
					title={t("recording.hideHud")}
					aria-label={t("recording.hideHud")}
				>
					<MinusIcon size={16} />
				</Button>

				<Button
					variant="ghost"
					size="icon"
					iconSize="lg"
					onClick={onCancelRecording}
					title={t("recording.cancel")}
					aria-label={t("recording.cancel")}
				>
					<XIcon size={18} />
				</Button>
			</>
		);
	}, [
		paused,
		microphoneEnabled,
		systemAudioEnabled,
		recordingAudioSources,
		recordingAudioLevels,
		elapsed,
		onToggleMicrophone,
		onPauseResume,
		onStopRecording,
		onHideHud,
		onCancelRecording,
		formatTime,
		t,
	]);

	return memoizedControls;
};

const HISTOGRAM_BARS = [18, 34, 48, 66, 42, 58, 76, 92, 68, 54, 82, 62, 44, 70];

function RecordingAudioHistogram({ level }: { level: number }) {
	const clampedLevel = Math.max(0, Math.min(100, level || 0));
	const normalizedLevel = clampedLevel / 100;
	const levelSeed = Math.round(clampedLevel * 10);

	return (
		<div className={styles.recordingAudioHistogram} aria-hidden="true">
			{HISTOGRAM_BARS.map((baseHeight, index) => {
				const wave =
					Math.sin(levelSeed * 0.17 + index * 1.37) * 0.5 +
					Math.sin(levelSeed * 0.07 + index * 0.73) * 0.5;
				const activeHeight = Math.max(
					12,
					Math.min(96, baseHeight * (0.35 + normalizedLevel) + wave * 18),
				);
				const idleHeight = Math.max(8, baseHeight * 0.18);
				const active = clampedLevel > 2;

				return (
					<span
						key={`${baseHeight}-${index}`}
						className={active ? styles.recordingAudioBarActive : ""}
						style={{
							height: `${active ? activeHeight : idleHeight}%`,
							transitionDelay: `${index * 8}ms`,
							animationDelay: `${index * 34}ms`,
						}}
					/>
				);
			})}
		</div>
	);
}
