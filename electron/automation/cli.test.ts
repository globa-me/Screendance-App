import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	AutomationClientError,
	callAutomation,
	endpointPath,
	exitCodeForError,
} from "../../cli/client";
import { parseArguments } from "../../cli/commands";
import { AUTOMATION_COMMANDS } from "../../shared/automation";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const action of cleanup.splice(0).reverse()) await action();
});

async function endpoint(
	handler: (request: Record<string, unknown>) => unknown,
	config: { split?: boolean; disconnect?: boolean } = {},
) {
	const dir = await mkdtemp(join(tmpdir(), "sc-cli-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const socketPath = join(dir, "api.sock");
	const descriptor = join(dir, "endpoint.json");
	let calls = 0;
	const server = createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
			calls++;
			if (config.disconnect) {
				socket.end();
				return;
			}
			const response = JSON.stringify({ id: request.id, ...(handler(request) as object) });
			if (config.split) {
				socket.write(response.slice(0, 4));
				setTimeout(() => socket.end(`${response.slice(4)}\n`), 5);
			} else socket.end(`${response}\n`);
		});
	});
	await new Promise<void>((done, reject) => {
		server.once("error", reject);
		server.listen(socketPath, done);
	});
	cleanup.push(() => new Promise<void>((done) => (server as Server).close(() => done())));
	await writeFile(
		descriptor,
		JSON.stringify({
			protocolVersion: 1,
			socketPath,
			token: "private-test-token-0123456789",
			pid: process.pid,
		}),
		{ mode: 0o600 },
	);
	return { descriptor, calls: () => calls };
}

describe("automation CLI argument contract", () => {
	it("resolves filesystem paths and accepts global options around commands", () => {
		expect(
			parseArguments([
				"project",
				"open",
				"clips/Мой фильм.scrdance",
				"--json",
				"--endpoint",
				"api.json",
			]),
		).toMatchObject({
			kind: "command",
			json: true,
			method: "project.open",
			params: { path: resolve("clips/Мой фильм.scrdance") },
			options: { endpoint: resolve("api.json") },
		});
		expect(
			parseArguments([
				"--dev",
				"preview",
				"render",
				"--output",
				"frame.png",
				"--time-ms",
				"5000",
			]),
		).toMatchObject({ params: { timeMs: 5000, outputPath: resolve("frame.png") } });
	});
	it.each([
		["app", "status", "junk"],
		["project", "open"],
		["video", "open", "a.mp4", "b.mp4"],
		["preview", "render", "--time-ms", "-1", "--output", "a.png"],
		["preview", "render", "--time-ms", "1", "--time-ms", "2", "--output", "a.png"],
		["--timeout-ms", "Infinity", "app", "status"],
		["--endpoint"],
		["mcp", "serve", "--wat"],
	])("rejects invalid invocation %j", (...args) => {
		expect(() => parseArguments(args)).toThrow(AutomationClientError);
	});
	it.each([
		[["sources", "select", "screen:42:0"], "sources.select", { sourceId: "screen:42:0" }],
		[["devices", "list"], "devices.list", {}],
		[["permissions", "request", "camera"], "permissions.request", { kind: "camera" }],
		[
			[
				"recording",
				"configure",
				"--microphone",
				"false",
				"--microphone-device",
				"device/raw+ID",
				"--webcam",
				"true",
				"--webcam-device",
				"camera:USB",
				"--system-audio",
				"true",
				"--countdown",
				"3",
			],
			"recording.configure",
			{
				microphoneEnabled: false,
				microphoneDeviceId: "device/raw+ID",
				webcamEnabled: true,
				webcamDeviceId: "camera:USB",
				systemAudioEnabled: true,
				countdownSeconds: 3,
			},
		],
		[["recording", "configure"], "recording.configure", {}],
		[["recording", "stop"], "recording.stop", {}],
		[["recording", "recover"], "recording.recover", {}],
		[["project", "list"], "project.list", {}],
		[["project", "save"], "project.save", {}],
		[
			["project", "save", "--output", "Мой проект.scrdance", "--overwrite"],
			"project.save",
			{ path: resolve("Мой проект.scrdance"), overwrite: true },
		],
	])("parses stage3 command %j", (args, method, params) => {
		expect(parseArguments(args as string[])).toMatchObject({ kind: "command", method, params });
	});
	it.each([
		["recording", "configure", "--microphone", "yes"],
		["recording", "configure", "--webcam", "1"],
		["recording", "configure", "--countdown", "11"],
		["recording", "configure", "--countdown", "1.5"],
		["recording", "configure", "--microphone", "true", "--microphone", "false"],
		["recording", "configure", "--webcam-device"],
		["permissions", "request", "photos"],
		["project", "save", "--overwrite", "false"],
		["project", "save", "--overwrite", "--overwrite"],
		["project", "save", "--output"],
		["recording", "start", "now"],
	])("rejects invalid stage3 invocation %j", (...args) => {
		expect(() => parseArguments(args)).toThrow(AutomationClientError);
	});
	it("provides stable distinct failure exit codes", () => {
		expect(exitCodeForError("INVALID_PARAMS")).toBe(2);
		expect(exitCodeForError("APP_NOT_RUNNING")).toBe(3);
		expect(exitCodeForError("UNAUTHORIZED")).toBe(4);
		expect(exitCodeForError("ACCESS_DENIED")).toBe(4);
		expect(exitCodeForError("TIMEOUT")).toBe(5);
		expect(exitCodeForError("BUSY")).toBe(1);
	});
	it("allows explicit descriptors independently of profile discovery", () => {
		expect(endpointPath({ endpoint: "custom.json", dev: true })).toBe(resolve("custom.json"));
	});
});

describe("CLI socket client", () => {
	it("authenticates one request and handles split response chunks", async () => {
		const host = await endpoint(
			(request) => {
				expect(request).toMatchObject({
					method: "project.inspect",
					params: {},
					token: "private-test-token-0123456789",
					protocolVersion: 1,
				});
				return { result: { title: "Мой проект", revision: 4 } };
			},
			{ split: true },
		);
		expect(await callAutomation({ endpoint: host.descriptor }, "project.inspect")).toEqual({
			title: "Мой проект",
			revision: 4,
		});
		expect(host.calls()).toBe(1);
	});
	it("preserves structured application errors", async () => {
		const host = await endpoint(() => ({
			error: { code: "UNSAVED_CHANGES", message: "Save first.", details: { dirty: true } },
		}));
		await expect(
			callAutomation({ endpoint: host.descriptor }, "project.open", {
				path: "/tmp/a.scrdance",
			}),
		).rejects.toMatchObject({ code: "UNSAVED_CHANGES", details: { dirty: true } });
	});
	it("does not repeat an ambiguous mutation after connection loss", async () => {
		const host = await endpoint(() => ({}), { disconnect: true });
		await expect(
			callAutomation({ endpoint: host.descriptor, launch: "/tmp/unused.app" }, "video.open", {
				path: "/tmp/a.mp4",
			}),
		).rejects.toMatchObject({ code: "CONNECTION_LOST" });
		expect(host.calls()).toBe(1);
	});
	it("refuses endpoint descriptors exposed to other users", async () => {
		const host = await endpoint(() => ({ result: {} }));
		await chmod(host.descriptor, 0o644);
		await expect(
			callAutomation({ endpoint: host.descriptor }, "app.status"),
		).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
		expect(host.calls()).toBe(0);
	});
	it("reports a missing endpoint without implicitly launching anything", async () => {
		await expect(
			callAutomation({ endpoint: `/tmp/sc-missing-${process.pid}.json` }, "app.status"),
		).rejects.toMatchObject({ code: "APP_NOT_RUNNING" });
	});
});

// MCP protocol integration runs against the built adapter, also verifying its stdout is clean.
describe("built stdio MCP adapter", () => {
	beforeAll(async () => {
		await new Promise<void>((done, reject) =>
			execFile(process.execPath, ["scripts/build-automation.mjs"], (error) =>
				error ? reject(error) : done(),
			),
		);
	});
	it("initializes and lists concrete tools with no running application", async () => {
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
		const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [
				resolve("dist-automation/screendance.mjs"),
				"--endpoint",
				`/tmp/sc-missing-${process.pid}.json`,
				"mcp",
				"serve",
			],
			stderr: "pipe",
		});
		const client = new Client(
			{ name: "screendance-cli-test", version: "1" },
			{ capabilities: {} },
		);
		try {
			await client.connect(transport);
			const listing = await client.listTools();
			expect(listing.tools.map((tool) => tool.name)).toEqual(
				AUTOMATION_COMMANDS.map((command) => command.name.replace(/\./g, "_")),
			);
			expect(
				listing.tools.find((tool) => tool.name === "recording_cancel")?.annotations
					?.destructiveHint,
			).toBe(true);
			expect(
				listing.tools.find((tool) => tool.name === "recording_configure")?.inputSchema,
			).toMatchObject({
				properties: {
					microphoneEnabled: { type: "boolean" },
					countdownSeconds: { type: "integer", minimum: 0, maximum: 10 },
				},
			});
			expect(
				listing.tools.find((tool) => tool.name === "project_inspect")?.annotations
					?.readOnlyHint,
			).toBe(true);
			const result = await client.callTool({ name: "app_status", arguments: {} });
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).toContain("APP_NOT_RUNNING");
		} finally {
			await client.close();
		}
	});
	it("routes MCP calls through the same authenticated socket", async () => {
		const host = await endpoint(() => ({ result: { project: "demo", dirty: false } }));
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
		const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
		const client = new Client(
			{ name: "screendance-cli-test", version: "1" },
			{ capabilities: {} },
		);
		try {
			await client.connect(
				new StdioClientTransport({
					command: process.execPath,
					args: [
						resolve("dist-automation/screendance.mjs"),
						"--endpoint",
						host.descriptor,
						"mcp",
						"serve",
					],
					stderr: "pipe",
				}),
			);
			const result = await client.callTool({ name: "project_inspect", arguments: {} });
			expect(result.structuredContent).toEqual({ result: { project: "demo", dirty: false } });
			expect(host.calls()).toBe(1);
		} finally {
			await client.close();
		}
	});
	it.each([
		true,
		false,
	])("only embeds the requested physical PNG through a symlinked parent (matches=%s)", async (matches) => {
		const dir = await mkdtemp(join(tmpdir(), "sc-preview-"));
		cleanup.push(() => rm(dir, { recursive: true, force: true }));
		const actualDir = join(dir, "actual");
		const linkedDir = join(dir, "linked");
		await mkdir(actualDir);
		await symlink(actualDir, linkedDir, "dir");
		const requestedPath = join(linkedDir, "frame.png");
		const bytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=",
			"base64",
		);
		await writeFile(requestedPath, bytes);
		const unrelatedPath = join(actualDir, "unrelated.png");
		await writeFile(unrelatedPath, bytes);
		const returnedPath = await realpath(matches ? requestedPath : unrelatedPath);
		const host = await endpoint((request) => {
			expect(request.params).toEqual({ timeMs: 50, outputPath: requestedPath });
			return { result: { outputPath: returnedPath, timeMs: 50, width: 1, height: 1 } };
		});
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
		const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
		const client = new Client(
			{ name: "screendance-preview-test", version: "1" },
			{ capabilities: {} },
		);
		try {
			await client.connect(
				new StdioClientTransport({
					command: process.execPath,
					args: [
						resolve("dist-automation/screendance.mjs"),
						"--endpoint",
						host.descriptor,
						"mcp",
						"serve",
					],
					stderr: "pipe",
				}),
			);
			const result = await client.callTool({
				name: "preview_render",
				arguments: { timeMs: 50, outputPath: requestedPath },
			});
			expect(result.isError).not.toBe(true);
			const images = (
				result.content as { type: string; mimeType?: string; data?: string }[]
			).filter((item) => item.type === "image");
			expect(images).toEqual(
				matches
					? [{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }]
					: [],
			);
		} finally {
			await client.close();
		}
	});
	it("emits a stable JSON error and exit code for CLI invocations", async () => {
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
			(done) => {
				const child = spawn(process.execPath, [
					resolve("dist-automation/screendance.mjs"),
					"--endpoint",
					`/tmp/sc-missing-${process.pid}.json`,
					"app",
					"status",
					"--json",
				]);
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (data) => {
					stdout += data;
				});
				child.stderr.on("data", (data) => {
					stderr += data;
				});
				child.on("close", (code) => done({ code, stdout, stderr }));
			},
		);
		expect(result.code).toBe(3);
		expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "APP_NOT_RUNNING" } });
		expect(result.stderr).toBe("");
	});
});
