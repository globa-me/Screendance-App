import * as React from "react";
import { MonitorIcon, AppWindowIcon, CaretUpIcon } from "@phosphor-icons/react";
import {
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
	mapRawSource,
	isScreenSource,
	isWindowSource,
	type DesktopSource,
} from "./popovers/launchPopoverTypes";
import "./launchTheme.css";
import "./SourceSelector.css";
import { HudInteractionContext } from "./contexts/HudInteractionContext";

const useSafeLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface SourceSelectorProps {
	/** List of available screen sources */
	screenSources?: DesktopSource[];
	/** List of available window sources */
	windowSources?: DesktopSource[];
	/** Currently selected source name */
	selectedSource?: string;
	/** Currently selected source id; preferred over the name when present */
	selectedSourceId?: string | null;
	/** Loading state */
	loading?: boolean;
	/** Callback when a source is selected */
	onSourceSelect?: (source: DesktopSource) => void;
	/** Callback to fetch sources */
	onFetchSources?: () => Promise<void>;
	/** Whether the popover is open */
	open?: boolean;
	/** Callback when open state changes */
	onOpenChange?: (open: boolean) => void;
	/** Optional custom trigger element */
	children?: React.ReactNode;
}

export function MarqueeText({ text }: { text: string }) {
	const staticRef = useRef<HTMLSpanElement>(null);
	const [overflowing, setOverflowing] = useState(false);
	useSafeLayoutEffect(() => {
		const node = staticRef.current;
		if (!node) return;
		const checkOverflow = () => {
			setOverflowing(node.scrollWidth > node.clientWidth + 1);
		};
		checkOverflow();
		const observer = new ResizeObserver(checkOverflow);
		observer.observe(node);
		return () => observer.disconnect();
	}, [text]);

	return (
		<div
			className="w-full source-selector-marquee"
			data-overflowing={overflowing ? "true" : "false"}
		>
			<span ref={staticRef} className="source-selector-marquee-static">
				{text}
			</span>
			<span className="source-selector-marquee-animated" aria-hidden="true">
				<span className="source-selector-marquee-track">
					<span className="source-selector-marquee-segment">{text}</span>
					<span className="source-selector-marquee-segment source-selector-marquee-duplicate">
						{text}
					</span>
				</span>
			</span>
		</div>
	);
}

function SourceThumbnail({ source }: { source: DesktopSource }) {
	const [failed, setFailed] = useState(false);
	const hasThumbnail = Boolean(source.thumbnail) && !failed;
	return (
		<div className="source-selector-thumb relative w-full aspect-video rounded-[9px] overflow-hidden flex items-center justify-center">
			{hasThumbnail ? (
				<img
					src={source.thumbnail ?? undefined}
					alt=""
					draggable={false}
					className="w-full h-full object-contain"
					onError={() => setFailed(true)}
				/>
			) : source.sourceType === "window" && source.appIcon ? (
				<img src={source.appIcon} alt="" draggable={false} className="w-9 h-9 opacity-80" />
			) : source.sourceType === "window" ? (
				<AppWindowIcon className="w-7 h-7 source-selector-muted" aria-hidden="true" />
			) : (
				<MonitorIcon className="w-7 h-7 source-selector-muted" aria-hidden="true" />
			)}
			{hasThumbnail && source.sourceType === "window" && source.appIcon ? (
				<img
					src={source.appIcon}
					alt=""
					draggable={false}
					className="absolute left-1.5 bottom-1.5 w-5 h-5 drop-shadow"
				/>
			) : null}
		</div>
	);
}

export function isSourceSelected(
	source: Pick<DesktopSource, "id" | "name">,
	selectedSource: string,
	selectedSourceId?: string | null,
): boolean {
	if (selectedSourceId) {
		return source.id === selectedSourceId;
	}
	return selectedSource === source.name;
}

/**
 * Lazily attaches native thumbnails to sources that arrived without one
 * (macOS enumerates windows natively and captures previews separately).
 */
function useSourceThumbnails(sources: DesktopSource[], enabled: boolean): DesktopSource[] {
	const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
	const missingKey = useMemo(
		() =>
			sources
				.filter((source) => !source.thumbnail)
				.map((source) => source.id)
				.sort()
				.join("|"),
		[sources],
	);

	// Re-capture whenever the source list is refetched (each time the picker
	// opens) so previews stay current; `missingKey` alone would skip that.
	useEffect(() => {
		if (!enabled || !missingKey || !window.electronAPI?.getSourceThumbnails) {
			return;
		}
		let cancelled = false;
		const requested = sources
			.filter((source) => !source.thumbnail)
			.map((source) => ({
				id: source.id,
				display_id: source.display_id,
				sourceType: source.sourceType,
			}));
		void window.electronAPI
			.getSourceThumbnails({ sources: requested, thumbnailSize: { width: 320, height: 180 } })
			.then((result) => {
				if (!cancelled && result && Object.keys(result).length > 0) {
					setThumbnails((previous) => ({ ...previous, ...result }));
				}
			})
			.catch((error) => {
				console.warn("Failed to load source thumbnails:", error);
			});
		return () => {
			cancelled = true;
		};
	}, [enabled, missingKey, sources]);

	return useMemo(
		() =>
			sources.map((source) =>
				!source.thumbnail && thumbnails[source.id]
					? { ...source, thumbnail: thumbnails[source.id] }
					: source,
			),
		[sources, thumbnails],
	);
}

/**
 * SourceSelectorContent - The actual list of sources
 */
export const SourceSelectorContent = ({
	screenSources = [],
	windowSources = [],
	selectedSource = "Screen",
	selectedSourceId = null,
	loading = false,
	onSourceSelect = () => {},
}: Pick<
	SourceSelectorProps,
	| "screenSources"
	| "windowSources"
	| "selectedSource"
	| "selectedSourceId"
	| "loading"
	| "onSourceSelect"
>) => {
	const t = useScopedT("launch");
	const renderSourceItem = (source: DesktopSource, index: number) => {
		const isSelected = isSourceSelected(source, selectedSource, selectedSourceId);
		const title = source.windowTitle || source.name;
		const subtitle =
			source.sourceType === "screen"
				? t("recording.screen")
				: source.appName && source.appName !== title
					? source.appName
					: t("recording.window");
		return (
			<button
				key={`${source.id}-${index}`}
				type="button"
				title={source.appName ? `${source.appName} — ${title}` : title}
				aria-pressed={isSelected}
				className={cn(
					"source-selector-item group w-full min-w-0 rounded-[12px] p-1.5 text-left font-medium flex flex-col items-stretch gap-1.5",
					isSelected && "source-selector-item-selected",
				)}
				onClick={() => onSourceSelect(source)}
			>
				<SourceThumbnail source={source} />
				<div className="min-w-0 px-1 pb-0.5 flex flex-col items-start text-left">
					<div className="text-[12px] font-medium source-selector-text w-full">
						<MarqueeText text={title} />
					</div>
					<div className="text-[10px] source-selector-subtle truncate w-full text-left">
						{subtitle}
					</div>
				</div>
			</button>
		);
	};

	const hasAnySources = screenSources.length > 0 || windowSources.length > 0;

	if (loading && !hasAnySources) {
		return (
			<div className="flex items-center justify-center py-8">
				<div className="animate-spin rounded-full h-5 w-5 border-b-2 source-selector-accent-border" />
			</div>
		);
	}

	return (
		<div className="max-h-[min(460px,70vh)] overflow-y-auto overflow-x-hidden p-2 source-selector-scroll">
			{hasAnySources ? (
				<>
					{screenSources.length > 0 ? (
						<div className="space-y-1">
							<div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] source-selector-label flex items-center gap-2">
								{t("recording.screens")}
								<span
									className={cn(
										"normal-case tracking-normal text-[10px] source-selector-muted transition-opacity duration-150",
										loading ? "opacity-100" : "opacity-0",
									)}
								>
									{t("common.loading", "Refreshing...")}
								</span>
							</div>
							<div className="grid grid-cols-2 gap-1">
								{screenSources.map((source, index) =>
									renderSourceItem(source, index),
								)}
							</div>
						</div>
					) : null}
					{windowSources.length > 0 ? (
						<div className="space-y-1">
							<div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] source-selector-label">
								{t("recording.windows")}
							</div>
							<div className="grid grid-cols-2 gap-1">
								{windowSources.map((source, index) =>
									renderSourceItem(source, index),
								)}
							</div>
						</div>
					) : null}
				</>
			) : (
				<div className="text-center py-8 text-sm source-selector-muted">
					{t("recording.noSourcesFound")}
				</div>
			)}
		</div>
	);
};

/**
 * SourceSelector - A rich source selection component with thumbnails
 * Uses Radix UI Popover for positioning and accessibility
 */
export const SourceSelector = React.memo(function SourceSelector({
	screenSources: propsScreenSources,
	windowSources: propsWindowSources,
	selectedSource: propsSelectedSource,
	selectedSourceId: propsSelectedSourceId,
	loading: propsLoading,
	onSourceSelect: propsOnSourceSelect,
	onFetchSources: propsOnFetchSources,
	open: propsOpen,
	onOpenChange: propsOnOpenChange,
	children,
}: SourceSelectorProps) {
	// Internal state for standalone/uncontrolled use
	const [internalOpen, setInternalOpen] = useState(false);
	const [internalSources, setInternalSources] = useState<DesktopSource[]>([]);
	const [internalLoading, setInternalLoading] = useState(false);
	const [internalSelectedSource, setInternalSelectedSource] = useState("Screen");
	const [internalSelectedSourceId, setInternalSelectedSourceId] = useState<string | null>(null);

	// Determine if we should use internal or external state/logic
	const isAutonomous = propsOpen === undefined;
	const open = propsOpen ?? internalOpen;
	const onOpenChange = propsOnOpenChange ?? setInternalOpen;
	const loading = propsLoading ?? internalLoading;
	const selectedSource = propsSelectedSource ?? internalSelectedSource;
	const selectedSourceId =
		propsSelectedSourceId !== undefined ? propsSelectedSourceId : internalSelectedSourceId;

	// Default fetching logic
	const defaultFetchSources = useCallback(async () => {
		if (!window.electronAPI) return;
		setInternalLoading(true);
		try {
			const rawSources = await window.electronAPI.getSources({
				types: ["screen", "window"],
				thumbnailSize: { width: 160, height: 90 },
				fetchWindowIcons: true,
			});
			setInternalSources(rawSources.map((s) => mapRawSource(s as DesktopSource)));
		} catch (error) {
			console.error("Failed to fetch sources:", error);
		} finally {
			setInternalLoading(false);
		}
	}, []);

	const onFetchSources = propsOnFetchSources ?? defaultFetchSources;

	// Default selection logic
	const onSourceSelect = useCallback(
		async (source: DesktopSource) => {
			if (propsOnSourceSelect) {
				propsOnSourceSelect(source);
				return;
			}
			if (!window.electronAPI) return;
			try {
				const result = await window.electronAPI.selectSource(source);
				if (result) {
					setInternalSelectedSource(source.name);
					setInternalSelectedSourceId(source.id);
				}
			} catch (error) {
				console.error("Failed to select source:", error);
			}
		},
		[propsOnSourceSelect],
	);

	// Split sources for internal use
	const internalScreenSources = useMemo(
		() => internalSources.filter(isScreenSource),
		[internalSources],
	);
	const internalWindowSources = useMemo(
		() => internalSources.filter(isWindowSource),
		[internalSources],
	);

	const screenSources = useSourceThumbnails(propsScreenSources ?? internalScreenSources, open);
	const windowSources = useSourceThumbnails(propsWindowSources ?? internalWindowSources, open);

	const hasPrefetchedRef = useRef(false);
	const fetchInFlightRef = useRef(false);
	const lastFetchedAtRef = useRef(0);

	const fetchSourcesOnce = useCallback(
		async (allowRecentSkip: boolean) => {
			if (fetchInFlightRef.current) {
				return;
			}
			if (allowRecentSkip && Date.now() - lastFetchedAtRef.current < 750) {
				return;
			}
			fetchInFlightRef.current = true;
			try {
				await onFetchSources();
				lastFetchedAtRef.current = Date.now();
			} finally {
				fetchInFlightRef.current = false;
			}
		},
		[onFetchSources],
	);

	const prefetchSources = React.useCallback(() => {
		if (hasPrefetchedRef.current) {
			return;
		}
		hasPrefetchedRef.current = true;
		void fetchSourcesOnce(false);
	}, [fetchSourcesOnce]);

	// Fetch sources when popover opens
	useEffect(() => {
		if (open) {
			void fetchSourcesOnce(true);
		}
	}, [open, fetchSourcesOnce]);

	// In autonomous mode, we might want to start open
	useEffect(() => {
		if (isAutonomous) {
			setInternalOpen(true);
		}
	}, [isAutonomous]);

	const trigger = children ? (
		React.isValidElement(children) ? (
			React.cloneElement(children as React.ReactElement<React.HTMLAttributes<HTMLElement>>, {
				onPointerEnter: prefetchSources,
				onFocusCapture: prefetchSources,
			})
		) : (
			children
		)
	) : (
		<Button
			variant="outline"
			size="lg"
			onPointerEnter={prefetchSources}
			onFocusCapture={prefetchSources}
			className={cn(
				"group gap-2 px-3 min-w-0 max-w-[180px] rounded-[11px] font-medium text-[12px] [ -webkit-app-region:no-drag ] shrink-0",
				"border-[#2a2a34] bg-[#1a1a22] text-[#eeeef2] hover:border-[#3e3e4c] hover:bg-[#20202a] transition-all",
				"data-[state=open]:border-[#3e3e4c] data-[state=open]:bg-[#20202a]",
			)}
			title={selectedSource}
		>
			<MonitorIcon size={16} className="shrink-0" />
			<div className="flex-1 min-w-0">
				<MarqueeText text={selectedSource} />
			</div>
			<CaretUpIcon
				size={10}
				className={cn(
					"text-[#6b6b78] ml-0.5 shrink-0 transition-transform duration-200",
					open ? "" : "rotate-180",
				)}
			/>
		</Button>
	);

	const onMouseEnter = useContext(HudInteractionContext)?.onMouseEnter;

	return (
		<Popover open={open} onOpenChange={onOpenChange} modal={false}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent
				className="launch-theme w-[400px] max-w-[calc(100vw-20px)] p-0 source-selector-popover"
				unstyled
				align="start"
				sideOffset={8}
				side="top"
				alignOffset={-8}
				avoidCollisions={true}
				collisionPadding={10}
				usePortal={false}
				onMouseEnter={onMouseEnter}
			>
				<SourceSelectorContent
					screenSources={screenSources}
					windowSources={windowSources}
					selectedSource={selectedSource}
					selectedSourceId={selectedSourceId}
					loading={loading}
					onSourceSelect={onSourceSelect}
				/>
			</PopoverContent>
		</Popover>
	);
});

SourceSelector.displayName = "SourceSelector";
