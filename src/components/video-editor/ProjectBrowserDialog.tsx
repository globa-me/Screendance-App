import { MagnifyingGlass } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/contexts/I18nContext";
import { toFileUrl } from "./projectPersistence";

export type ProjectLibraryEntry = {
	path: string;
	name: string;
	updatedAt: number;
	thumbnailPath: string | null;
	isCurrent: boolean;
	isInProjectsDirectory: boolean;
};

type ProjectBrowserDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	entries: ProjectLibraryEntry[];
	onOpenProject: (projectPath: string) => void;
	anchorRef?: React.RefObject<HTMLElement | null>;
	preferredDirection?: "up" | "down" | "auto";
	onPanelHeightChange?: (height: number) => void;
	renderMode?: "floating" | "inline";
};
export default function ProjectBrowserDialog({
	open,
	onOpenChange,
	entries,
	onOpenProject,
	anchorRef,
	preferredDirection = "auto",
	onPanelHeightChange,
	renderMode = "floating",
}: ProjectBrowserDialogProps) {
	const { locale, t } = useI18n();
	const panelRef = useRef<HTMLDivElement | null>(null);
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	const [position, setPosition] = useState({ top: 72, left: 16, maxHeight: 360 });
	const [query, setQuery] = useState("");
	const visibleEntries = useMemo(() => {
		const normalizedQuery = query.trim().toLocaleLowerCase(locale);
		if (!normalizedQuery) return entries;
		return entries.filter((entry) =>
			entry.name.toLocaleLowerCase(locale).includes(normalizedQuery),
		);
	}, [entries, locale, query]);
	const dateFormatter = useMemo(
		() =>
			new Intl.DateTimeFormat(locale, {
				dateStyle: "medium",
				timeStyle: "short",
			}),
		[locale],
	);
	const formatProjectName = useCallback(
		(name: string) => {
			const match = /^recording-(\d+)$/.exec(name);
			if (!match) return name;
			const timestamp = Number(match[1]);
			if (!Number.isFinite(timestamp)) return name;
			return t("editor.project.recordingFrom", "Recording · {{date}}", {
				date: dateFormatter.format(new Date(timestamp)),
			});
		},
		[dateFormatter, t],
	);

	const updatePosition = useCallback(() => {
		if (typeof window === "undefined") {
			return;
		}

		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;
		const margin = 12;
		const gap = 8;
		const fallbackMaxHeight = Math.min(360, viewportHeight - margin * 2);
		const panelWidth = Math.min(280, Math.max(248, viewportWidth - margin * 2));
		const panelHeight = panelRef.current?.offsetHeight ?? fallbackMaxHeight;
		const anchorRect = anchorRef?.current?.getBoundingClientRect();
		const availableAbove = anchorRect
			? Math.max(120, anchorRect.top - margin - gap)
			: fallbackMaxHeight;
		const availableBelow = anchorRect
			? Math.max(120, viewportHeight - anchorRect.bottom - margin - gap)
			: fallbackMaxHeight;
		const direction =
			preferredDirection === "auto"
				? availableAbove > availableBelow
					? "up"
					: "down"
				: preferredDirection;
		const maxHeight = Math.min(
			fallbackMaxHeight,
			direction === "up" ? availableAbove : availableBelow,
		);

		const nextTop = anchorRect
			? direction === "up"
				? Math.max(margin, anchorRect.top - Math.min(panelHeight, maxHeight) - gap)
				: Math.min(
						anchorRect.bottom + gap,
						Math.max(
							margin,
							viewportHeight - Math.min(panelHeight, maxHeight) - margin,
						),
					)
			: Math.min(
					56,
					Math.max(margin, viewportHeight - Math.min(panelHeight, maxHeight) - margin),
				);
		const alignedLeft = anchorRect
			? anchorRect.right - panelWidth
			: viewportWidth - panelWidth - 16;

		setPosition({
			top: Math.max(margin, nextTop),
			left: Math.max(margin, Math.min(alignedLeft, viewportWidth - panelWidth - margin)),
			maxHeight,
		});
	}, [anchorRef, preferredDirection]);

	useEffect(() => {
		if (!open) {
			setQuery("");
			return;
		}

		updatePosition();
		window.requestAnimationFrame(() => searchInputRef.current?.focus());

		const handleViewportChange = () => updatePosition();
		window.addEventListener("resize", handleViewportChange);
		window.addEventListener("scroll", handleViewportChange, true);

		return () => {
			window.removeEventListener("resize", handleViewportChange);
			window.removeEventListener("scroll", handleViewportChange, true);
		};
	}, [open, updatePosition]);

	useEffect(() => {
		if (!open) {
			return;
		}

		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) {
				return;
			}

			if (panelRef.current?.contains(target) || anchorRef?.current?.contains(target)) {
				return;
			}

			onOpenChange(false);
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onOpenChange(false);
			}
		};

		document.addEventListener("pointerdown", handlePointerDown);
		window.addEventListener("keydown", handleKeyDown);

		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [anchorRef, onOpenChange, open]);

	useEffect(() => {
		if (!open) {
			onPanelHeightChange?.(0);
			return;
		}

		onPanelHeightChange?.(panelRef.current?.offsetHeight ?? 0);

		if (!panelRef.current || !onPanelHeightChange || typeof ResizeObserver === "undefined") {
			return;
		}

		const observer = new ResizeObserver(() => {
			onPanelHeightChange(panelRef.current?.offsetHeight ?? 0);
		});
		observer.observe(panelRef.current);

		return () => {
			observer.disconnect();
			onPanelHeightChange(0);
		};
	}, [onPanelHeightChange, open]);

	if (!open) {
		return null;
	}

	const header = (
		<>
			<div className="flex items-center justify-between border-b border-foreground/10 px-3 py-2.5">
				<div className="text-sm font-medium tracking-tight text-foreground">
					{t("editor.project.projects", "Projects")}
				</div>
				<span className="text-[11px] tabular-nums text-muted-foreground">
					{visibleEntries.length}/{entries.length}
				</span>
			</div>
			<label className="mx-2.5 mt-2.5 flex h-9 items-center gap-2 rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 text-muted-foreground focus-within:border-[#2563EB]/50 focus-within:ring-2 focus-within:ring-[#2563EB]/20">
				<MagnifyingGlass className="h-4 w-4 shrink-0" aria-hidden="true" />
				<input
					ref={searchInputRef}
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t("editor.project.search", "Search projects")}
					aria-label={t("editor.project.search", "Search projects")}
					className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
				/>
			</label>
		</>
	);

	const projectGrid = (
		<div className="grid grid-cols-2 gap-2">
			{visibleEntries.map((entry) => {
				const thumbnailSrc = entry.thumbnailPath ? toFileUrl(entry.thumbnailPath) : null;
				const displayName = formatProjectName(entry.name);
				const updatedLabel = dateFormatter.format(new Date(entry.updatedAt));
				return (
					<button
						key={entry.path}
						type="button"
						onClick={() => onOpenProject(entry.path)}
						title={`${displayName}\n${updatedLabel}`}
						className="group flex min-w-0 flex-col gap-1 rounded-lg bg-transparent p-0.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 focus-visible:ring-offset-editor-surface"
					>
						<div className="relative aspect-[16/10] w-full overflow-hidden rounded-[5px] bg-editor-dialog-alt shadow-[0_10px_18px_rgba(0,0,0,0.28)] transition duration-200 group-hover:-translate-y-0.5 group-hover:shadow-[0_16px_30px_rgba(0,0,0,0.38)]">
							{thumbnailSrc ? (
								<img
									src={thumbnailSrc}
									alt=""
									className="h-full w-full object-cover"
									draggable={false}
								/>
							) : (
								<div className="flex h-full w-full items-center justify-center bg-editor-bg px-2 text-center text-[10px] font-medium text-muted-foreground">
									{t("editor.project.noPreview", "No preview yet")}
								</div>
							)}
							{entry.isCurrent ? (
								<span className="absolute right-1.5 top-1.5 rounded-[5px] bg-[#2563EB] px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.14em] text-white">
									{t("editor.project.current", "Current")}
								</span>
							) : null}
						</div>
						<div className="min-w-0 px-0.5 py-0.5">
							<div className="truncate text-[11px] font-semibold tracking-tight text-foreground">
								{displayName}
							</div>
							<div className="truncate text-[10px] tabular-nums text-muted-foreground">
								{updatedLabel}
							</div>
						</div>
					</button>
				);
			})}
		</div>
	);

	if (renderMode === "inline") {
		return (
			<div
				ref={panelRef}
				role="dialog"
				aria-label="Projects"
				className="pointer-events-auto mb-1.5 w-[300px] max-h-[400px] overflow-hidden rounded-[14px] border border-foreground/[0.07] bg-editor-panel/[0.96] text-foreground shadow-[0_12px_32px_rgba(0,0,0,0.22),0_2px_10px_rgba(0,0,0,0.1)] animate-in fade-in-0 duration-150"
			>
				{header}
				<div className="max-h-[360px] overflow-y-auto px-2.5 py-2.5">
					{visibleEntries.length > 0 ? (
						projectGrid
					) : (
						<div className="flex min-h-[140px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-foreground/10 bg-editor-bg px-4 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
							<div className="text-sm font-semibold text-foreground">
								{query
									? t("editor.project.noSearchResults", "No matching projects")
									: t("editor.project.noProjects", "No saved projects yet")}
							</div>
						</div>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="pointer-events-none fixed inset-0 z-[90]">
			<div
				ref={panelRef}
				role="dialog"
				aria-label={t("editor.project.projects", "Projects")}
				style={{ top: `${position.top}px`, left: `${position.left}px` }}
				className="pointer-events-auto fixed w-[min(280px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-foreground/10 bg-editor-surface text-foreground shadow-2xl animate-in fade-in-0 duration-150"
			>
				{header}
				<div
					className="overflow-y-auto px-2.5 py-2.5"
					style={{ maxHeight: `${position.maxHeight}px` }}
				>
					{visibleEntries.length > 0 ? (
						projectGrid
					) : (
						<div className="flex min-h-[140px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-foreground/10 bg-editor-bg px-4 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
							<div className="text-sm font-semibold text-foreground">
								{query
									? t("editor.project.noSearchResults", "No matching projects")
									: t("editor.project.noProjects", "No saved projects yet")}
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
