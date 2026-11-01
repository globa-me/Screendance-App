import type { AutomationErrorData } from "../../../shared/automationErrors";
import type { AutomationJobView } from "../../../shared/jobAutomation";

/** Retained artifacts are never offered while a worker can still be writing them. */
export function getJobPanelActions(job: AutomationJobView) {
	return {
		cancel: !job.terminal && job.state !== "cancelling" && job.cancellationAllowed,
		retry:
			job.terminal &&
			!hasSavedJobResult(job) &&
			["failed", "interrupted", "cancelled"].includes(job.state),
		save:
			job.terminal &&
			["export", "export.save"].includes(job.kind) &&
			job.checkpoint?.retained !== false &&
			typeof job.checkpoint?.artifactPath === "string" &&
			job.checkpoint.artifactPath.length > 0,
	};
}
export function selectJobsForPanel(
	jobs: AutomationJobView[],
	historyLimit = 10,
): AutomationJobView[] {
	const sorted = [...jobs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	return [
		...sorted.filter((job) => !job.terminal),
		...sorted.filter((job) => job.terminal).slice(0, historyLimit),
	];
}

/** A later Save job can recover a failed publication without rewriting its historical state. */
export function hasSavedJobResult(job: AutomationJobView): boolean {
	return (
		job.terminal &&
		job.checkpoint?.retained === false &&
		typeof job.checkpoint.publishedPath === "string" &&
		job.checkpoint.publishedPath.length > 0
	);
}
export function jobNeedsAttention(job: AutomationJobView): boolean {
	return !hasSavedJobResult(job) && (job.state === "failed" || job.state === "interrupted");
}
export function formatJobPanelError(
	error: Pick<AutomationErrorData, "message"> & { code?: string },
	locale: string,
	canSave = false,
): string {
	const ru = locale === "ru";
	const known: Record<string, [string, string]> = {
		TARGET_CHANGED: canSave
			? [
					"The destination changed while exporting. Save the finished result to another file.",
					"Файл назначения изменился во время экспорта. Сохраните готовый результат в другой файл.",
				]
			: [
					"The destination changed. Choose another file and retry.",
					"Файл назначения изменился. Выберите другой файл и повторите попытку.",
				],
		CANCELLED: ["Task cancelled.", "Задача отменена."],
		WORKER_INTERRUPTED: [
			"The app or editor closed before the task finished. You can retry it.",
			"Приложение или редактор закрылся до завершения задачи. Её можно запустить повторно.",
		],
		APP_CLOSING: [
			"The app closed before the task finished. You can retry it.",
			"Приложение закрылось до завершения задачи. Её можно запустить повторно.",
		],
		SOURCE_CHANGED: [
			"A source file changed or became unavailable. Check the source and start a new task.",
			"Исходный файл изменился или стал недоступен. Проверьте источник и создайте новую задачу.",
		],
		TARGET_EXPIRED: [
			"Choose the output file again and retry the task.",
			"Выберите файл для сохранения заново и повторите задачу.",
		],
		NO_RETAINED_OUTPUT: [
			"The finished result is no longer available here. Start a new export if needed.",
			"Готовый результат больше не доступен в этой задаче. При необходимости запустите новый экспорт.",
		],
		BUSY: [
			"Wait for the other task to finish, then try again.",
			"Дождитесь завершения другой задачи и повторите попытку.",
		],
		ENCODER_UNAVAILABLE: [
			"The selected video encoder is unavailable. Try another export setting.",
			"Выбранный видеокодировщик недоступен. Попробуйте другие настройки экспорта.",
		],
		EMPTY_CAPTIONS: [
			"No speech was recognized. Check the audio source and recognition language.",
			"Речь не распознана. Проверьте звуковую дорожку и язык распознавания.",
		],
		PROJECT_CHANGED: [
			"The editor document changed. Read its current state before applying this result.",
			"Документ в редакторе изменился. Проверьте его текущее состояние перед применением результата.",
		],
		REVISION_CONFLICT: [
			"The editor changed while the task was running. Check it before applying the result.",
			"Редактор изменился во время выполнения задачи. Проверьте документ перед применением результата.",
		],
	};
	const message = error.code ? known[error.code] : undefined;
	return message ? message[ru ? 1 : 0] : error.message;
}
export function getJobPanelNotice(
	job: AutomationJobView,
	locale: string,
): { message: string | null; tone: "muted" | "error" | "success" } {
	if (hasSavedJobResult(job))
		return {
			message: locale === "ru" ? "Результат уже сохранён." : "The result has been saved.",
			tone: "success",
		};
	if (job.state === "cancelled" || job.error?.code === "CANCELLED")
		return {
			message: formatJobPanelError({ code: "CANCELLED", message: "" }, locale),
			tone: "muted",
		};
	return {
		message: job.error
			? formatJobPanelError(job.error, locale, getJobPanelActions(job).save)
			: null,
		tone: "error",
	};
}
