/** Real stages 4–6 Electron/CLI/MCP smoke. Set SCREENDANCE_SMOKE_APP to test a packaged .app. */
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL("../", import.meta.url));
await fs.mkdir(path.join(root, ".tmp"), { recursive: true });
const runDir = await fs.mkdtemp(path.join(root, ".tmp", "automation-upgrade-"));
const profile = path.join(runDir, "profile");
const endpoint = path.join(profile, "automation", "endpoint.json");
const appBundle = process.env.SCREENDANCE_SMOKE_APP || null;
const cli = appBundle
	? path.join(appBundle, "Contents", "MacOS", "screendance")
	: path.join(root, "dist-automation", "screendance.mjs");
const electron = path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const cliCommand = appBundle ? cli : process.execPath;
const cliPrefix = appBundle ? [] : [cli];
const cliEnvironment = appBundle ? { ...process.env, PATH: "/usr/bin:/bin" } : process.env;
let appExecutable = electron;
const video = path.join(runDir, "Тест video.mp4");
const audio = path.join(runDir, "tone.wav");
const image = path.join(runDir, "image.png");
const project = path.join(runDir, "Initial.scrdance");
const results = [];
const jobs = [];
const retryObservations = [];
let currentStep = "prepare";
let output = "";
let app;
let client;
const report = {
	success: false,
	platform: process.platform,
	arch: process.arch,
	orchestrationArch: process.arch,
	appBundle,
	cliRuntime: {
		kind: appBundle ? "bundled-electron" : "external-node",
		command: cliCommand,
		nodeBundled: Boolean(appBundle),
		externalNodeRequired: !appBundle,
		path: cliEnvironment.PATH,
	},
	startedAt: new Date().toISOString(),
	checks: results,
	jobs,
	retryObservations,
	artifacts: { runDir, video, audio, image, project },
	fakeWhisper: true,
	actualSpeechRecognitionVerified: false,
	deviceCapture: false,
	modelDownloads: false,
	remoteExtensionInstallation: false,
};

async function commandOnce(method, params = {}, expectedError) {
	let stdout;
	let failed = false;
	try {
		({ stdout } = await execFile(
			cliCommand,
			[
				...cliPrefix,
				"--endpoint",
				endpoint,
				"--timeout-ms",
				"180000",
				"--json",
				"call",
				method,
				"--params",
				JSON.stringify(params),
			],
			{ cwd: root, env: cliEnvironment, timeout: 185000, maxBuffer: 16 * 1024 * 1024 },
		));
	} catch (error) {
		if (!error.stdout) throw error;
		stdout = error.stdout;
		failed = true;
	}
	const response = JSON.parse(stdout);
	if (expectedError) {
		assert(failed && response.error, `${method} should fail: ${stdout}`);
		const allowed = Array.isArray(expectedError) ? expectedError : [expectedError];
		assert(allowed.includes(response.error.code), `${method}: unexpected error ${stdout}`);
		await fs.appendFile(
			path.join(runDir, "expected-errors.jsonl"),
			`${JSON.stringify({ method, params, response })}\n`,
		);
	} else if (failed) {
		throw Object.assign(new Error(`${method} failed: ${stdout}`), {
			automationCode: response.error?.code,
		});
	}
	return response;
}
async function command(method, params = {}, expectedError) {
	const editorMutation =
		["editor.apply", "editor.undo", "editor.redo", "editor.autoZoom"].includes(method) ||
		(method === "editor.presets" && ["save", "apply"].includes(params.action));
	// Only these guarded operations can be retried after an explicit pre-application BUSY refusal.
	if (expectedError || (!editorMutation && method !== "project.save"))
		return commandOnce(method, params, expectedError);
	const original = await commandOnce("editor.get");
	const boundParams = editorMutation
		? { ...params, expectedDocumentId: params.expectedDocumentId ?? original.documentId }
		: params;
	const deadline = Date.now() + 90000;
	for (let attempt = 1; ; attempt++) {
		try {
			return await commandOnce(method, boundParams);
		} catch (error) {
			if (error.automationCode !== "BUSY" || attempt >= 5 || Date.now() >= deadline)
				throw error;
			let live;
			do {
				await new Promise((resolve) => setTimeout(resolve, 200));
				live = await commandOnce("editor.get");
				assert.equal(
					live.documentId,
					original.documentId,
					"Document changed during BUSY wait.",
				);
				assert.equal(
					live.revision,
					original.revision,
					"Document revision changed during BUSY wait.",
				);
				assert.deepEqual(
					live.document,
					original.document,
					"Document content changed during BUSY wait.",
				);
				assert.equal(
					live.projectPath,
					original.projectPath,
					"Project path changed during BUSY wait.",
				);
				assert(Date.now() < deadline, `${method}: idle wait exceeded90seconds.`);
			} while (
				live.readiness.loading ||
				live.readiness.saving ||
				live.readiness.exporting ||
				live.readiness.generatingCaptions
			);
			retryObservations.push({
				method,
				attempt,
				refusal: "BUSY",
				revision: live.revision,
				documentId: live.documentId,
				readiness: live.readiness,
			});
		}
	}
}
async function connectMcp() {
	const value = new Client({ name: "screendance-upgrade-smoke", version: "1" });
	await value.connect(
		new StdioClientTransport({
			command: cliCommand,
			args: [...cliPrefix, "--endpoint", endpoint, "mcp", "serve"],
			env: cliEnvironment,
			stderr: "pipe",
		}),
	);
	return value;
}
async function mcp(method, params = {}) {
	const result = await client.callTool({ name: method.replaceAll(".", "_"), arguments: params });
	assert(!result.isError, `${method} MCP failed: ${JSON.stringify(result)}`);
	return result.structuredContent?.result;
}
async function step(name, fn) {
	currentStep = name;
	console.log(`Upgrade smoke: ${name}`);
	const started = Date.now();
	const result = await fn();
	results.push({ name, passed: true, elapsedMs: Date.now() - started });
	await fs.writeFile(
		path.join(runDir, "progress.json"),
		JSON.stringify({ currentStep, checks: results }, null, 2),
	);
	return result;
}
async function document() {
	return command("editor.get");
}
async function apply(operations) {
	const live = await document();
	return command("editor.apply", { expectedRevision: live.revision, operations });
}
async function terminal(job, { timeoutMs = 180000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let current = job;
	while (!current.terminal) {
		assert(Date.now() < deadline, `Job ${current.id} timed out in ${current.state}`);
		current = await command("jobs.wait", {
			jobId: current.id,
			afterRevision: current.revision,
			timeoutMs: 10000,
		});
	}
	jobs.push({
		id: current.id,
		kind: current.kind,
		state: current.state,
		result: current.result,
		error: current.error,
	});
	await fs.writeFile(
		path.join(runDir, `job-${current.id}.json`),
		JSON.stringify(current, null, 2),
	);
	return current;
}
function succeeded(job) {
	assert.equal(job.state, "succeeded", JSON.stringify(job, null, 2));
	return job;
}
async function probe(file) {
	const { stdout } = await execFile(
		process.env.FFPROBE_PATH || "ffprobe",
		["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
		{ timeout: 30000, maxBuffer: 1024 * 1024 },
	);
	const metadata = JSON.parse(stdout);
	assert(metadata.streams.some((stream) => stream.codec_type === "video"));
	assert(Number(metadata.format.duration) > 0.5);
	await fs.writeFile(`${file}.probe.json`, JSON.stringify(metadata, null, 2));
	return metadata;
}
const ffmpeg = (args) =>
	execFile(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
		timeout: 30000,
		maxBuffer: 1024 * 1024,
	});

try {
	assert.equal(process.platform, "darwin", "The real desktop smoke requires macOS.");
	if (appBundle) {
		assert(path.isAbsolute(appBundle), "SCREENDANCE_SMOKE_APP must be an absolute .app path.");
		assert.equal(path.extname(appBundle), ".app");
		const { stdout } = await execFile(
			"/usr/bin/plutil",
			[
				"-extract",
				"CFBundleExecutable",
				"raw",
				"-o",
				"-",
				path.join(appBundle, "Contents", "Info.plist"),
			],
			{ timeout: 10000 },
		);
		const executableName = stdout.trim();
		assert(
			executableName &&
				!executableName.includes("/") &&
				![".", ".."].includes(executableName),
		);
		appExecutable = path.join(appBundle, "Contents", "MacOS", executableName);
		await fs.access(appExecutable, fs.constants.X_OK);
	} else await fs.access(path.join(root, "dist-electron", "main.cjs"));
	await fs.access(cli);
	await ffmpeg([
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=640x360:rate=24",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:sample_rate=48000",
		"-t",
		"2",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		video,
	]);
	await ffmpeg([
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=660:sample_rate=48000",
		"-t",
		"2",
		"-c:a",
		"pcm_s16le",
		audio,
	]);
	await fs.writeFile(
		image,
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQmvn/PwAFVQK6J1lEDwAAAABJRU5ErkJggg==",
			"base64",
		),
	);
	await fs.writeFile(
		project,
		JSON.stringify({
			version: 1,
			projectId: "upgrade-fixture",
			videoPath: video,
			editor: {
				aspectRatio: "16:9",
				wallpaper: "#223344",
				showCursor: false,
				padding: { top: 5, right: 5, bottom: 5, left: 5 },
			},
		}),
	);
	app = spawn(appExecutable, appBundle ? ["--automation"] : [root, "--automation"], {
		cwd: root,
		env: {
			...process.env,
			SCREENDANCE_USER_DATA_DIR: profile,
			SCREENDANCE_AUTOMATION_ENDPOINT: endpoint,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	app.stdout.on("data", (chunk) => {
		output += chunk;
	});
	app.stderr.on("data", (chunk) => {
		output += chunk;
	});
	const deadline = Date.now() + 30000;
	while (true) {
		try {
			await fs.access(endpoint);
			break;
		} catch {
			/* Await only this child's endpoint. */
		}
		assert(
			app.exitCode === null && Date.now() < deadline,
			`Electron startup failed\n${output}`,
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const capabilities = await command("app.capabilities");
	report.commandCount = capabilities.commands.length;
	report.electron = await command("app.status");
	report.arch = report.electron.arch;
	report.appExecutable = appExecutable;
	assert(capabilities.commands.length > 40);
	await fs.writeFile(
		path.join(runDir, "capabilities.json"),
		JSON.stringify(capabilities, null, 2),
	);
	await step("open and inspect real editor", async () => {
		await command("project.open", { path: project });
		const state = await document();
		assert(state.readiness.previewReady);
		assert(state.document.editor.clipRegions.length);
		report.initialRevision = state.revision;
	});
	client = await connectMcp();
	await step("MCP discovers all commands and inspects document", async () => {
		assert.equal((await client.listTools()).tools.length, capabilities.commands.length);
		assert.equal((await mcp("editor.get")).videoPath, video);
	});
	const before = await document();
	const style = {
		color: "#ffffff",
		backgroundColor: "#112233",
		fontSize: 24,
		fontFamily: "Georgia",
		fontWeight: "normal",
		fontStyle: "normal",
		textDecoration: "none",
		textAlign: "center",
		borderRadius: 6,
	};
	const operations = [
		{
			op: "settings.patch",
			values: {
				wallpaper: image,
				borderRadius: 31,
				cursorSize: 4.5,
				cursorSmoothing: 1.1,
				cursorSpringStiffnessMultiplier: 1.8,
				cursorClickBounceDuration: 420,
				zoomInDurationMs: 777,
				zoomOutDurationMs: 999,
				autoCaptionSettings: { fontFamily: "Georgia" },
			},
		},
		{
			op: "clips.split",
			id: before.document.editor.clipRegions[0].id,
			atMs: 1000,
			leftId: "left-fixture",
			rightId: "right-fixture",
		},
		{ op: "clips.speed", id: "right-fixture", speed: 1.25 },
		{
			op: "region.create",
			collection: "zoomRegions",
			value: {
				id: "zoom-fixture",
				startMs: 200,
				endMs: 1000,
				depth: 2,
				focus: { cx: 0.4, cy: 0.6 },
				mode: "manual",
			},
		},
		{
			op: "region.create",
			collection: "annotationRegions",
			value: {
				id: "text-fixture",
				type: "text",
				content: "Синтетический smoke",
				startMs: 0,
				endMs: 1700,
				position: { x: 20, y: 20 },
				size: { width: 45, height: 20 },
				style,
				zIndex: 1,
			},
		},
		{
			op: "region.create",
			collection: "annotationRegions",
			value: {
				id: "image-fixture",
				type: "image",
				content: image,
				imageContent: image,
				startMs: 0,
				endMs: 1700,
				position: { x: 70, y: 70 },
				size: { width: 10, height: 10 },
				style,
				zIndex: 2,
			},
		},
		{
			op: "region.create",
			collection: "audioRegions",
			value: {
				id: "audio-fixture",
				audioPath: audio,
				startMs: 0,
				endMs: 1700,
				volume: 0.25,
				normalize: false,
			},
		},
	];
	const edited = await step("atomic multi-domain editing with local media", async () => {
		const result = await command("editor.apply", {
			expectedRevision: before.revision,
			operations,
		});
		assert.equal(result.document.editor.cursorSize, 4.5);
		assert.equal(result.document.editor.clipRegions.length, 2);
		assert(
			result.document.editor.annotationRegions
				.find((item) => item.id === "image-fixture")
				.content.startsWith("data:image/"),
		);
		return result;
	});
	await step("stale revisions and invalid batches leave the document untouched", async () => {
		await command(
			"editor.apply",
			{
				expectedRevision: before.revision,
				operations: [{ op: "settings.patch", values: { borderRadius: 1 } }],
			},
			"REVISION_CONFLICT",
		);
		const current = await document();
		await command(
			"editor.apply",
			{
				expectedRevision: current.revision,
				operations: [
					{ op: "settings.patch", values: { borderRadius: 2 } },
					{ op: "region.delete", collection: "zoomRegions", id: "missing-region" },
				],
			},
			"ID_NOT_FOUND",
		);
		const after = await document();
		assert.equal(after.revision, current.revision);
		assert.deepEqual(after.document, current.document);
	});
	await step("full document undo and redo", async () => {
		let current = await document();
		const undone = await command("editor.undo", { expectedRevision: current.revision });
		assert.deepEqual(undone.document, before.document);
		current = await document();
		const redone = await command("editor.redo", { expectedRevision: current.revision });
		assert.deepEqual(redone.document, edited.document);
	});
	await step("preset save apply list get and delete", async () => {
		let current = await document();
		const saved = await command("editor.presets", {
			action: "save",
			name: "Upgrade fixture",
			expectedRevision: current.revision,
		});
		const id = saved.preset.id;
		assert(
			(await command("editor.presets", { action: "list" })).presets.some(
				(item) => item.id === id,
			),
		);
		assert.equal((await command("editor.presets", { action: "get", id })).preset.id, id);
		await apply([{ op: "settings.patch", values: { borderRadius: 7 } }]);
		current = await document();
		await command("editor.presets", {
			action: "apply",
			id,
			expectedRevision: current.revision,
		});
		assert.equal((await document()).document.editor.borderRadius, 31);
		await command("editor.presets", { action: "delete", id });
	});
	const savedAs = path.join(runDir, "Saved.scrdance");
	await step(
		"save and reopen preserves authored motion controls caption fonts and image content",
		async () => {
			await command("project.save", { path: savedAs });
			await command("project.open", { path: savedAs });
			const current = await document();
			assert.equal(current.document.editor.cursorSize, 4.5);
			assert.equal(current.document.editor.cursorSpringStiffnessMultiplier, 1.8);
			assert.equal(current.document.editor.zoomInDurationMs, 777);
			assert.equal(current.document.editor.autoCaptionSettings.fontFamily, "Georgia");
			assert.equal((await command("project.inspect")).dirty, false);
		},
	);
	await step("system settings shortcuts directories HUD and passive catalogs", async () => {
		await command("settings.set", { theme: "dark", locale: "ru" });
		assert.equal((await command("settings.get")).locale, "ru");
		await command("shortcuts.set", { bindings: { splitClip: { key: "s", ctrl: true } } });
		assert.equal((await command("shortcuts.get")).bindings.splitClip.key, "s");
		const directory = path.join(runDir, "recordings");
		await fs.mkdir(directory);
		await command("settings.directories.set", { recordingsPath: directory });
		assert.equal((await command("settings.directories.get")).recordingsPath, directory);
		await command("settings.hud.set", { captureProtection: true });
		assert.equal((await command("settings.hud.get")).captureProtection, true);
		await command("wallpapers.add", { path: image });
		assert((await command("wallpapers.list")).custom.length > 0);
		await command("wallpapers.remove", { path: image });
		await command("fonts.list");
		await command("models.list");
		await command("jobs.list");
		await command("diagnostics.get");
		await command("logs.read", { id: "app", maxBytes: 1024 });
	});
	await step(
		"synthetic local extension install activate declared setting and uninstall",
		async () => {
			const source = path.join(runDir, "extension");
			await fs.mkdir(source);
			const id = "smoke.upgrade.fixture";
			await fs.writeFile(
				path.join(source, "recordly-extension.json"),
				JSON.stringify({
					id,
					name: "Upgrade fixture",
					version: "1.0.0",
					description: "Isolated test fixture",
					main: "index.js",
					permissions: ["ui"],
				}),
			);
			await fs.writeFile(
				path.join(source, "index.js"),
				'export function activate(api){api.registerSettingsPanel({id:"fixture",label:"Fixture",fields:[{id:"amount",label:"Amount",type:"slider",defaultValue:0.5,min:0,max:1,step:0.1}]});}\n',
			);
			await command("extensions.install", { path: source });
			await command("extensions.setEnabled", { id, enabled: true });
			const settings = await command("extensions.settings.get", { id });
			assert.equal(settings.values.amount, 0.5);
			await command("extensions.settings.set", { id, settingId: "amount", value: 0.7 });
			assert.equal((await command("extensions.settings.get", { id })).values.amount, 0.7);
			await command("extensions.uninstall", { id });
			assert(
				!(await command("extensions.list")).extensions.some(
					(item) => item.manifest.id === id,
				),
			);
		},
	);
	await step("safe rename updates the live project and dirty quit refuses", async () => {
		const renamed = await command("project.rename", { name: "Renamed fixture" });
		assert.equal((await command("project.inspect")).projectPath, renamed.path);
		await fs.access(renamed.path);
		report.artifacts.renamedProject = renamed.path;
		const live = await document();
		await mcp("editor.apply", {
			expectedRevision: live.revision,
			operations: [{ op: "settings.patch", values: { borderRadius: 32 } }],
		});
		// Keep the refusal inside the same SDK connection, before normal 1s autosave.
		const refused = await client.callTool({ name: "app_quit", arguments: {} });
		assert(refused.isError);
		assert.equal(refused.structuredContent.error.code, "UNSAVED_CHANGES");
		assert.equal((await command("app.status")).automationEnabled, true);
		await command("project.save");
	});
	const exported = path.join(runDir, "export.mp4");
	await step("real export survives MCP disconnect and produces ffprobe-valid MP4", async () => {
		const current = await document();
		const job = await mcp("export.start", {
			outputPath: exported,
			expectedRevision: current.revision,
			settings: {
				format: "mp4",
				quality: "good",
				mp4FrameRate: 24,
				backendPreference: "webcodecs",
				pipelineModel: "modern",
			},
		});
		assert(job?.id);
		await client.close();
		client = undefined;
		succeeded(await terminal(job));
		await probe(exported);
		await command("export.start", { outputPath: exported }, "OUTPUT_EXISTS");
		const listed = await command("jobs.list");
		assert(listed.jobs.some((item) => item.id === job.id));
		assert.equal((await command("jobs.get", { jobId: job.id })).state, "succeeded");
	});
	client = await connectMcp();
	await step("per-clip exported audio gain is independent of selected clip", async () => {
		const previous = await document();
		const totalMs = Math.round(previous.readiness.durationMs);
		const half = Math.round(totalMs / 2);
		const unit = { mixed: { volume: 1, normalize: false } };
		await command("editor.apply", {
			expectedRevision: previous.revision,
			operations: [
				// Trim replacement derives clips, so clear it before supplying the authored split.
				...[
					"trimRegions",
					"speedRegions",
					"zoomRegions",
					"annotationRegions",
					"audioRegions",
					"autoCaptions",
				].map((collection) => ({ op: "collection.replace", collection, values: [] })),
				{
					op: "collection.replace",
					collection: "clipRegions",
					values: [
						{ id: "rms-first", startMs: 0, endMs: half, speed: 1 },
						{ id: "rms-second", startMs: half, endMs: totalMs, speed: 1 },
					],
				},
				{
					op: "settings.patch",
					values: {
						wallpaper: "#223344",
						webcam: { enabled: false },
						defaultSourceAudioTrackSettings: unit,
						sourceAudioTrackSettingsByClip: {
							"rms-first": unit,
							"rms-second": { mixed: { volume: 0.2, normalize: false } },
						},
					},
				},
			],
		});
		await command("preview.control", {
			action: "select",
			collection: "clipRegions",
			id: "rms-second",
		});
		const target = path.join(runDir, "clip-gain-regression.mp4");
		const job = await mcp("export.start", {
			outputPath: target,
			settings: {
				quality: "good",
				mp4FrameRate: 24,
				backendPreference: "webcodecs",
				pipelineModel: "modern",
			},
		});
		succeeded(await terminal(job));
		await probe(target);
		const mean = async (start) => {
			const { stderr } = await execFile(
				process.env.FFMPEG_PATH || "ffmpeg",
				[
					"-hide_banner",
					"-loglevel",
					"info",
					"-ss",
					String(start),
					"-t",
					String(half / 2000),
					"-i",
					target,
					"-vn",
					"-af",
					"volumedetect",
					"-f",
					"null",
					"-",
				],
				{ timeout: 30000, maxBuffer: 1024 * 1024 },
			);
			const match = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s+dB/);
			assert(match, stderr);
			return Number(match[1]);
		};
		const firstDb = await mean(half / 4000);
		const secondDb = await mean(half / 1000 + half / 4000);
		const differenceDb = firstDb - secondDb;
		report.audioRmsRegression = {
			output: target,
			firstDb,
			secondDb,
			differenceDb,
			selectedClip: "rms-second",
			expectedSecondGain: 0.2,
		};
		assert(
			differenceDb >= 10 && differenceDb <= 18,
			`Per-clip RMS difference ${differenceDb}dB; expected about14dB`,
		);
		const current = await document();
		const restored = await command("editor.undo", { expectedRevision: current.revision });
		assert.deepEqual(restored.document, previous.document);
		await command("preview.control", { action: "select", collection: "clipRegions", id: null });
		await command("project.save");
	});
	await step("export cancellation and retry preserve durable frozen work", async () => {
		const target = path.join(runDir, "cancelled.mp4");
		const job = await mcp("export.start", {
			outputPath: target,
			settings: { quality: "high", mp4FrameRate: 60, backendPreference: "webcodecs" },
		});
		await mcp("jobs.cancel", { jobId: job.id });
		const cancelled = await terminal(job);
		assert.equal(cancelled.state, "cancelled", JSON.stringify(cancelled));
		await assert.rejects(fs.access(target));
		const retryPath = path.join(runDir, "retried.mp4");
		const retry = await command("jobs.retry", { jobId: job.id, outputPath: retryPath });
		succeeded(await terminal(retry));
		await probe(retryPath);
	});
	await step(
		"publication race retains a finished artifact for export.save without rerendering",
		async () => {
			const collision = path.join(runDir, "collision.mp4");
			const rescued = path.join(runDir, "rescued.mp4");
			const job = await mcp("export.start", {
				outputPath: collision,
				settings: { quality: "high", mp4FrameRate: 60, backendPreference: "webcodecs" },
			});
			await fs.writeFile(collision, "competing writer", { flag: "wx" });
			const failed = await terminal(job);
			assert.equal(failed.state, "failed", JSON.stringify(failed));
			assert.equal(await fs.readFile(collision, "utf8"), "competing writer");
			const recovery = await command("export.save", { jobId: job.id, outputPath: rescued });
			succeeded(await terminal(recovery));
			await probe(rescued);
		},
	);
	await step(
		"caption job extracts real audio and applies cues from an explicitly fake local Whisper runtime",
		async () => {
			const runtime = path.join(runDir, "fake-whisper.cjs");
			const model = path.join(runDir, "dummy-model.bin");
			await fs.writeFile(
				runtime,
				`#!${process.execPath}\nconst fs=require("node:fs");const args=process.argv.slice(2);const out=args[args.indexOf("-of")+1];if(!out)process.exit(2);fs.writeFileSync(out+".json",JSON.stringify({transcription:[{offsets:{from:0,to:1000},text:"Synthetic caption fixture"}]}));fs.writeFileSync(out+".srt","1\\n00:00:00,000 --> 00:00:01,000\\nSynthetic caption fixture\\n");\n`,
				{ mode: 0o700 },
			);
			await fs.writeFile(
				model,
				"Dummy test model: no speech model is downloaded or exercised.",
			);
			const current = await document();
			const job = await command("captions.generate", {
				executablePath: runtime,
				modelPath: model,
				language: "en",
				apply: true,
				expectedRevision: current.revision,
			});
			const finished = succeeded(await terminal(job));
			assert.equal(finished.result.applied, true, JSON.stringify(finished));
			assert(
				(await document()).document.editor.autoCaptions.some(
					(cue) => cue.text === "Synthetic caption fixture",
				),
			);
			await command("project.save");
		},
	);
	await client.close();
	client = undefined;
	await step("normal safe quit ends only the isolated application", async () => {
		await command("app.quit");
		const deadline = Date.now() + 15000;
		while (app.exitCode === null && app.signalCode === null) {
			assert(Date.now() < deadline, "Quit did not finish");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});
	report.success = true;
	report.finishedAt = new Date().toISOString();
} catch (error) {
	report.failedStep = currentStep;
	report.error = { message: error.message, stack: error.stack };
	await fs.writeFile(
		path.join(runDir, "failure.txt"),
		`${currentStep}\n${error.stack}\n${output}`,
	);
	console.error(`Upgrade smoke failed at ${currentStep}; ${path.join(runDir, "failure.txt")}`);
	process.exitCode = 1;
} finally {
	await client?.close().catch(() => undefined);
	if (app && app.exitCode === null && app.signalCode === null) {
		app.kill("SIGTERM");
		const force = setTimeout(() => app.kill("SIGKILL"), 2000);
		await new Promise((resolve) => app.once("exit", resolve));
		clearTimeout(force);
	}
	await fs.writeFile(path.join(runDir, "electron.log"), output);
	await fs.writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
	console.log(
		JSON.stringify(
			{
				success: report.success,
				checks: results.length,
				failedStep: report.failedStep,
				report: path.join(runDir, "report.json"),
			},
			null,
			2,
		),
	);
}
