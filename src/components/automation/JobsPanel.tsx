import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/contexts/I18nContext";
import type { AutomationJobView } from "../../../shared/jobAutomation";
import {
	formatJobPanelError,
	getJobPanelActions,
	getJobPanelNotice,
	hasSavedJobResult,
	jobNeedsAttention,
	selectJobsForPanel,
} from "./jobsPresenter";

interface JobsPanelApi {
	getAutomationJobs(): Promise<{ jobs: AutomationJobView[] }>;
	cancelAutomationJob(id: string): Promise<AutomationJobView>;
	retryAutomationJob(id: string): Promise<AutomationJobView>;
	saveAutomationJob(id: string): Promise<AutomationJobView | { canceled: true }>;
	onAutomationJobsChanged?: (callback: () => void) => () => void;
}

/** Editor-only footer. Mount outside the canvas; no floating overlay is added to recordings. */
export function JobsPanel({ refreshToken }: { refreshToken?: unknown }) {
	const { t, locale } = useI18n();
	const ru = locale === "ru";
	const label = (key: string, english: string, russian: string) =>
		t(`editor.jobs.${key}`, ru ? russian : english);
	const api = window.electronAPI as unknown as JobsPanelApi;
	const [expanded, setExpanded] = useState(false);
	const [jobs, setJobs] = useState<AutomationJobView[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<{
		id: string;
		message: string;
		code?: string;
	} | null>(null);
	const [busyAction, setBusyAction] = useState<string | null>(null);
	const actionInFlight = useRef(false);
	const mounted = useRef(true);
	const inFlight = useRef(false);
	const id = useId();
	const activeCount = jobs.filter((job) => !job.terminal).length;
	const refresh = useCallback(async () => {
		if (inFlight.current || typeof api.getAutomationJobs !== "function") return;
		inFlight.current = true;
		try {
			const result = await api.getAutomationJobs();
			if (mounted.current) {
				setJobs(result.jobs);
				setLoadError(null);
			}
		} catch (error) {
			if (mounted.current)
				setLoadError(error instanceof Error ? error.message : String(error));
		} finally {
			inFlight.current = false;
		}
	}, []);
	useEffect(() => {
		mounted.current = true;
		void refresh();
		const remove = api.onAutomationJobsChanged?.(() => {
			void refresh();
		});
		const onFocus = () => {
			void refresh();
		};
		window.addEventListener("focus", onFocus);
		return () => {
			mounted.current = false;
			remove?.();
			window.removeEventListener("focus", onFocus);
		};
	}, [refresh]);
	useEffect(() => {
		void refreshToken;
		void refresh();
	}, [refreshToken, refresh]);
	useEffect(() => {
		if (!expanded && activeCount === 0) return;
		void refresh();
		const timer = setInterval(() => {
			void refresh();
		}, 1000);
		return () => clearInterval(timer);
	}, [expanded, activeCount, refresh]);

	async function act(job: AutomationJobView, action: "cancel" | "retry" | "save") {
		if (actionInFlight.current) return;
		actionInFlight.current = true;
		setBusyAction(`${job.id}:${action}`);
		setActionError(null);
		try {
			if (action === "cancel") await api.cancelAutomationJob(job.id);
			else if (action === "retry") await api.retryAutomationJob(job.id);
			else await api.saveAutomationJob(job.id);
			await refresh();
		} catch (error) {
			if (mounted.current)
				setActionError({
					id: job.id,
					...(error &&
					typeof error === "object" &&
					"code" in error &&
					typeof error.code === "string"
						? { code: error.code }
						: {}),
					message: error instanceof Error ? error.message : String(error),
				});
		} finally {
			actionInFlight.current = false;
			if (mounted.current) setBusyAction(null);
		}
	}
	const stateLabel = (job: AutomationJobView) => {
		if (hasSavedJobResult(job))
			return label("states.saved", "Result saved", "Результат сохранён");
		const states: Record<AutomationJobView["state"], [string, string]> = {
			queued: ["Queued", "В очереди"],
			running: ["Running", "Выполняется"],
			cancelling: ["Cancelling…", "Отмена…"],
			succeeded: ["Completed", "Готово"],
			failed: ["Failed", "Ошибка"],
			cancelled: ["Cancelled", "Отменено"],
			interrupted: ["Interrupted", "Прервано"],
		};
		return label(`states.${job.state}`, ...states[job.state]);
	};
	const kindLabel = (job: AutomationJobView) => {
		const kinds: Record<AutomationJobView["kind"], [string, string]> = {
			export: ["Export", "Экспорт"],
			"export.save": ["Save export", "Сохранение экспорта"],
			"captions.generate": ["Captions", "Субтитры"],
			"models.download": ["Speech model", "Модель распознавания"],
		};
		return label(`kinds.${job.kind}`, ...kinds[job.kind]);
	};
	const visible = selectJobsForPanel(jobs);
	const buttonClass =
		"rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";
	return (
		<section
			className="shrink-0 border-t border-border bg-background text-foreground"
			aria-label={label("title", "Jobs", "Задачи")}
		>
			<div className="flex min-h-9 items-center justify-between px-3">
				<button
					type="button"
					className="flex items-center gap-2 rounded py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
					aria-expanded={expanded}
					aria-controls={id}
					onClick={() => setExpanded((current) => !current)}
				>
					<span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
					<span>{label("title", "Jobs", "Задачи")}</span>
					{activeCount > 0 && (
						<span className="rounded bg-primary/10 px-1.5 py-0.5 tabular-nums">
							{activeCount} {label("active", "active", "активных")}
						</span>
					)}
					{jobs.some(jobNeedsAttention) && (
						<span className="text-amber-500">
							{label("needsAttention", "Needs attention", "Требуется внимание")}
						</span>
					)}
				</button>
				{expanded && (
					<button
						type="button"
						className={buttonClass}
						onClick={() => {
							void refresh();
						}}
					>
						{label("refresh", "Refresh", "Обновить")}
					</button>
				)}
			</div>
			{expanded && (
				<div id={id} className="max-h-64 overflow-y-auto border-t border-border px-3 py-2">
					{loadError && (
						<p role="alert" className="mb-2 break-words text-xs text-destructive">
							{loadError}
						</p>
					)}
					{visible.length === 0 && (
						<p className="py-3 text-xs text-muted-foreground">
							{label("empty", "No background jobs yet.", "Фоновых задач пока нет.")}
						</p>
					)}
					<ul className="divide-y divide-border">
						{visible.map((job) => {
							const actions = getJobPanelActions(job);
							const notice = getJobPanelNotice(job, locale);
							const busy = busyAction !== null;
							const percentage =
								typeof job.progress.percentage === "number" &&
								Number.isFinite(job.progress.percentage)
									? Math.max(0, Math.min(100, job.progress.percentage))
									: undefined;
							return (
								<li key={job.id} className="py-2.5">
									<div className="flex items-start justify-between gap-3">
										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
												<strong>{kindLabel(job)}</strong>
												<span className="text-muted-foreground">
													{stateLabel(job)}
												</span>
												<span
													title={job.id}
													className="font-mono text-[10px] text-muted-foreground"
												>
													{job.id.slice(0, 8)}
												</span>
											</div>
											{!job.terminal && (
												<div className="mt-1.5 flex items-center gap-2">
													<progress
														className="h-1.5 w-full accent-primary"
														max={100}
														value={percentage}
														aria-label={kindLabel(job)}
													/>
													{percentage !== undefined && (
														<span className="text-[10px] tabular-nums text-muted-foreground">
															{Math.round(percentage)}%
														</span>
													)}
												</div>
											)}
											{job.progress.message && !job.terminal && (
												<p className="mt-1 break-words text-xs text-muted-foreground">
													{job.progress.message}
												</p>
											)}
											{notice.message && (
												<p
													className={`mt-1 break-words text-xs ${notice.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
												>
													{notice.message}
												</p>
											)}
											{hasSavedJobResult(job) && (
												<p className="mt-1 break-all text-xs text-muted-foreground">
													{String(job.checkpoint?.publishedPath)}
												</p>
											)}
											{actionError?.id === job.id && (
												<p
													role={
														actionError.code === "CANCELLED"
															? "status"
															: "alert"
													}
													className={`mt-1 break-words text-xs ${actionError.code === "CANCELLED" ? "text-muted-foreground" : "text-destructive"}`}
												>
													{formatJobPanelError(
														actionError,
														locale,
														actions.save,
													)}
												</p>
											)}
										</div>
										<div className="flex shrink-0 flex-wrap justify-end gap-1">
											{actions.cancel && (
												<button
													type="button"
													className={buttonClass}
													disabled={busy}
													onClick={() => {
														void act(job, "cancel");
													}}
												>
													{label("cancel", "Cancel", "Отменить")}
												</button>
											)}
											{actions.retry && (
												<button
													type="button"
													className={buttonClass}
													disabled={busy}
													onClick={() => {
														void act(job, "retry");
													}}
												>
													{label("retry", "Retry", "Повторить")}
												</button>
											)}
											{actions.save && (
												<button
													type="button"
													className={buttonClass}
													disabled={busy}
													onClick={() => {
														void act(job, "save");
													}}
												>
													{label(
														"save",
														"Save result…",
														"Сохранить результат…",
													)}
												</button>
											)}
										</div>
									</div>
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</section>
	);
}
