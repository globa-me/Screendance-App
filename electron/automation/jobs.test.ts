import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationError } from "../../shared/automation";
import type { JobJson } from "../../shared/jobAutomation";
import { AutomationJobManager } from "./jobs";

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
let directory: string;
let manager: AutomationJobManager;
const managers: AutomationJobManager[] = [];
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "sd-jobs-"));
	manager = new AutomationJobManager({ directory });
	managers.push(manager);
	await manager.initialize();
});
afterEach(async () => {
	await Promise.all(managers.splice(0).map((service) => service.close()));
	await fs.rm(directory, { force: true, recursive: true });
});

describe("durable application jobs", () => {
	it("persists frozen inputs before work and never exposes mutable snapshots in public views", async () => {
		const finish = deferred<JobJson>();
		const input = { outputPath: "/tmp/export.mp4" };
		const snapshot = { document: { padding: 10 }, settings: { format: "mp4" } };
		manager.registerRunner("export", async (context) => {
			expect(context.input).toEqual({ outputPath: "/tmp/export.mp4" });
			expect(context.snapshot).toEqual({
				document: { padding: 10 },
				settings: { format: "mp4" },
			});
			expect(Object.isFrozen(context.snapshot)).toBe(true);
			return finish.promise;
		});
		const job = await manager.create({ kind: "export", input, snapshot });
		input.outputPath = "/tmp/changed.mp4";
		snapshot.document.padding = 99;
		expect(job).not.toHaveProperty("snapshot");
		expect(job).not.toHaveProperty("input");
		const file = path.join(directory, `job-${job.id}.json`);
		const persisted = JSON.parse(await fs.readFile(file, "utf8"));
		expect(persisted.snapshot.document.padding).toBe(10);
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		finish.resolve({ outputPath: "/tmp/export.mp4" });
		await expect(manager.wait(job.id)).resolves.toMatchObject({
			state: "succeeded",
			terminal: true,
			result: { outputPath: "/tmp/export.mp4" },
		});
	});
	it("does not cancel work when a bounded wait ends or its caller leaves", async () => {
		const finish = deferred<JobJson>();
		manager.registerRunner("export", () => finish.promise);
		const job = await manager.create({ kind: "export", input: {} });
		const waited = await manager.wait(job.id, { timeoutMs: 1 });
		expect(waited.terminal).toBe(false);
		finish.resolve({ saved: true });
		await expect(manager.wait(job.id)).resolves.toMatchObject({
			state: "succeeded",
			result: { saved: true },
		});
	});
	it("keeps cancellation nonterminal until the worker confirms it has stopped", async () => {
		const cleaningUp = deferred<JobJson>();
		const began = deferred<void>();
		manager.registerRunner("captions.generate", async (context) => {
			began.resolve();
			context.signal.addEventListener("abort", () => {}, { once: true });
			return cleaningUp.promise;
		});
		const job = await manager.create({ kind: "captions.generate", input: {} });
		await began.promise;
		await expect(manager.cancel(job.id)).resolves.toMatchObject({
			state: "cancelling",
			terminal: false,
		});
		expect(manager.get(job.id)).toMatchObject({ state: "cancelling", terminal: false });
		cleaningUp.reject(new AutomationError("CANCELLED", "Child exited after cleanup"));
		await expect(manager.wait(job.id)).resolves.toMatchObject({
			state: "cancelled",
			terminal: true,
		});
	});
	it("cancels queued work without invoking it and respects worker concurrency", async () => {
		const firstDone = deferred<JobJson>();
		const run = vi.fn(async () => firstDone.promise);
		manager.registerRunner("export", run);
		const first = await manager.create({ kind: "export", input: {} });
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
		const second = await manager.create({ kind: "export", input: {} });
		expect(second.state).toBe("queued");
		await expect(manager.cancel(second.id)).resolves.toMatchObject({
			state: "cancelled",
			terminal: true,
		});
		firstDone.resolve({ saved: true });
		await manager.wait(first.id);
		expect(run).toHaveBeenCalledTimes(1);
	});
	it("refuses cancellation during irreversible publication and records its result", async () => {
		const committing = deferred<void>();
		const finish = deferred<JobJson>();
		manager.registerRunner("export", async (context) => {
			context.beginCommit();
			committing.resolve();
			return finish.promise;
		});
		const job = await manager.create({ kind: "export", input: {} });
		await committing.promise;
		await expect(manager.cancel(job.id)).rejects.toMatchObject({ code: "NOT_CANCELLABLE" });
		finish.resolve({ outputPath: "/tmp/finished.mp4" });
		await expect(manager.wait(job.id)).resolves.toMatchObject({ state: "succeeded" });
	});
	it("makes renderer interruption honest and ignores a late success", async () => {
		const finish = deferred<JobJson>();
		manager.registerRunner("export", () => finish.promise);
		const job = await manager.create({ kind: "export", input: {} });
		await expect(
			manager.interrupt(job.id, new AutomationError("RENDERER_GONE", "Editor exited")),
		).resolves.toMatchObject({
			state: "interrupted",
			terminal: true,
			error: { code: "RENDERER_GONE" },
		});
		finish.resolve({ incorrectlySaved: true });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(manager.get(job.id)).toMatchObject({ state: "interrupted" });
		expect(manager.get(job.id)).not.toHaveProperty("result");
	});
	it("marks running and queued records interrupted after restart without replaying them", async () => {
		const finish = deferred<JobJson>();
		const run = vi.fn(() => finish.promise);
		manager.registerRunner("export", run);
		const active = await manager.create({
			kind: "export",
			input: { outputPath: "/tmp/a.mp4" },
			snapshot: { padding: 1 },
		});
		const queued = await manager.create({
			kind: "export",
			input: { outputPath: "/tmp/b.mp4" },
		});
		const restoredDirectory = path.join(directory, "restart");
		await fs.mkdir(restoredDirectory);
		for (const id of [active.id, queued.id])
			await fs.copyFile(
				path.join(directory, `job-${id}.json`),
				path.join(restoredDirectory, `job-${id}.json`),
			);
		const restored = new AutomationJobManager({ directory: restoredDirectory });
		managers.push(restored);
		await restored.initialize();
		const replay = vi.fn(async () => ({ replayed: true }));
		restored.registerRunner("export", replay);
		for (const id of [active.id, queued.id])
			expect(restored.get(id)).toMatchObject({
				state: "interrupted",
				error: { code: "APP_RESTARTED" },
			});
		expect(replay).not.toHaveBeenCalled();
		finish.resolve({ saved: true });
		await manager.wait(active.id);
		await manager.cancel(queued.id);
	});
	it("retries failed jobs as a new id from the same frozen document", async () => {
		manager.registerRunner("export", async () => {
			throw new AutomationError("ENCODE_FAILED", "Encoder unavailable");
		});
		const first = await manager.create({
			kind: "export",
			input: { outputPath: "/tmp/a.mp4" },
			snapshot: { padding: 8 },
		});
		await manager.wait(first.id);
		manager.registerRunner("export", async (context) => ({
			snapshot: context.snapshot!,
			path: context.input.outputPath,
		}));
		const retried = await manager.retry(first.id, { input: { outputPath: "/tmp/b.mp4" } });
		expect(retried.id).not.toBe(first.id);
		expect(retried.retryOf).toBe(first.id);
		await expect(manager.wait(retried.id)).resolves.toMatchObject({
			state: "succeeded",
			result: { snapshot: { padding: 8 }, path: "/tmp/b.mp4" },
		});
		expect(manager.get(first.id)).toMatchObject({ state: "failed" });
		await expect(manager.retry(retried.id)).rejects.toMatchObject({
			code: "INVALID_JOB_STATE",
		});
	});
	it("persists retained output checkpoints and isolates returned results", async () => {
		manager.registerRunner("export", async (context) => {
			await context.checkpoint({
				pendingOutputPath: "/tmp/retained.mp4",
				fileName: "movie.mp4",
			});
			return { outputPath: "/tmp/retained.mp4" };
		});
		const job = await manager.create({ kind: "export", input: {} });
		const result = await manager.wait(job.id);
		expect(result.checkpoint).toEqual({
			pendingOutputPath: "/tmp/retained.mp4",
			fileName: "movie.mp4",
		});
		(result.result as { outputPath: string }).outputPath = "/tmp/modified";
		expect(manager.get(job.id).result).toEqual({ outputPath: "/tmp/retained.mp4" });
		expect(
			JSON.parse(await fs.readFile(path.join(directory, `job-${job.id}.json`), "utf8"))
				.checkpoint,
		).toEqual(result.checkpoint);
	});
	it("returns progress revisions without falsely finishing the job", async () => {
		const continueWork = deferred<JobJson>();
		const progressReady = deferred<void>();
		manager.registerRunner("export", async (context) => {
			context.progress({ phase: "rendering", percentage: 25 });
			progressReady.resolve();
			return continueWork.promise;
		});
		const job = await manager.create({ kind: "export", input: {} });
		await progressReady.promise;
		await expect(manager.wait(job.id, { afterRevision: job.revision })).resolves.toMatchObject({
			terminal: false,
			progress: { phase: "rendering", percentage: 25 },
		});
		continueWork.resolve({ success: true });
		await manager.wait(job.id);
	});
	it("rejects non-JSON snapshots and unsupported job kinds before execution", async () => {
		const run = vi.fn(async () => ({ saved: true }));
		manager.registerRunner("export", run);
		await expect(
			manager.create({ kind: "export", input: {}, snapshot: { broken: NaN } }),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		await expect(manager.create({ kind: "models.download", input: {} })).rejects.toMatchObject({
			code: "JOB_UNAVAILABLE",
		});
		expect(run).not.toHaveBeenCalled();
	});
	it("does not claim successful completion for invalid worker progress", async () => {
		manager.registerRunner("export", async (context) => {
			context.progress({ phase: "rendering", percentage: NaN });
			return {};
		});
		const job = await manager.create({ kind: "export", input: {} });
		await expect(manager.wait(job.id)).resolves.toMatchObject({
			state: "failed",
			error: { code: "INVALID_PROGRESS" },
		});
	});
	it("quarantines malformed persisted records from replay while retaining a diagnostic", async () => {
		const secondDirectory = path.join(directory, "invalid");
		await fs.mkdir(secondDirectory);
		await fs.writeFile(
			path.join(secondDirectory, "job-11111111-1111-1111-1111-111111111111.json"),
			"not JSON",
		);
		const restored = new AutomationJobManager({ directory: secondDirectory });
		managers.push(restored);
		await restored.initialize();
		expect(restored.list()).toEqual([]);
		expect(restored.diagnostics).toHaveLength(1);
	});
});
