/** Real Electron + CLI + official MCP client smoke, isolated from the user's profile. */
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
const smokeRoot = path.join(root, ".tmp");
await fs.mkdir(smokeRoot, { recursive: true });
const runDir = await fs.mkdtemp(path.join(smokeRoot, "automation-smoke-"));
const endpoint = path.join(runDir, "profile", "automation", "endpoint.json");
const video = path.join(runDir, "Тест video.mp4");
const project = path.join(runDir, "Тест project.scrdance");
const cli = path.join(root, "dist-automation", "screendance.mjs");
const electron = path.join(
	root,
	"node_modules",
	"electron",
	"dist",
	"Electron.app",
	"Contents",
	"MacOS",
	"Electron",
);
let output = "";
let app;
let client;
let captureFixture;

async function command(args, expectedCode = 0) {
	try {
		const { stdout } = await execFile(
			process.execPath,
			[cli, "--endpoint", endpoint, "--json", ...args],
			{ cwd: root, timeout: 125_000, maxBuffer: 4 * 1024 * 1024 },
		);
		assert.equal(expectedCode, 0, "Command should have failed");
		return JSON.parse(stdout);
	} catch (error) {
		if (expectedCode === 0) throw error;
		assert.equal(error.code, expectedCode);
		const response = JSON.parse(error.stdout);
		await fs.appendFile(
			path.join(runDir, "expected-errors.jsonl"),
			`${JSON.stringify({ args, response })}\n`,
		);
		return response;
	}
}

try {
	await fs.access(cli);
	await fs.access(path.join(root, "dist-electron", "main.cjs"));
	await execFile(process.env.FFMPEG_PATH || "ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=640x360:rate=24",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:sample_rate=48000",
		"-t",
		"3",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		video,
	]);
	await fs.writeFile(
		project,
		JSON.stringify({
			version: 1,
			projectId: "automation-smoke",
			videoPath: video,
			editor: {
				aspectRatio: "9:16",
				wallpaper: "#315efb",
				padding: { top: 48, right: 48, bottom: 48, left: 48 },
				borderRadius: 24,
				showCursor: false,
			},
		}),
	);
	app = spawn(electron, [root, "--automation"], {
		cwd: root,
		env: {
			...process.env,
			SCREENDANCE_USER_DATA_DIR: path.join(runDir, "profile"),
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
	const deadline = Date.now() + 25_000;
	while (true) {
		try {
			await fs.access(endpoint);
			break;
		} catch {
			/* Wait for the private host descriptor. */
		}
		if (app.exitCode !== null) throw new Error(`Electron exited: ${app.exitCode}\n${output}`);
		if (Date.now() > deadline) throw new Error(`Electron did not publish endpoint\n${output}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const status = await command(["app", "status"]);
	assert.equal(status.automationEnabled, true);
	const capabilities = await command(["app", "capabilities"]);
	assert(capabilities.commands.length >= 21);
	const permissions = await command(["permissions", "status"]);
	await fs.writeFile(path.join(runDir, "permissions.json"), JSON.stringify(permissions, null, 2));
	const recorderStatus = await command(["recording", "status"]);
	assert.equal(recorderStatus.phase, "idle");
	const devices = await command(["devices", "list"]);
	assert(Array.isArray(devices.microphones) && Array.isArray(devices.cameras));
	const configured = await command([
		"recording",
		"configure",
		"--microphone",
		"false",
		"--system-audio",
		"false",
		"--webcam",
		"false",
		"--countdown",
		"0",
	]);
	assert.equal(configured.settings.microphoneEnabled, false);
	assert.equal(configured.settings.webcamEnabled, false);
	assert.equal(configured.settings.countdownSeconds, 0);
	assert.equal((await command(["recording", "pause"], 1)).error.code, "NOT_RECORDING");
	const opened = await command(["project", "open", project]);
	await fs.writeFile(path.join(runDir, "opened.json"), JSON.stringify(opened, null, 2));
	assert.equal(opened.project.projectId, "automation-smoke");
	assert.equal(opened.project.editor.aspectRatio, "9:16");
	assert.equal(opened.readiness.previewReady, true);
	const cliPng = path.join(runDir, "cli-preview.png");
	const preview = await command(["preview", "render", "--time-ms", "1000", "--output", cliPng]);
	assert.equal(preview.composition, "frame-renderer");
	assert.equal(preview.width, 720);
	assert.equal(preview.height, 1280);
	const inspected = await command(["project", "inspect"]);
	await fs.writeFile(path.join(runDir, "inspected.json"), JSON.stringify(inspected, null, 2));
	assert.equal(inspected.dirty, false);
	assert.equal(
		(await command(["preview", "render", "--time-ms", "1000", "--output", cliPng], 1)).error
			.code,
		"OUTPUT_EXISTS",
	);
	assert.equal(
		(
			await command(
				[
					"preview",
					"render",
					"--time-ms",
					"999999",
					"--output",
					path.join(runDir, "invalid.png"),
				],
				2,
			)
		).error.code,
		"INVALID_PARAMS",
	);
	await command(["project", "open", project]); // Reopening the same source must not deadlock readiness.
	client = new Client({ name: "screendance-desktop-smoke", version: "1.0.0" });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "--endpoint", endpoint, "mcp", "serve"],
			stderr: "pipe",
		}),
	);
	const tools = await client.listTools();
	assert.equal(tools.tools.length, capabilities.commands.length);
	const mcpInspection = await client.callTool({ name: "project_inspect", arguments: {} });
	assert.equal(mcpInspection.isError, undefined);
	assert.equal(mcpInspection.structuredContent.result.project.projectId, "automation-smoke");
	const mcpPng = path.join(runDir, "mcp-preview.png");
	const mcpPreview = await client.callTool({
		name: "preview_render",
		arguments: { timeMs: 1500, outputPath: mcpPng },
	});
	assert.equal(mcpPreview.isError, undefined);
	assert(mcpPreview.content.some((item) => item.type === "image"));
	const savedAs = path.join(runDir, "Сохранённый project.scrdance");
	const mcpSave = await client.callTool({ name: "project_save", arguments: { path: savedAs } });
	assert.equal(mcpSave.isError, undefined);
	assert.equal(mcpSave.structuredContent.result.path, savedAs);
	const savedJson = JSON.parse(await fs.readFile(savedAs, "utf8"));
	assert.equal(savedJson.projectId, "automation-smoke");
	assert.equal(savedJson.editor.aspectRatio, "9:16");
	assert.equal((await command(["project", "inspect"])).dirty, false);
	await command(["project", "save"]); // Current project can be saved again without overwrite.
	assert.equal(
		(await command(["project", "save", "--output", project], 1)).error.code,
		"OUTPUT_EXISTS",
	);
	await command(["project", "save", "--output", project, "--overwrite"]);
	const library = await command(["project", "list"]);
	assert(library.entries.some((entry) => entry.path === project));
	await command(["project", "open", savedAs]);
	assert.equal((await command(["project", "inspect"])).dirty, false);
	await client.close();
	client = undefined;
	assert.equal((await command(["app", "status"])).automationEnabled, true);
	let codexVerified = false;
	let claudeCodeConnectionVerified = false;
	if (process.env.SCREENDANCE_SMOKE_CLAUDE) {
		const claudeProfile = path.join(runDir, "claude-profile");
		await fs.mkdir(claudeProfile, { mode: 0o700 });
		const claudeOptions = {
			cwd: runDir,
			timeout: 30_000,
			env: { ...process.env, CLAUDE_CONFIG_DIR: claudeProfile },
			maxBuffer: 1024 * 1024,
		};
		await execFile(
			process.env.SCREENDANCE_SMOKE_CLAUDE,
			[
				"--bare",
				"mcp",
				"add",
				"--scope",
				"user",
				"--transport",
				"stdio",
				"screendance",
				"--",
				process.execPath,
				cli,
				"--endpoint",
				endpoint,
				"mcp",
				"serve",
			],
			claudeOptions,
		);
		const health = await execFile(
			process.env.SCREENDANCE_SMOKE_CLAUDE,
			["--bare", "mcp", "get", "screendance"],
			claudeOptions,
		);
		await fs.writeFile(path.join(runDir, "claude-mcp-health.txt"), health.stdout);
		assert(
			health.stdout.includes("Connected"),
			"Claude Code must establish a real MCP connection",
		);
		claudeCodeConnectionVerified = true;
	}
	if (process.argv.includes("--codex")) {
		const config = {
			"mcp_servers.screendance.command": JSON.stringify(process.execPath),
			"mcp_servers.screendance.args": JSON.stringify([
				cli,
				"--endpoint",
				endpoint,
				"mcp",
				"serve",
			]),
			"mcp_servers.screendance.required": "true",
			"mcp_servers.screendance.enabled_tools": JSON.stringify([
				"app_status",
				"project_inspect",
				"project_list",
				"recording_status",
			]),
		};
		const args = [
			"exec",
			"--ignore-user-config",
			"--ignore-rules",
			"--ephemeral",
			"--skip-git-repo-check",
			"--sandbox",
			"read-only",
			"-C",
			runDir,
			"--json",
		];
		for (const [key, value] of Object.entries(config)) args.push("-c", `${key}=${value}`);
		args.push(
			"Test the screendance MCP connection. Call ONLY its app_status, project_inspect, project_list and recording_status tools once each. Do not use shell, files, or other tools. Report the app version and projectId returned by these tools.",
		);
		const codexRun = execFile("codex", args, {
			cwd: runDir,
			timeout: 120_000,
			maxBuffer: 4 * 1024 * 1024,
		});
		// Codex appends piped stdin to the prompt, so explicitly send EOF.
		codexRun.child.stdin.end();
		const response = await codexRun.catch(async (error) => {
			await fs.writeFile(path.join(runDir, "codex.jsonl"), error.stdout || "");
			await fs.writeFile(path.join(runDir, "codex.stderr.log"), error.stderr || "");
			throw error;
		});
		await fs.writeFile(path.join(runDir, "codex.jsonl"), response.stdout);
		await fs.writeFile(path.join(runDir, "codex.stderr.log"), response.stderr);
		const events = response.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const completed = events.filter(
			(event) =>
				event.type === "item.completed" &&
				event.item?.type === "mcp_tool_call" &&
				event.item?.server === "screendance" &&
				event.item?.status === "completed",
		);
		assert(
			completed.some((event) => event.item.tool === "app_status"),
			"Codex must call real app_status MCP tool",
		);
		assert(
			completed.some((event) => event.item.tool === "project_inspect"),
			"Codex must call real project_inspect MCP tool",
		);
		for (const tool of ["project_list", "recording_status"])
			assert(
				completed.some((event) => event.item.tool === tool),
				`Codex must call real ${tool} MCP tool`,
			);

		codexVerified = true;
	}
	const webcam = path.join(runDir, "Тест video-webcam.mp4");
	await fs.copyFile(video, webcam);
	await fs.writeFile(
		path.join(runDir, "Тест video.recordly-session.json"),
		JSON.stringify({
			version: 2,
			videoFileName: path.basename(video),
			webcamFileName: path.basename(webcam),
			timeOffsetMs: 321,
		}),
	);
	const imported = await command(["video", "open", video]);
	assert.equal(imported.project.editor.webcam.sourcePath, webcam);
	assert.equal(imported.project.editor.webcam.timeOffsetMs, 321);
	assert.equal(imported.project.editor.webcam.enabled, true);
	const refused = await command(["project", "open", project], 1);
	assert.equal(refused.error.code, "UNSAVED_CHANGES");
	const importedSave = path.join(runDir, "fresh-import.recordly");
	await command(["project", "save", "--output", importedSave]);
	const savedImport = JSON.parse(await fs.readFile(importedSave, "utf8"));
	assert.equal(savedImport.editor.webcam.sourcePath, webcam);
	await command(["project", "open", importedSave]);
	assert.equal((await command(["project", "inspect"])).dirty, false);
	let recordingVerified = false;
	let recordingSkippedReason =
		"Pass --record to test real native capture of a generated fixture window.";
	if (process.argv.includes("--record")) {
		if (permissions.screen !== "granted" || permissions.accessibility !== true) {
			recordingSkippedReason =
				"Existing screen/accessibility permissions are not granted; smoke does not open permission dialogs.";
		} else {
			const fixtureTitle = `Screendance Capture Fixture ${path.basename(runDir)}`;
			const fixtureScript = path.join(runDir, "capture-fixture.cjs");
			const fixtureHtml = `<html><body style="margin:0;background:#315efb;color:white;font:32px system-ui"><h1>Capture fixture</h1><canvas width="640" height="260"></canvas><script>const c=document.querySelector('canvas').getContext('2d');function draw(t){c.fillStyle='#315efb';c.fillRect(0,0,640,260);c.fillStyle='#ffb74d';c.fillRect((t/5)%540,70,100,100);requestAnimationFrame(draw)}requestAnimationFrame(draw)</script></body></html>`;
			await fs.writeFile(
				fixtureScript,
				`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:680,height:420,title:${JSON.stringify(fixtureTitle)}});w.loadURL(${JSON.stringify("data:text/html;charset=utf-8,")}+encodeURIComponent(${JSON.stringify(fixtureHtml)}));w.on('page-title-updated',e=>e.preventDefault());});`,
			);
			captureFixture = spawn(electron, [fixtureScript], { cwd: root, stdio: "ignore" });
			let fixtureSource;
			for (let attempt = 0; attempt < 30 && !fixtureSource; attempt++) {
				const available = await command(["sources", "list"]);
				fixtureSource = available.sources.find(
					(source) => source.windowTitle === fixtureTitle || source.name === fixtureTitle,
				);
				if (!fixtureSource) await new Promise((resolve) => setTimeout(resolve, 250));
			}
			assert(
				fixtureSource,
				"Generated fixture window must be available; never fall back to an unrelated window/screen",
			);
			await command(["sources", "select", fixtureSource.id]);
			await command(["recording", "configure", "--countdown", "3"]);
			const countdownStart = command(["recording", "start"], 1);
			for (let attempt = 0; attempt < 30; attempt++) {
				if ((await command(["recording", "status"])).phase === "countdown") break;
				await new Promise((resolve) => setTimeout(resolve, 40));
			}
			assert.equal((await command(["recording", "cancel"])).countdownCancelled, true);
			const countdownResult = await countdownStart;
			assert.equal(countdownResult.error.code, "CANCELLED", JSON.stringify(countdownResult));
			await command(["recording", "configure", "--countdown", "0"]);
			assert.equal((await command(["recording", "start"])).recording, true);
			await new Promise((resolve) => setTimeout(resolve, 1000));
			await command(["recording", "pause"]);
			assert.equal((await command(["recording", "status"])).phase, "paused");
			await new Promise((resolve) => setTimeout(resolve, 250));
			await command(["recording", "resume"]);
			await new Promise((resolve) => setTimeout(resolve, 1000));
			client = new Client({ name: "screendance-recording-smoke", version: "1.0.0" });
			await client.connect(
				new StdioClientTransport({
					command: process.execPath,
					args: [cli, "--endpoint", endpoint, "mcp", "serve"],
					stderr: "pipe",
				}),
			);
			const mcpStop = await client.callTool({ name: "recording_stop", arguments: {} });
			assert.equal(mcpStop.isError, undefined);
			const stopped = mcpStop.structuredContent.result;
			await client.close();
			client = undefined;
			assert(
				stopped.session.videoPath.startsWith(runDir),
				"Captured recording must use the isolated profile",
			);
			await fs.access(stopped.session.videoPath);
			const probe = await execFile("ffprobe", [
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"json",
				stopped.session.videoPath,
			]);
			assert(Number(JSON.parse(probe.stdout).format.duration) > 0);
			const capturedProject = path.join(runDir, "captured.scrdance");
			await command(["project", "save", "--output", capturedProject]);
			assert.equal(
				JSON.parse(await fs.readFile(capturedProject, "utf8")).videoPath,
				stopped.session.videoPath,
			);
			await command(["recording", "start"]);
			await new Promise((resolve) => setTimeout(resolve, 500));
			const cancelled = await command(["recording", "cancel"]);
			assert.equal(cancelled.cancelled, true);
			assert.deepEqual(cancelled.retainedPaths, []);
			assert.equal((await command(["recording", "status"])).phase, "idle");
			await fs.access(stopped.session.videoPath); // Cancel must preserve the prior saved recording.
			await command(["project", "save"]);
			assert.equal((await command(["project", "inspect"])).projectPath, capturedProject);
			recordingVerified = true;
			recordingSkippedReason = null;
		}
	}

	const report = {
		success: true,
		platform: process.platform,
		arch: process.arch,
		electronArch: status.arch,
		cli: true,
		permissions,
		recorderConfiguration: true,
		projectSaving: true,
		recordingVerified,
		recordingSkippedReason,
		mcpSdk: true,
		codexVerified,
		claudeCodeConnectionVerified,
		claudeCodeModelCallsVerified: false,
		tests: [
			"status",
			"capabilities",
			"project.open",
			"project.inspect",
			"composed CLI PNG",
			"no overwrite",
			"range validation",
			"same-source reopen",
			"MCP discovery",
			"MCP inspect",
			"MCP inline PNG",
			"disconnect keeps app alive",
			"video.open",
			"fresh import webcam session",
			"dirty protection",
			"permissions status",
			"recorder status/devices/configuration",
			"idle transition guard",
			"MCP project save-as",
			"CLI current save",
			"overwrite protection + explicit overwrite",
			"library list",
			"saved project roundtrip",
			"fresh import saved with webcam",
		],
		artifacts: { project, cliPng, mcpPng },
	};
	await fs.writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	await fs.writeFile(path.join(runDir, "failure.txt"), `${error.stack}\n${output}`);
	console.error(`Automation smoke failed. Diagnostics: ${path.join(runDir, "failure.txt")}`);
	throw error;
} finally {
	await client?.close();
	if (captureFixture && captureFixture.exitCode === null) captureFixture.kill("SIGTERM");
	if (app && app.exitCode === null) {
		app.kill("SIGTERM");
		const force = setTimeout(() => app.kill("SIGKILL"), 2000);
		await new Promise((resolve) => app.once("exit", resolve));
		clearTimeout(force);
	}
	await fs.writeFile(path.join(runDir, "electron.log"), output);
}
