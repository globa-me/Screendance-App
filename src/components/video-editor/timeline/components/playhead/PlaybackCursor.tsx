import { useTimelineContext } from "dnd-timeline";
import { useEffect, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { useScopedT } from "@/contexts/I18nContext";
import { formatPlayheadTime } from "../../core/time";

interface PlaybackCursorProps {
	currentTimeMs: number;
	videoDurationMs: number;
	onSeek?: (time: number) => void;
	timelineRef: RefObject<HTMLDivElement>;
	keyframes?: { id: string; time: number }[];
	isLoading?: boolean;
}

export default function PlaybackCursor({
	currentTimeMs,
	videoDurationMs,
	onSeek,
	timelineRef,
	keyframes = [],
	isLoading = false,
}: PlaybackCursorProps) {
	const { sidebarWidth, direction, range, valueToPixels, pixelsToValue } = useTimelineContext();
	const t = useScopedT("timeline");
	const sideProperty = direction === "rtl" ? "right" : "left";
	const [isDragging, setIsDragging] = useState(false);

	useEffect(() => {
		if (!isDragging) return;

		const handleMouseMove = (e: MouseEvent) => {
			if (!timelineRef.current || !onSeek) return;
			const rect = timelineRef.current.getBoundingClientRect();
			const clickX = e.clientX - rect.left - sidebarWidth;
			const relativeMs = pixelsToValue(clickX);
			let absoluteMs = Math.max(0, Math.min(range.start + relativeMs, videoDurationMs));

			const snapThresholdMs = 150;
			const nearbyKeyframe = keyframes.find(
				(kf) =>
					Math.abs(kf.time - absoluteMs) <= snapThresholdMs &&
					kf.time >= range.start &&
					kf.time <= range.end,
			);
			if (nearbyKeyframe) absoluteMs = nearbyKeyframe.time;

			onSeek(absoluteMs / 1000);
		};

		const handleMouseUp = () => {
			setIsDragging(false);
			document.body.style.cursor = "";
		};

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);
		document.body.style.cursor = "ew-resize";

		return () => {
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
			document.body.style.cursor = "";
		};
	}, [
		isDragging,
		onSeek,
		timelineRef,
		sidebarWidth,
		range.start,
		range.end,
		videoDurationMs,
		pixelsToValue,
		keyframes,
	]);

	if (videoDurationMs <= 0 || currentTimeMs < 0) return null;
	const clampedTime = Math.min(currentTimeMs, videoDurationMs);
	if (clampedTime < range.start || clampedTime > range.end) return null;

	const offset = valueToPixels(clampedTime - range.start);

	return (
		<div
			className="absolute top-0 bottom-0 z-50 group/cursor"
			style={{
				[sideProperty === "right" ? "marginRight" : "marginLeft"]: `${sidebarWidth - 1}px`,
				pointerEvents: "none",
			}}
		>
			<div
				role="slider"
				tabIndex={onSeek ? 0 : -1}
				aria-label={t("playbackPosition", "Playback position")}
				aria-valuemin={0}
				aria-valuemax={Math.round(videoDurationMs / 1000)}
				aria-valuenow={Math.round(clampedTime / 1000)}
				aria-valuetext={formatPlayheadTime(clampedTime)}
				aria-orientation="horizontal"
				className="group/playhead absolute top-0 bottom-0 -translate-x-1/2 w-4 cursor-ew-resize pointer-events-auto focus-visible:outline-none"
				style={{ [sideProperty]: `${offset}px` }}
				onKeyDown={(event) => {
					if (!onSeek) return;
					let nextTimeMs: number;
					const stepMs = event.shiftKey ? 5000 : 1000;
					switch (event.key) {
						case "ArrowLeft": nextTimeMs = clampedTime - stepMs; break;
						case "ArrowRight": nextTimeMs = clampedTime + stepMs; break;
						case "Home": nextTimeMs = 0; break;
						case "End": nextTimeMs = videoDurationMs; break;
						default: return;
					}
					event.preventDefault();
					event.stopPropagation();
					onSeek(Math.max(0, Math.min(nextTimeMs, videoDurationMs)) / 1000);
				}}
				onMouseDown={(e) => {
					e.stopPropagation();
					setIsDragging(true);
				}}
			>
				<div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 bg-[#2563EB] shadow-[0_0_10px_rgba(37,99,235,0.5)] group-hover/playhead:shadow-[0_0_15px_rgba(37,99,235,0.7)]" />
				<div
					className="absolute -top-1 left-1/2 -translate-x-1/2 rounded-sm transition-transform hover:scale-125 group-focus-visible/playhead:ring-2 group-focus-visible/playhead:ring-white group-focus-visible/playhead:ring-offset-2 group-focus-visible/playhead:ring-offset-[#2563EB]"
					style={{ width: "16px", height: "16px" }}
				>
					<div className="w-3 h-3 mx-auto mt-[2px] bg-[#2563EB] rotate-45 rounded-sm shadow-lg border border-foreground/20" />
				</div>
				<div
					className={cn(
						"absolute -top-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-black/80 text-[10px] text-white/90 font-medium tabular-nums whitespace-nowrap border border-foreground/10 shadow-lg pointer-events-none transition-opacity",
						(isDragging || isLoading) ? "opacity-100" : "opacity-0",
					)}
				>
					<div className="flex items-center">
						{formatPlayheadTime(clampedTime).split("").map((char, i) => (
							<span
								key={i}
								className={cn(
									"leading-5 whitespace-pre",
									isLoading && "bg-gradient-to-r from-white/40 via-white to-white/40 bg-clip-text text-transparent animate-text-shimmer"
								)}
								style={isLoading ? {
									animationDelay: `${i * 0.05}s`,
									animationDuration: "2.5s",
								} : undefined}
							>
								{char}
							</span>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
