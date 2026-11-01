import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationClientError } from "../../cli/client";
import { parseArguments } from "../../cli/commands";
import { clientSetup, installCli } from "../../cli/install";
import { startAutomationSocket } from "./socketServer";

const execute = promisify(execFile);
const launcher = path.resolve("dist-automation/native/screendance");
let directory: string;
const cleanup: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "sd-cli-upgrade-"));
});
afterEach(async () => {
	for (const action of cleanup.splice(0).reverse()) await action();
	vi.unstubAllEnvs();
	await fs.rm(directory, { recursive: true, force: true });
});

function processResult(
	command: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
	return new Promise<{
		stdout: string;
		stderr: string;
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve, reject) => {
		const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ stdout, stderr, code, signal }));
	});
}

describe("generic CLI structured commands", () => {
	it("accepts strict nested editor edits and preserves exact opaque IDs", () => {
		const params = {
			expectedRevision: 4,
			operations: [
				{
					op: "settings.patch",
					values: { padding: { left: 12 }, autoCaptionSettings: { enabled: false } },
				},
				{ op: "clips.speed", id: "clip/raw:ID", speed: 1.5 },
			],
		};
		expect(
			parseArguments(["call", "editor.apply", "--params", JSON.stringify(params), "--json"]),
		).toMatchObject({ kind: "command", method: "editor.apply", params, json: true });
		expect(
			parseArguments([
				"recording",
				"configure",
				"--params",
				'{"microphoneDeviceId":"audio/raw:ID","microphoneEnabled":false}',
			]),
		).toMatchObject({
			method: "recording.configure",
			params: { microphoneDeviceId: "audio/raw:ID", microphoneEnabled: false },
		});
	});
	it("reads JSON from a path containing spaces and Cyrillic", async () => {
		const file = path.join(directory, "Параметры монтажа.json");
		const params = {
			outputPath: path.join(directory, "Мой фильм.mov"),
			settings: { transparentBackground: true, alphaFormat: "mov", mp4FrameRate: 24 },
		};
		await fs.writeFile(file, JSON.stringify(params));
		expect(parseArguments(["call", "export.start", "--params-file", file])).toMatchObject({
			method: "export.start",
			params,
		});
	});
	it.each([
		[
			"call",
			"editor.apply",
			"--params",
			'{"expectedRevision":4,"operations":[{"op":"settings.patch","values":{"padding":{"left":"12"}}}]}',
		],
		[
			"call",
			"editor.apply",
			"--params",
			'{"expectedRevision":4,"operations":[{"op":"settings.patch","values":{"arbitrary":true}}]}',
		],
		[
			"call",
			"export.start",
			"--params",
			'{"outputPath":"/tmp/a.mp4","settings":{"mp4FrameRate":17}}',
		],
		["call", "app.status", "--params", "null"],
		["call", "app.status", "--params", "[]"],
		["call", "app.status", "--params", "{"],
		["call", "not.a.command"],
		["call", "app.status", "--params", "{}", "--params-file", "ignored.json"],
	])("rejects malformed or invalid generic arguments %j", (...args) => {
		expect(() => parseArguments(args)).toThrow(AutomationClientError);
	});
	it("refuses oversized parameter files and missing files", async () => {
		const file = path.join(directory, "oversized.json");
		const handle = await fs.open(file, "w");
		await handle.truncate(16 * 1024 * 1024 + 1);
		await handle.close();
		expect(() => parseArguments(["call", "app.status", "--params-file", file])).toThrow(
			AutomationClientError,
		);
		expect(() =>
			parseArguments([
				"call",
				"app.status",
				"--params-file",
				path.join(directory, "missing"),
			]),
		).toThrow(AutomationClientError);
	});
	it("dispatches the built CLI through the real authenticated socket", async () => {
		const params = {
			expectedRevision: 4,
			operations: [
				{ op: "settings.patch", values: { showCursor: false, padding: { left: 12 } } },
			],
		};
		const endpoint = path.join(directory, "private/endpoint.json");
		const server = await startAutomationSocket({
			endpointPath: endpoint,
			dispatch: async (request) => {
				expect(request).toMatchObject({ method: "editor.apply", params });
				return { revision: 5, accepted: true };
			},
		});
		cleanup.push(() => server.close());
		const file = path.join(directory, "edits.json");
		await fs.writeFile(file, JSON.stringify(params));
		const result = await processResult(process.execPath, [
			path.resolve("dist-automation/screendance.mjs"),
			"--endpoint",
			endpoint,
			"call",
			"editor.apply",
			"--params-file",
			file,
			"--json",
		]);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({ revision: 5, accepted: true });
	});
});

beforeAll(async () => {
	await execute(process.execPath, ["scripts/build-automation.mjs"]);
});

describe("user CLI link installation", () => {
	it.each([
		["install", "--directory", "--bad"],
		["uninstall", "--directory", ""],
		["install", "--directory", "   "],
	])("rejects a missing installation directory: %j", (...args) => {
		expect(() => parseArguments(args)).toThrow(AutomationClientError);
	});
	async function nativeFixture() {
		const file = path.join(directory, "App with spaces/screendance");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		vi.stubEnv("SCREENDANCE_CLI_PATH", file);
		return file;
	}
	it("installs idempotently and removes only its own exact link", async () => {
		const target = await nativeFixture();
		const bin = path.join(directory, "user bin");
		const first = await installCli(bin);
		const second = await installCli(bin);
		expect(first).toEqual(second);
		expect(await fs.readlink(first.path)).toBe(await fs.realpath(target));
		await expect(installCli(bin, true)).resolves.toMatchObject({ installed: false });
		await expect(fs.lstat(first.path)).rejects.toThrow();
		await expect(fs.access(target)).resolves.toBeUndefined();
		await expect(installCli(bin, true)).resolves.toMatchObject({ installed: false });
	});
	it.each([
		"regular",
		"symlink",
		"dangling",
	])("preserves an unrelated %s at the requested CLI location", async (kind) => {
		await nativeFixture();
		const bin = path.join(directory, "bin");
		await fs.mkdir(bin);
		const destination = path.join(bin, "screendance");
		const unrelated = path.join(directory, "unrelated");
		if (kind === "regular") await fs.writeFile(destination, "user data");
		else {
			if (kind === "symlink") await fs.writeFile(unrelated, "user data");
			await fs.symlink(unrelated, destination);
		}
		await expect(installCli(bin)).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
		await expect(installCli(bin, true)).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
		if (kind === "regular") expect(await fs.readFile(destination, "utf8")).toBe("user data");
		else expect(await fs.readlink(destination)).toBe(unrelated);
	});
	it("prints safely quoted client setup without applying configuration changes", async () => {
		const native = await nativeFixture();
		for (const client of ["codex", "claude"])
			expect(clientSetup(client)).toMatchObject({
				client,
				applied: false,
				command: expect.stringContaining(`'${native}' mcp serve`),
			});
		expect(() => clientSetup("unsupported")).toThrow(AutomationClientError);
	});
});

const nativeAvailable = process.platform === "darwin" && existsSync(launcher);
describe.runIf(nativeAvailable)("packaged macOS runtime-independent launcher", () => {
	async function appFixture() {
		const bundle = path.join(directory, "App folder/Screendance Fixture.app");
		const contents = path.join(bundle, "Contents");
		const helper = path.join(contents, "Helpers/screendance");
		await fs.mkdir(path.dirname(helper), { recursive: true });
		await fs.mkdir(path.join(contents, "MacOS"), { recursive: true });
		await fs.mkdir(path.join(contents, "Resources/automation"), { recursive: true });
		await fs.copyFile(launcher, helper);
		await fs.chmod(helper, 0o755);
		await fs.writeFile(
			path.join(contents, "Info.plist"),
			'<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fake Runtime</string></dict></plist>',
		);
		await fs.writeFile(
			path.join(contents, "MacOS/Fake Runtime"),
			'#!/bin/sh\nexec "$SCREENDANCE_TEST_NODE" "$@"\n',
			{ mode: 0o755 },
		);
		await fs.writeFile(
			path.join(contents, "Resources/automation/screendance.mjs"),
			'const args=process.argv.slice(2);if(args[0]==="--signal"){process.kill(process.pid,"SIGTERM");}else{process.stdout.write(JSON.stringify({args,electronMode:process.env.ELECTRON_RUN_AS_NODE,bundle:process.env.SCREENDANCE_APP_BUNDLE,launcher:process.env.SCREENDANCE_CLI_PATH}));if(args[0]==="--exit")process.exit(7);}\n',
		);
		const bin = path.join(directory, "linked bin");
		await fs.mkdir(bin);
		const link = path.join(bin, "screendance");
		await fs.symlink(helper, link);
		return {
			bundle,
			helper,
			link,
			bin,
			env: {
				...process.env,
				SCREENDANCE_TEST_NODE: process.execPath,
				ELECTRON_RUN_AS_NODE: "incorrect-before-launch",
			},
		};
	}
	it("contains both architectures and macOS14 deployment targets", async () => {
		// Xcode tool discovery can contend with concurrent packaging. Bound each
		// child independently, then allow the test enough time for both to finish.
		const toolOptions = { timeout: 15_000, killSignal: "SIGKILL" as const };
		const arch = (await execute("xcrun", ["lipo", "-archs", launcher], toolOptions)).stdout
			.trim()
			.split(/\s+/);
		expect(new Set(arch)).toEqual(new Set(["arm64", "x86_64"]));
		const metadata = (await execute("xcrun", ["vtool", "-show-build", launcher], toolOptions))
			.stdout;
		expect(metadata.match(/minos\s+14\.0/g)).toHaveLength(2);
	}, 35_000);
	it("preserves arguments and runtime variables through an app path and symlink containing spaces", async () => {
		const app = await appFixture();
		const args = [
			"call",
			"editor.apply",
			"--params",
			'{"text":"two words $HOME $(touch nope)"}',
			"кириллица",
			"'quoted'",
		];
		const result = await processResult(app.link, args, { env: app.env });
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const reported = JSON.parse(result.stdout);
		expect({
			...reported,
			bundle: await fs.realpath(reported.bundle),
			launcher: await fs.realpath(reported.launcher),
		}).toEqual({
			args,
			electronMode: "1",
			bundle: await fs.realpath(app.bundle),
			launcher: await fs.realpath(app.helper),
		});
	});
	it("works when invoked by its bare command name through PATH", async () => {
		const app = await appFixture();
		const result = await processResult("screendance", ["app", "status"], {
			cwd: directory,
			env: { ...app.env, PATH: `${app.bin}:${process.env.PATH}` },
		});
		expect(result.code).toBe(0);
		const reported = JSON.parse(result.stdout);
		expect({ ...reported, launcher: await fs.realpath(reported.launcher) }).toMatchObject({
			args: ["app", "status"],
			launcher: await fs.realpath(app.helper),
		});
	});
	it("preserves exit status and signals through exec replacement", async () => {
		const app = await appFixture();
		expect((await processResult(app.helper, ["--exit"], { env: app.env })).code).toBe(7);
		expect((await processResult(app.helper, ["--signal"], { env: app.env })).signal).toBe(
			"SIGTERM",
		);
	});
	it("reports missing packaged runtime as a normal CLI error", async () => {
		const app = await appFixture();
		await fs.unlink(path.join(app.bundle, "Contents/MacOS/Fake Runtime"));
		const result = await processResult(app.helper, [], { env: app.env });
		expect(result.code).toBe(3);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("bundled automation runtime is missing");
	});
});

describe.runIf(process.platform === "darwin")("bundled GUI launch environment", () => {
	it("launches the containing app automatically and strips Electron's Node-mode flag", async () => {
		const endpoint = path.join(directory, "isolated/endpoint.json");
		const bundle = path.join(directory, "Fixture App.app");
		vi.stubEnv("SCREENDANCE_APP_BUNDLE", bundle);
		vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
		const launch = vi.fn(() => {
			const child = new EventEmitter();
			void startAutomationSocket({
				endpointPath: endpoint,
				dispatch: async () => ({ launched: true }),
			}).then(
				(server) => {
					cleanup.push(() => server.close());
					child.emit("exit", 0);
				},
				(error) => child.emit("error", error),
			);
			return child;
		});
		vi.resetModules();
		vi.doMock("node:child_process", async (original) => ({
			...(await original<typeof import("node:child_process")>()),
			spawn: launch,
		}));
		try {
			const { callAutomation } = await import("../../cli/client");
			await expect(
				callAutomation({ endpoint, timeoutMs: 3000 }, "app.status"),
			).resolves.toEqual({ launched: true });
			expect(launch).toHaveBeenCalledWith(
				"/usr/bin/open",
				["-g", "-a", bundle, "--args", "--automation"],
				expect.objectContaining({
					env: expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: expect.anything() }),
				}),
			);
			expect(process.env.ELECTRON_RUN_AS_NODE).toBe("1");
		} finally {
			vi.doUnmock("node:child_process");
			vi.resetModules();
		}
	});
});
