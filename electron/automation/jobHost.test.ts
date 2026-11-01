import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationError, type AutomationRequest } from "../../shared/automation";
import type { AutomationJobView, JobObject } from "../../shared/jobAutomation";
import { getJobPanelActions } from "../../src/components/automation/jobsPresenter";
import type { AutomationJobContext } from "./jobs";
import { AutomationJobManager } from "./jobs";

const mocks = vi.hoisted(() => ({
	directory: "",
	source: "",
	nextTemp: 0,
	owned: new Set<string>(),
	capture: vi.fn(),
	run: vi.fn(),
	bridgeClose: vi.fn(),
	approve: vi.fn(async () => {}),
	generate: vi.fn(),
	download: vi.fn(),
	models: vi.fn(async () => ({ models: [] })),
	removeModel: vi.fn(async () => ({ deleted: true })),
	safeIdle: vi.fn(async () => {}),
	apply: vi.fn(async () => {}),
}));
vi.mock("../appPaths", () => ({
	get USER_DATA_PATH() {
		return mocks.directory;
	},
}));
vi.mock("../ipc/project/manager", () => ({ rememberApprovedLocalReadPath: mocks.approve }));
vi.mock("../ipc/export/exportStream", () => ({
	isOwnedExportPath: (file: string) => mocks.owned.has(file),
	releaseOwnedExportPath: (file: string) => mocks.owned.delete(file),
}));
vi.mock("./jobBridge", () => ({
	AutomationJobBridge: class {
		capture = mocks.capture;
		run = mocks.run;
		close = mocks.bridgeClose;
	},
}));
vi.mock("./jobMedia", () => ({
	captureAutomationCaptionAudio: async (snapshot: JobObject) => ({
		...snapshot,
		_audioCandidates: [{ path: mocks.source, label: "recording" }],
	}),
	generateAutomationCaptions: mocks.generate,
	downloadAutomationModel: mocks.download,
	listAutomationModels: mocks.models,
	deleteAutomationModel: mocks.removeModel,
}));

import {
	captureJobMediaFingerprint,
	createAutomationJobs,
	verifyJobMediaFingerprint,
} from "./jobHost";

let host: ReturnType<typeof createAutomationJobs>;
const request = (method: string, params: Record<string, unknown> = {}) =>
	({ id: "test", method, params }) as AutomationRequest;
async function managedResult(): Promise<JobObject> {
	const temporary = path.join(mocks.directory, `managed-${++mocks.nextTemp}.mp4`);
	await fs.writeFile(temporary, "encoded frozen video");
	mocks.owned.add(temporary);
	return { tempFilePath: temporary, fileName: "movie.mp4", format: "mp4" };
}
beforeEach(async () => {
	vi.resetAllMocks();
	mocks.owned.clear();
	mocks.nextTemp = 0;
	mocks.directory = await fs.mkdtemp(path.join(os.tmpdir(), "sd-job-host-"));
	mocks.source = path.join(mocks.directory, "source.mp4");
	await fs.writeFile(mocks.source, "source video");
	mocks.capture.mockImplementation(async () => ({
		videoPath: mocks.source,
		revision: 4,
		commonConfig: { wallpaper: "#000000" },
	}));
	mocks.run.mockImplementation(async () => managedResult());
	mocks.generate.mockImplementation(async () => ({
		cues: [{ id: "cue", text: "Hello", startMs: 0, endMs: 1000 }],
		videoPath: mocks.source,
	}));
	mocks.download.mockImplementation(async () => ({ downloaded: true }));
	mocks.approve.mockResolvedValue(undefined);
	mocks.models.mockResolvedValue({ models: [] });
	mocks.removeModel.mockResolvedValue({ deleted: true });
	mocks.safeIdle.mockResolvedValue(undefined);
	mocks.apply.mockResolvedValue(undefined);
	host = createAutomationJobs({
		getEditor: () => null,
		createEditor: () => {
			throw new Error("Mock bridge owns renderer");
		},
		safeIdle: mocks.safeIdle,
		applyCaptions: mocks.apply,
	});
});
afterEach(async () => {
	await host.close();
	await fs.rm(mocks.directory, { recursive: true, force: true });
});

describe("application job host", () => {
	it("captures once, preserves the snapshot and atomically publishes only owned finished output", async () => {
		const output = path.join(mocks.directory, "movie.mp4");
		const job = (await host.dispatch(
			request("export.start", { outputPath: output }),
		)) as AutomationJobView;
		const result = await host.manager.wait(job.id);
		expect(result).toMatchObject({
			state: "succeeded",
			result: { outputPath: await fs.realpath(output), tempFilePath: null },
		});
		expect(mocks.capture).toHaveBeenCalledTimes(1);
		expect(mocks.run).toHaveBeenCalledTimes(1);
		expect(mocks.run.mock.calls[0][0]).toMatchObject({
			snapshot: {
				revision: 4,
				videoPath: mocks.source,
				_mediaFingerprint: expect.any(Array),
			},
		});
		expect(await fs.readFile(output, "utf8")).toBe("encoded frozen video");
		expect(await fs.readFile(mocks.source, "utf8")).toBe("source video");
		expect(mocks.owned.size).toBe(0);
	});
	it("retains completed output after a late target conflict and saves it again without encoding", async () => {
		let finish!: (value: JobObject) => void;
		mocks.run.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const output = path.join(mocks.directory, "movie.mp4");
		const job = (await host.dispatch(
			request("export.start", { outputPath: output }),
		)) as AutomationJobView;
		await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled());
		await fs.writeFile(output, "new user file");
		finish(await managedResult());
		const failed = await host.manager.wait(job.id);
		expect(failed).toMatchObject({ state: "failed", error: { code: "TARGET_CHANGED" } });
		await expect(fs.access(String(failed.checkpoint?.artifactPath))).resolves.toBeUndefined();
		expect(await fs.readFile(output, "utf8")).toBe("new user file");
		const savedPath = path.join(mocks.directory, "saved-again.mp4");
		const saving = (await host.dispatch(
			request("export.save", { jobId: job.id, outputPath: savedPath }),
		)) as AutomationJobView;
		await expect(host.manager.wait(saving.id)).resolves.toMatchObject({
			state: "succeeded",
			result: { sourceJobId: job.id },
		});
		expect(mocks.run).toHaveBeenCalledTimes(1);
		expect(await fs.readFile(savedPath, "utf8")).toBe("encoded frozen video");
		const sourceJob = host.manager.get(job.id);
		expect(sourceJob).toMatchObject({
			state: "failed",
			checkpoint: {
				retained: false,
				publishedPath: await fs.realpath(savedPath),
				consumedBy: saving.id,
			},
		});
		expect(getJobPanelActions(sourceJob).save).toBe(false);
		await expect(fs.access(String(failed.checkpoint?.artifactPath))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await host.close();
		const reopened = new AutomationJobManager({
			directory: path.join(mocks.directory, "automation", "jobs"),
		});
		try {
			await reopened.initialize();
			expect(getJobPanelActions(reopened.get(job.id)).save).toBe(false);
		} finally {
			await reopened.close();
		}
	});
	it("refuses overwrite before capture unless explicitly authorized", async () => {
		const output = path.join(mocks.directory, "movie.mp4");
		await fs.writeFile(output, "old video");
		await expect(
			host.dispatch(request("export.start", { outputPath: output })),
		).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
		expect(mocks.capture).not.toHaveBeenCalled();
		const job = (await host.dispatch(
			request("export.start", { outputPath: output, overwrite: true }),
		)) as AutomationJobView;
		await expect(host.manager.wait(job.id)).resolves.toMatchObject({ state: "succeeded" });
		expect(await fs.readFile(output, "utf8")).toBe("encoded frozen video");
	});
	it("never deletes an unowned file returned by a forged worker", async () => {
		mocks.run.mockResolvedValueOnce({ tempFilePath: mocks.source, format: "mp4" });
		const job = (await host.dispatch(
			request("export.start", { outputPath: path.join(mocks.directory, "movie.mp4") }),
		)) as AutomationJobView;
		await expect(host.manager.wait(job.id)).resolves.toMatchObject({
			state: "failed",
			error: { code: "INVALID_OUTPUT" },
		});
		expect(await fs.readFile(mocks.source, "utf8")).toBe("source video");
	});
	it("does not publish or leak a managed result that arrives after cancellation", async () => {
		let finish!: (value: JobObject) => void;
		mocks.run.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const output = path.join(mocks.directory, "movie.mp4");
		const job = (await host.dispatch(
			request("export.start", { outputPath: output }),
		)) as AutomationJobView;
		await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled());
		await host.dispatch(request("jobs.cancel", { jobId: job.id }));
		finish(await managedResult());
		await expect(host.manager.wait(job.id)).resolves.toMatchObject({ state: "cancelled" });
		await expect(fs.access(output)).rejects.toThrow();
		expect(mocks.owned.size).toBe(0);
	});
	it("does not publish or retain a mixed render when source media changes during encoding", async () => {
		mocks.run.mockImplementationOnce(async () => {
			await fs.appendFile(mocks.source, "changed source");
			return managedResult();
		});
		const output = path.join(mocks.directory, "movie.mp4");
		const job = (await host.dispatch(
			request("export.start", { outputPath: output }),
		)) as AutomationJobView;
		const failed = await host.manager.wait(job.id);
		expect(failed).toMatchObject({ state: "failed", error: { code: "SOURCE_CHANGED" } });
		expect(failed.checkpoint ?? {}).not.toHaveProperty("artifactPath");
		await expect(fs.access(output)).rejects.toThrow();
		expect(mocks.owned.size).toBe(0);
	});
	it("forbids using private durable job storage as an external export destination", async () => {
		const output = path.join(mocks.directory, "automation/jobs/artifacts/user.mp4");
		await expect(
			host.dispatch(request("export.start", { outputPath: output })),
		).rejects.toMatchObject({ code: "INVALID_PATH" });
		expect(mocks.capture).not.toHaveBeenCalled();
	});
	it("returns cues but preserves live edits when revision-checked caption application is refused", async () => {
		mocks.apply.mockRejectedValueOnce(
			new AutomationError("REVISION_CONFLICT", "User edited the project"),
		);
		const job = (await host.dispatch(request("captions.generate", {}))) as AutomationJobView;
		await expect(host.manager.wait(job.id)).resolves.toMatchObject({
			state: "succeeded",
			result: {
				applied: false,
				cues: [{ text: "Hello" }],
				applicationError: { code: "REVISION_CONFLICT" },
			},
		});
	});
	it("generates cues without changing the editor when apply=false", async () => {
		const job = (await host.dispatch(
			request("captions.generate", { apply: false }),
		)) as AutomationJobView;
		await expect(host.manager.wait(job.id)).resolves.toMatchObject({
			state: "succeeded",
			result: { applied: false },
		});
		expect(mocks.apply).not.toHaveBeenCalled();
	});
	it("refuses to apply captions produced from media modified during transcription", async () => {
		mocks.generate.mockImplementationOnce(async () => {
			await fs.appendFile(mocks.source, "changed source");
			return { cues: [] };
		});
		const job = (await host.dispatch(request("captions.generate", {}))) as AutomationJobView;
		await expect(host.manager.wait(job.id)).resolves.toMatchObject({
			state: "failed",
			error: { code: "SOURCE_CHANGED" },
		});
		expect(mocks.apply).not.toHaveBeenCalled();
	});
	it("protects models while a job is active and releases preparation locks on failure", async () => {
		let finish!: (value: JobObject) => void;
		mocks.run.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const job = (await host.dispatch(
			request("export.start", { outputPath: path.join(mocks.directory, "movie.mp4") }),
		)) as AutomationJobView;
		await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled());
		await expect(host.dispatch(request("models.delete", {}))).rejects.toMatchObject({
			code: "BUSY",
		});
		expect(mocks.removeModel).not.toHaveBeenCalled();
		finish(await managedResult());
		await host.manager.wait(job.id);
		await expect(host.dispatch(request("models.delete", {}))).resolves.toEqual({
			deleted: true,
		});
	});
	it("retries using the captured snapshot without recapturing later editor changes", async () => {
		mocks.run.mockRejectedValueOnce(new AutomationError("ENCODER_UNAVAILABLE", "No encoder"));
		const job = (await host.dispatch(
			request("export.start", { outputPath: path.join(mocks.directory, "movie.mp4") }),
		)) as AutomationJobView;
		await host.manager.wait(job.id);
		mocks.capture.mockResolvedValueOnce({ revision: 99 });
		const retried = (await host.dispatch(
			request("jobs.retry", {
				jobId: job.id,
				outputPath: path.join(mocks.directory, "retried.mp4"),
			}),
		)) as AutomationJobView;
		await expect(host.manager.wait(retried.id)).resolves.toMatchObject({
			state: "succeeded",
			retryOf: job.id,
		});
		expect(mocks.capture).toHaveBeenCalledTimes(1);
		expect(mocks.run.mock.calls[1][0]).toMatchObject({ snapshot: { revision: 4 } });
	});
	it("allows a fresh preparation after capture fails and closes cleanly", async () => {
		mocks.capture.mockRejectedValueOnce(new AutomationError("BUSY", "Editor loading"));
		await expect(
			host.dispatch(
				request("export.start", { outputPath: path.join(mocks.directory, "failed.mp4") }),
			),
		).rejects.toMatchObject({ code: "BUSY" });
		expect(host.hasActive()).toBe(false);
		const job = (await host.dispatch(
			request("export.start", { outputPath: path.join(mocks.directory, "movie.mp4") }),
		)) as AutomationJobView;
		await host.manager.wait(job.id);
		await host.close();
		await expect(host.dispatch(request("models.list"))).rejects.toMatchObject({
			code: "APP_CLOSING",
		});
		expect(mocks.bridgeClose).toHaveBeenCalledTimes(1);
	});
});

describe("frozen source and asset identity", () => {
	it("fingerprints and reapproves source, camera, audio and local background assets", async () => {
		const camera = path.join(mocks.directory, "camera.mp4");
		const audio = path.join(mocks.directory, "music.wav");
		const background = path.join(mocks.directory, "background.png");
		for (const asset of [camera, audio, background]) await fs.writeFile(asset, "asset");
		const snapshot = await captureJobMediaFingerprint(
			{
				videoPath: mocks.source,
				commonConfig: {
					webcam: { sourcePath: camera },
					audioRegions: [{ audioPath: audio }],
					wallpaper: background,
				},
			},
			{},
		);
		await verifyJobMediaFingerprint(snapshot);
		for (const asset of [mocks.source, camera, audio, background])
			expect(mocks.approve).toHaveBeenCalledWith(asset);
		await fs.appendFile(camera, "changed");
		await expect(verifyJobMediaFingerprint(snapshot)).rejects.toMatchObject({
			code: "SOURCE_CHANGED",
		});
	});
	it("detects a retargeted source alias even when replacement bytes match", async () => {
		const alias = path.join(mocks.directory, "alias.mp4");
		const replacement = path.join(mocks.directory, "replacement.mp4");
		await fs.writeFile(replacement, "source video");
		await fs.symlink(mocks.source, alias);
		const snapshot = await captureJobMediaFingerprint({ videoPath: alias }, {});
		await fs.unlink(alias);
		await fs.symlink(replacement, alias);
		await expect(verifyJobMediaFingerprint(snapshot)).rejects.toMatchObject({
			code: "SOURCE_CHANGED",
		});
	});
});
