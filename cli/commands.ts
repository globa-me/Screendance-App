import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	AUTOMATION_COMMANDS,
	AutomationError,
	validateAutomationRequest,
} from "../shared/automation";
import { AutomationClientError, type ClientOptions } from "./client";

export interface ParsedCommand {
	options: ClientOptions;
	json: boolean;
	kind: "command" | "mcp" | "help" | "install" | "uninstall" | "setup";
	directory?: string;
	client?: string;
	method?: string;
	params?: Record<string, unknown>;
}

const fail = (message: string): never => {
	throw new AutomationClientError("INVALID_ARGUMENT", message);
};

export function parseArguments(argv: string[]): ParsedCommand {
	const options: ClientOptions = {};
	const args: string[] = [];
	let json = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--dev") {
			options.dev = true;
			continue;
		}
		if (["--endpoint", "--timeout-ms", "--launch"].includes(arg)) {
			const value = argv[++index];
			if (!value || value.startsWith("--")) fail(`Missing value for ${arg}.`);
			if (arg === "--endpoint") options.endpoint = resolve(value);
			if (arg === "--launch") options.launch = resolve(value);
			if (arg === "--timeout-ms") {
				options.timeoutMs = Number(value);
				if (
					!/^\d+$/.test(value) ||
					!Number.isSafeInteger(options.timeoutMs) ||
					options.timeoutMs < 1 ||
					options.timeoutMs > 600_000
				)
					fail("timeout-ms must be an integer between 1 and 600000.");
			}
		} else args.push(arg);
	}
	const base = { options, json };
	if (!args.length || (args.length === 1 && ["--help", "-h", "help"].includes(args[0])))
		return { ...base, kind: "help" };
	const [group, action, ...rest] = args;
	if (["install", "uninstall"].includes(group)) {
		if (action === undefined) return { ...base, kind: group as "install" | "uninstall" };
		if (
			action === "--directory" &&
			rest.length === 1 &&
			rest[0].trim() &&
			!rest[0].startsWith("--")
		)
			return { ...base, kind: group as "install" | "uninstall", directory: resolve(rest[0]) };
		fail("install/uninstall accept only --directory PATH.");
	}
	if (group === "setup" && ["codex", "claude"].includes(action) && !rest.length)
		return { ...base, kind: "setup", client: action };
	if (group === "mcp" && action === "serve" && rest.length === 0) return { ...base, kind: "mcp" };
	const command = (method: string, params: Record<string, unknown> = {}): ParsedCommand => {
		try {
			const validated = validateAutomationRequest({ id: "cli", method, params });
			return { ...base, kind: "command", method: validated.method, params: validated.params };
		} catch (error) {
			if (error instanceof AutomationError) return fail(error.message);
			throw error;
		}
	};
	const parseParameters = (values: string[]) => {
		if (values.length === 0) return {};
		if (values.length !== 2 || !["--params", "--params-file"].includes(values[0]))
			fail("Use --params JSON or --params-file PATH.");
		try {
			let encoded = values[1];
			if (values[0] === "--params-file") {
				if (statSync(encoded).size > 16 * 1024 * 1024)
					fail("Parameter file exceeds 16 MiB.");
				encoded = readFileSync(encoded, "utf8");
			}
			return JSON.parse(encoded);
		} catch (error) {
			return fail(
				error instanceof Error
					? `Invalid JSON parameters: ${error.message}`
					: "Invalid JSON parameters.",
			);
		}
	};
	if (group === "call" && action) return command(action, parseParameters(rest));

	const method = `${group}.${action}`;
	const definition = AUTOMATION_COMMANDS.find((item) => item.name === method);
	if (definition && ["--params", "--params-file"].includes(rest[0]))
		return command(method, parseParameters(rest));
	if (
		definition &&
		Object.keys(definition.inputSchema.properties ?? {}).length === 0 &&
		rest.length === 0
	)
		return command(method);
	if (
		["project", "video"].includes(group) &&
		action === "open" &&
		rest.length === 1 &&
		!rest[0].startsWith("-")
	)
		return command(method, { path: resolve(rest[0]) });
	if (group === "sources" && action === "select" && rest.length === 1 && !rest[0].startsWith("-"))
		return command(method, { sourceId: rest[0] });
	if (group === "permissions" && action === "request" && rest.length === 1)
		return command(method, { kind: rest[0] });
	if (group === "project" && action === "save") {
		const params: Record<string, unknown> = {};
		for (let index = 0; index < rest.length; index++) {
			const flag = rest[index];
			if (flag === "--overwrite" && params.overwrite === undefined) params.overwrite = true;
			else if (flag === "--output" && params.path === undefined) {
				const value = rest[++index];
				if (!value || value.startsWith("--")) fail("Missing value for --output.");
				params.path = resolve(value);
			} else fail(`Unknown or duplicate save argument: ${flag}.`);
		}
		return command(method, params);
	}
	if (group === "recording" && action === "configure") {
		const flags: Record<string, { key: string; type: "boolean" | "string" | "integer" }> = {
			"--microphone": { key: "microphoneEnabled", type: "boolean" },
			"--microphone-device": { key: "microphoneDeviceId", type: "string" },
			"--system-audio": { key: "systemAudioEnabled", type: "boolean" },
			"--webcam": { key: "webcamEnabled", type: "boolean" },
			"--webcam-device": { key: "webcamDeviceId", type: "string" },
			"--countdown": { key: "countdownSeconds", type: "integer" },
		};
		const params: Record<string, unknown> = {};
		for (let index = 0; index < rest.length; index += 2) {
			const flag = rest[index];
			const spec = flags[flag];
			const value = rest[index + 1];
			if (!spec || Object.keys(params).includes(spec.key))
				fail(`Unknown or duplicate recording argument: ${flag}.`);
			if (!value || value.startsWith("--")) fail(`Missing value for ${flag}.`);
			if (spec.type === "boolean") {
				if (value !== "true" && value !== "false") fail(`${flag} requires true or false.`);
				params[spec.key] = value === "true";
			} else if (spec.type === "integer") {
				if (!/^\d+$/.test(value)) fail(`${flag} requires an integer from 0 to 10.`);
				params[spec.key] = Number(value);
			} else params[spec.key] = value;
		}
		return command(method, params);
	}
	if (group === "preview" && action === "render") {
		let timeMs: number | undefined;
		let outputPath: string | undefined;
		for (let index = 0; index < rest.length; index += 2) {
			const flag = rest[index];
			const value = rest[index + 1];
			if (!value || value.startsWith("--")) fail(`Missing value for ${flag}.`);
			if (flag === "--time-ms" && timeMs === undefined && /^\d+$/.test(value))
				timeMs = Number(value);
			else if (flag === "--output" && outputPath === undefined) outputPath = resolve(value);
			else fail(`Unknown, duplicate or invalid preview argument: ${flag}.`);
		}
		if (!Number.isSafeInteger(timeMs) || timeMs! < 0 || !outputPath)
			fail("preview render requires --time-ms NONNEGATIVE_INTEGER and --output PATH.");
		return command("preview.render", { timeMs, outputPath });
	}
	return fail("Unknown command or invalid arguments. Run screendance --help.");
}

export const helpText = `Screendance automation (bundled runtime in the macOS app; development requires Node.js 22+)

Usage: screendance [options] <command>

Commands:
  call METHOD [--params JSON | --params-file PATH]   All registered commands
  install|uninstall [--directory PATH]              User CLI link, default ~/.local/bin
  setup codex|claude                              Print MCP registration command
  app status
  app capabilities
  project open PATH
  project inspect
  project list
  project save [--output PATH] [--overwrite]
  sources list
  sources select SOURCE_ID
  devices list
  permissions status
  permissions request screen|accessibility|microphone|camera
  recording status
  recording configure [--microphone true|false] [--microphone-device ID]
    [--system-audio true|false] [--webcam true|false] [--webcam-device ID]
    [--countdown 0..10]
  recording start|pause|resume|stop|cancel|recover
  video open PATH
  preview render --time-ms N --output PATH
  mcp serve

Options:
  --json              Emit command result or error as JSON
  --endpoint PATH     Explicit endpoint descriptor (or SCREENDANCE_AUTOMATION_ENDPOINT)
  --dev               Discover the development app profile
  --timeout-ms N      Command timeout, 1–600000 (default 120000)
  --launch APP_PATH   Allow starting this macOS app with --automation if unavailable
  --help              Show this help

Paths are resolved relative to the working directory. Start the application with
--automation (or SCREENDANCE_AUTOMATION=1); --launch supplies that flag automatically.
The endpoint file contains a local access token. Keep it private.
The MCP server writes protocol messages only to stdout. Disconnecting the CLI or
MCP client leaves the application running. No client configuration is modified.

${AUTOMATION_COMMANDS.map((command) => `  ${command.name}: ${command.description}`).join("\n")}

Exit codes: 0 success, 1 operation failure, 2 invalid arguments, 3 unavailable
application/endpoint, 4 denied access, 5 timeout.
`;
