import { describe, expect, it } from "vitest";
import type { AutomationJobView } from "../../../shared/jobAutomation";
import {
	formatJobPanelError,
	getJobPanelActions,
	getJobPanelNotice,
	hasSavedJobResult,
	jobNeedsAttention,
	selectJobsForPanel,
} from "./jobsPresenter";

function job(id: string, state: AutomationJobView["state"], terminal = true): AutomationJobView {
	return {
		id,
		state,
		terminal,
		kind: "export",
		version: 1,
		revision: 1,
		createdAt: "2026-10-25T00:00:00Z",
		updatedAt: "2026-10-25T00:00:00Z",
		cancellationAllowed: true,
		progress: { phase: state },
		checkpoint: { artifactPath: "/tmp/artifact.mp4" },
	};
}
describe("jobs panel safety and visibility", () => {
	it("never offers incomplete artifacts or cancellation after publication begins", () => {
		const active = job("active", "running", false);
		active.cancellationAllowed = false;
		expect(getJobPanelActions(active)).toEqual({ cancel: false, retry: false, save: false });
		expect(getJobPanelActions(job("failed", "failed"))).toEqual({
			cancel: false,
			retry: true,
			save: true,
		});
		expect(getJobPanelActions(job("done", "succeeded"))).toEqual({
			cancel: false,
			retry: false,
			save: true,
		});
	});
	it("hides consumed artifacts and allows explicitly retrying cancelled work", () => {
		const published = job("published", "succeeded");
		published.checkpoint = {
			artifactPath: "/tmp/already-removed.mp4",
			retained: false,
			publishedPath: "/tmp/final.mp4",
		};
		expect(getJobPanelActions(published)).toEqual({ cancel: false, retry: false, save: false });
		expect(getJobPanelActions(job("cancelled", "cancelled"))).toEqual({
			cancel: false,
			retry: true,
			save: true,
		});
		const missing = job("missing", "failed");
		missing.checkpoint = { retained: true };
		expect(getJobPanelActions(missing).save).toBe(false);
	});

	it("replaces a recovered publication error with saved status without losing its historical state", () => {
		const recovered = job("failed-publication", "failed");
		recovered.error = {
			code: "TARGET_CHANGED",
			message: "Raw English error asking to save retained result",
		};
		recovered.checkpoint = {
			artifactPath: "/tmp/removed.mp4",
			retained: false,
			publishedPath: "/tmp/final.mp4",
			consumedBy: "save-job",
		};
		expect(hasSavedJobResult(recovered)).toBe(true);
		expect(jobNeedsAttention(recovered)).toBe(false);
		expect(getJobPanelActions(recovered)).toEqual({ cancel: false, retry: false, save: false });
		expect(getJobPanelNotice(recovered, "ru")).toEqual({
			message: "Результат уже сохранён.",
			tone: "success",
		});
		expect(recovered.state).toBe("failed");
		const pending = job("unresolved", "failed");
		pending.error = recovered.error;
		expect(jobNeedsAttention(pending)).toBe(true);
		expect(getJobPanelNotice(pending, "ru").message).toContain("Сохраните готовый результат");
	});
	it("renders expected cancellation neutrally and localizes actionable destination errors", () => {
		const cancelled = job("cancelled", "cancelled");
		cancelled.error = { code: "CANCELLED", message: "Job cancellation was requested." };
		expect(getJobPanelNotice(cancelled, "ru")).toEqual({
			message: "Задача отменена.",
			tone: "muted",
		});
		expect(jobNeedsAttention(cancelled)).toBe(false);
		expect(
			formatJobPanelError({ code: "TARGET_CHANGED", message: "raw" }, "en", true),
		).toContain("Save the finished result");
		expect(
			formatJobPanelError({ code: "TARGET_CHANGED", message: "raw" }, "ru", false),
		).toContain("Выберите другой файл");
	});
	it("keeps actionable details for unknown failures and does not suppress unresolved interruptions", () => {
		const failed = job("unknown", "failed");
		failed.error = {
			code: "DISK_SPECIFIC_FAILURE",
			message: "Cannot write /Volumes/Archive: disk quota exceeded. Free space and retry.",
		};
		expect(getJobPanelNotice(failed, "ru")).toEqual({
			message: failed.error.message,
			tone: "error",
		});
		const interrupted = job("interrupted", "interrupted");
		interrupted.error = { code: "WORKER_INTERRUPTED", message: "Worker exited" };
		expect(jobNeedsAttention(interrupted)).toBe(true);
		expect(getJobPanelNotice(interrupted, "ru").message).toContain("запустить повторно");
		expect(hasSavedJobResult({ ...failed, checkpoint: { retained: false } })).toBe(false);
	});

	it("keeps all active jobs visible even when terminal history is capped", () => {
		const visible = selectJobsForPanel(
			[
				job("old", "succeeded"),
				job("active-1", "running", false),
				job("active-2", "queued", false),
				job("error", "failed"),
			],
			1,
		);
		expect(visible.map((item) => item.id)).toEqual(["active-1", "active-2", "old"]);
	});
});
