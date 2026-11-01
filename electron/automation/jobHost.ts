import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import { AutomationError, type AutomationRequest } from "../../shared/automation";
import {
	type AutomationJobKind,
	JOB_AUTOMATION_COMMANDS,
	type JobJson,
	type JobObject,
} from "../../shared/jobAutomation";
import { USER_DATA_PATH } from "../appPaths";
import { isOwnedExportPath, releaseOwnedExportPath } from "../ipc/export/exportStream";
import { rememberApprovedLocalReadPath } from "../ipc/project/manager";
import { AutomationJobBridge } from "./jobBridge";
import {
	captureAutomationCaptionAudio,
	deleteAutomationModel,
	downloadAutomationModel,
	generateAutomationCaptions,
	listAutomationModels,
} from "./jobMedia";
import { type AutomationJobContext, AutomationJobManager } from "./jobs";
import {
	type PreparedAutomationOutput,
	prepareAutomationOutput,
	publishAutomationOutput,
} from "./output";

interface JobMediaFingerprint {
	path: string;
	canonical: string;
	dev: string;
	ino: string;
	size: string;
	mtimeNs: string;
	ctimeNs: string;
}
function localMediaPath(value: unknown): string | null {
	if (
		typeof value !== "string" ||
		!value ||
		value.startsWith("/wallpapers/") ||
		value.startsWith("/app-icons/")
	)
		return null;
	try {
		if (value.startsWith("file://")) return fileURLToPath(value);
		if (/^https?:\/\//i.test(value)) {
			const url = new URL(value);
			if (["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/video")
				return localMediaPath(url.searchParams.get("path"));
			return null;
		}
	} catch {
		return null;
	}
	return path.isAbsolute(value) ? value : null;
}
function mediaPaths(snapshot: JobObject, input: JobObject): string[] {
	const paths = new Set<string>();
	const add = (value: unknown) => {
		const local = localMediaPath(value);
		if (local) paths.add(local);
	};
	const source = snapshot as Record<string, unknown>;
	const project = source.project as Record<string, unknown> | undefined;
	add(source.videoPath);
	add(input.modelPath ?? source.whisperModelPath);
	add(input.executablePath ?? source.whisperExecutablePath);
	add(project?.videoPath);

	for (const config of [source.commonConfig, project?.editor]) {
		if (!config || typeof config !== "object" || Array.isArray(config)) continue;
		const composition = config as Record<string, unknown>;
		add(composition.wallpaper);
		add(composition.frame);
		if (composition.webcam && typeof composition.webcam === "object")
			add((composition.webcam as Record<string, unknown>).sourcePath);
		for (const key of ["sourceAudioFallbackPaths", "assetPaths"])
			if (Array.isArray(composition[key])) for (const item of composition[key]) add(item);
		if (
			composition.sourceAudioFallbackStartDelayMsByPath &&
			typeof composition.sourceAudioFallbackStartDelayMsByPath === "object"
		)
			for (const item of Object.keys(composition.sourceAudioFallbackStartDelayMsByPath))
				add(item);
		if (Array.isArray(composition.audioRegions))
			for (const item of composition.audioRegions)
				if (item && typeof item === "object")
					add((item as Record<string, unknown>).audioPath);
		if (Array.isArray(composition.annotationRegions))
			for (const item of composition.annotationRegions)
				if (item && typeof item === "object") {
					add((item as Record<string, unknown>).imageContent);
					if ((item as Record<string, unknown>).type === "image")
						add((item as Record<string, unknown>).content);
				}
	}
	if (Array.isArray(source.assetPaths)) for (const item of source.assetPaths) add(item);
	if (Array.isArray(source._audioCandidates))
		for (const item of source._audioCandidates)
			if (item && typeof item === "object") add((item as Record<string, unknown>).path);
	if (paths.size > 4096)
		throw new AutomationError(
			"INVALID_SNAPSHOT",
			"Too many external media assets in the frozen document.",
		);
	return [...paths];
}
async function fingerprint(file: string): Promise<JobMediaFingerprint> {
	const canonical = await fs.realpath(file);
	const stat = await fs.lstat(canonical, { bigint: true });
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new AutomationError("SOURCE_CHANGED", "A frozen media asset is not a regular file.");
	return {
		path: file,
		canonical,
		dev: String(stat.dev),
		ino: String(stat.ino),
		size: String(stat.size),
		mtimeNs: String(stat.mtimeNs),
		ctimeNs: String(stat.ctimeNs),
	};
}
export async function captureJobMediaFingerprint(
	snapshot: JobJson,
	input: JobObject,
): Promise<JobJson> {
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
		throw new AutomationError("INVALID_SNAPSHOT", "A job requires a document object.");
	const fingerprints: JobMediaFingerprint[] = [];
	for (const file of mediaPaths(snapshot, input)) {
		try {
			fingerprints.push(await fingerprint(file));
			await rememberApprovedLocalReadPath(file);
		} catch (error) {
			throw new AutomationError("SOURCE_CHANGED", `Cannot freeze source asset: ${file}`, {
				cause: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { ...snapshot, _mediaFingerprint: fingerprints as unknown as JobJson };
}
export async function verifyJobMediaFingerprint(snapshot: JobJson | undefined): Promise<void> {
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
		throw new AutomationError(
			"INVALID_SNAPSHOT",
			"The durable job has no frozen media snapshot.",
		);
	const fingerprints = snapshot._mediaFingerprint;
	if (!Array.isArray(fingerprints))
		throw new AutomationError(
			"INVALID_SNAPSHOT",
			"The durable job has no source fingerprint; capture a new job.",
		);
	for (const item of fingerprints) {
		if (
			!item ||
			typeof item !== "object" ||
			Array.isArray(item) ||
			typeof item.path !== "string"
		)
			throw new AutomationError("INVALID_SNAPSHOT", "Invalid frozen media fingerprint.");
		try {
			const current = await fingerprint(item.path);
			if (
				Object.keys(current).some(
					(key) => current[key as keyof JobMediaFingerprint] !== item[key],
				)
			)
				throw new Error("Media identity differs");
			await rememberApprovedLocalReadPath(item.path);
		} catch {
			throw new AutomationError(
				"SOURCE_CHANGED",
				`A frozen media asset changed: ${item.path}. Capture a new job instead of publishing mixed media.`,
			);
		}
	}
}

export function createAutomationJobs(options: {
	getEditor: () => BrowserWindow | null;
	createEditor: () => BrowserWindow;
	safeIdle: () => Promise<void>;
	applyCaptions: (snapshot: JobObject, cues: JobJson) => Promise<unknown>;
}) {
	const directory = path.join(USER_DATA_PATH, "automation", "jobs");
	const artifacts = path.join(directory, "artifacts");
	const manager = new AutomationJobManager({ directory, maxConcurrent: 1 });
	const bridge = new AutomationJobBridge({
		...options,
		interrupt: (id, error) => {
			void manager.interrupt(id, error);
		},
	});
	const prepared = new Map<string, PreparedAutomationOutput>();
	let creating = false;
	let closed = false;
	let canonicalDirectory = directory;
	const initialized = manager.initialize().then(async () => {
		await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });
		const metadata = await fs.lstat(artifacts);
		if (
			!metadata.isDirectory() ||
			metadata.isSymbolicLink() ||
			(process.getuid && metadata.uid !== process.getuid())
		)
			throw new AutomationError(
				"ACCESS_DENIED",
				"Job artifacts must be a private directory owned by the current user.",
			);
		await fs.chmod(artifacts, 0o700);
		canonicalDirectory = await fs.realpath(directory);
	});
	void initialized.catch(() => {
		// Dispatch still reports startup failures; observe the background rejection here.
	});
	const clearTarget = (input: JobObject) => prepared.delete(String(input.preparedToken ?? ""));
	async function prepareTarget(input: JobObject) {
		const target = await prepareAutomationOutput(input.outputPath, input.overwrite);
		const relative = path.relative(canonicalDirectory, target.path);
		if (
			relative === "" ||
			(!relative.startsWith(`..${path.sep}`) &&
				relative !== ".." &&
				!path.isAbsolute(relative))
		)
			throw new AutomationError(
				"INVALID_PATH",
				"External output cannot replace the application's private job storage.",
			);
		return target;
	}
	async function discardManaged(result: JobObject | undefined) {
		if (
			result &&
			typeof result.tempFilePath === "string" &&
			isOwnedExportPath(result.tempFilePath)
		) {
			await fs.unlink(result.tempFilePath).catch(() => {
				// Cleanup must not mask the worker result or remove its retained artifact.
			});
			releaseOwnedExportPath(result.tempFilePath);
		}
	}
	const active = () =>
		["queued", "running", "cancelling"].some(
			(state) => manager.list({ state: state as "queued", limit: 1000 }).length > 0,
		);
	const outputInput = (params: Record<string, unknown>): JobObject => {
		const settings = { ...((params.settings as JobObject) ?? {}) };
		const ext = path.extname(String(params.outputPath)).toLowerCase();
		if (ext === ".gif") {
			if (settings.format && settings.format !== "gif")
				throw new AutomationError("INVALID_PARAMS", "GIF output requires GIF format.");
			settings.format = "gif";
		} else {
			settings.format = settings.format ?? "mp4";
			if (settings.format !== "mp4")
				throw new AutomationError(
					"INVALID_PARAMS",
					"Video output requires MP4/video format.",
				);
			if (ext === ".mov" || ext === ".webm") {
				settings.transparentBackground = true;
				settings.alphaFormat = ext.slice(1);
			} else if (settings.transparentBackground === true)
				throw new AutomationError(
					"INVALID_PARAMS",
					"Transparent exports require .mov or .webm output.",
				);
			else settings.transparentBackground = false;
		}
		return { ...params, settings } as JobObject;
	};
	async function saveArtifact(ctx: AutomationJobContext, result: JobObject) {
		if (typeof result.tempFilePath !== "string" || !isOwnedExportPath(result.tempFilePath))
			throw new AutomationError(
				"INVALID_OUTPUT",
				"Worker did not return a managed finished export.",
			);
		const stat = await fs.lstat(result.tempFilePath);
		const format = String(result.format);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			!stat.size ||
			!["mp4", "gif", "mov", "webm"].includes(format)
		)
			throw new AutomationError("INVALID_OUTPUT", "Export artifact is invalid.");
		const artifactPath = path.join(artifacts, `${ctx.jobId}.${format}`);
		await fs.copyFile(result.tempFilePath, artifactPath, constants.COPYFILE_EXCL);
		await fs.chmod(artifactPath, 0o600);
		const file = await fs.open(artifactPath, "r");
		try {
			await file.sync();
		} finally {
			await file.close();
		}
		await ctx.checkpoint({
			artifactPath,
			format,
			fileName: String(result.fileName ?? `export.${format}`),
		});
		await fs.unlink(result.tempFilePath).catch(() => {
			// Cleanup must not mask the worker result or remove its retained artifact.
		});
		releaseOwnedExportPath(result.tempFilePath);
		return artifactPath;
	}
	async function target(ctx: AutomationJobContext) {
		const token = String(ctx.input.preparedToken ?? "");
		const destination = prepared.get(token);
		if (!destination)
			throw new AutomationError(
				"TARGET_EXPIRED",
				"The output target is no longer prepared; explicitly retry the job.",
			);
		return destination;
	}
	async function publish(
		ctx: AutomationJobContext,
		artifactPath: string,
		format: string,
		sourceJobId = ctx.jobId,
	) {
		const destination = await target(ctx);
		if (path.extname(destination.path).toLowerCase() !== `.${format}`)
			throw new AutomationError(
				"INVALID_PARAMS",
				`Export produced ${format}; select a matching output extension.`,
			);
		if (ctx.kind === "export") await verifyJobMediaFingerprint(ctx.snapshot);
		ctx.progress({ phase: "publishing", percentage: 99 });
		const saved = await publishAutomationOutput(
			destination,
			artifactPath,
			ctx.signal,
			ctx.beginCommit,
		);
		if (sourceJobId !== ctx.jobId)
			await manager.consumeArtifact(sourceJobId, artifactPath, saved.outputPath, ctx.jobId);
		await ctx.checkpoint({ publishedPath: saved.outputPath, retained: false });
		await fs.unlink(artifactPath).catch(() => {
			// Publication and the consumed checkpoint are already committed.
		});
		prepared.delete(String(ctx.input.preparedToken ?? ""));
		return saved;
	}
	manager.registerRunner("export", async (ctx) => {
		let result: JobObject | undefined;
		try {
			await verifyJobMediaFingerprint(ctx.snapshot);
			result = (await bridge.run(ctx)) as JobObject;
			ctx.signal.throwIfAborted();
			await verifyJobMediaFingerprint(ctx.snapshot);
			const artifact = await saveArtifact(ctx, result);
			const saved = await publish(ctx, artifact, String(result.format));
			return { ...result, tempFilePath: null, ...saved };
		} finally {
			clearTarget(ctx.input);
			await discardManaged(result);
		}
	});
	manager.registerRunner("export.save", async (ctx) => {
		try {
			const prior = manager.getRecord(String(ctx.input.jobId));
			const artifact = prior.checkpoint?.artifactPath;
			const format = String(prior.checkpoint?.format ?? "");
			if (
				prior.checkpoint?.retained === false ||
				typeof artifact !== "string" ||
				artifact !== path.join(artifacts, `${prior.id}.${format}`) ||
				!["mp4", "gif", "mov", "webm"].includes(format)
			)
				throw new AutomationError(
					"NO_RETAINED_OUTPUT",
					"The job has no retained finished export.",
				);
			const stat = await fs.lstat(artifact).catch(() => null);
			if (!stat?.isFile() || stat.isSymbolicLink())
				throw new AutomationError(
					"NO_RETAINED_OUTPUT",
					"The retained export is no longer available.",
				);
			return { ...(await publish(ctx, artifact, format, prior.id)), sourceJobId: prior.id };
		} finally {
			clearTarget(ctx.input);
		}
	});
	manager.registerRunner("models.download", downloadAutomationModel);
	manager.registerRunner("captions.generate", async (ctx) => {
		await verifyJobMediaFingerprint(ctx.snapshot);
		const result = (await generateAutomationCaptions(ctx)) as JobObject;
		ctx.signal.throwIfAborted();
		await verifyJobMediaFingerprint(ctx.snapshot);
		if (ctx.input.apply === false) return { ...result, applied: false };
		ctx.beginCommit();
		try {
			await options.applyCaptions(ctx.snapshot as JobObject, result.cues);
			return { ...result, applied: true };
		} catch (error) {
			return {
				...result,
				applied: false,
				applicationError: {
					code: error instanceof AutomationError ? error.code : "APPLY_FAILED",
					message: error instanceof Error ? error.message : String(error),
				},
			};
		}
	});
	return {
		manager,
		hasActive: () => creating || active(),
		recognizes: (method: string) =>
			JOB_AUTOMATION_COMMANDS.some((command) => command.name === method),
		async dispatch(request: AutomationRequest) {
			await initialized;
			if (closed) throw new AutomationError("APP_CLOSING", "Job host is closed.");
			const p = request.params;
			switch (request.method) {
				case "jobs.list":
					return { jobs: manager.list(p) };
				case "jobs.get":
					return manager.get(String(p.jobId));
				case "jobs.wait":
					return manager.wait(String(p.jobId), p);
				case "jobs.cancel": {
					const result = await manager.cancel(String(p.jobId));
					if (result.terminal) clearTarget(manager.getRecord(result.id).input);
					return result;
				}
				case "models.list":
					return listAutomationModels();
			}
			if (creating) throw new AutomationError("BUSY", "Another job is being prepared.");
			creating = true;
			let pendingToken: string | undefined;
			try {
				await options.safeIdle();
				if (request.method === "models.delete") {
					if (active())
						throw new AutomationError(
							"BUSY",
							"Wait for active jobs before removing a model.",
						);
					return deleteAutomationModel(String(p.modelId ?? "small"));
				}
				let kind: AutomationJobKind;
				let input: JobObject = p as JobObject;
				let snapshot: JobJson | undefined;
				let retryOf: string | undefined;
				if (request.method === "jobs.retry") {
					const prior = manager.getRecord(String(p.jobId));
					if (!["failed", "cancelled", "interrupted"].includes(prior.state))
						throw new AutomationError(
							"INVALID_JOB_STATE",
							"Only failed, interrupted or cancelled jobs can be retried.",
						);
					kind = prior.kind;
					snapshot = prior.snapshot;
					retryOf = prior.id;
					input = {
						...prior.input,
						...(p.outputPath ? { outputPath: p.outputPath as string } : {}),
						...(p.overwrite !== undefined ? { overwrite: p.overwrite as boolean } : {}),
					};
				} else if (request.method === "models.download") kind = "models.download";
				else if (request.method === "export.save") kind = "export.save";
				else if (request.method === "export.start") kind = "export";
				else if (request.method === "captions.generate") kind = "captions.generate";
				else throw new AutomationError("UNKNOWN_COMMAND", "Unknown job command.");
				if (kind === "export" || kind === "export.save") {
					if (kind === "export") input = outputInput(input);
					const destination = await prepareTarget(input);
					const token = randomUUID();
					pendingToken = token;
					prepared.set(token, destination);
					input = { ...input, preparedToken: token };
				}
				if ((kind === "export" || kind === "captions.generate") && snapshot === undefined) {
					const captured = await bridge.capture(kind, input);
					snapshot = await captureJobMediaFingerprint(
						kind === "captions.generate"
							? await captureAutomationCaptionAudio(captured)
							: captured,
						input,
					);
				}
				const created = await manager.create({ kind, input, snapshot, retryOf });
				pendingToken = undefined; // Worker/cancel now owns the token lifetime.
				return created;
			} finally {
				if (pendingToken) prepared.delete(pendingToken);
				creating = false;
			}
		},
		async close() {
			if (closed) return;
			closed = true;
			await initialized.catch(() => {
				// A startup failure must not prevent shutting down the job manager and bridge.
			});
			await manager.close();
			bridge.close();
			prepared.clear();
		},
	};
}
