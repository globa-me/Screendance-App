import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AUTOMATION_COMMANDS, validateAutomationRequest } from "../shared/automation";
import { AutomationClientError, type ClientOptions, callAutomation } from "./client";

export async function serveMcp(options: ClientOptions): Promise<Server> {
	const server = new Server(
		{ name: "screendance", version: "0.1.0" },
		{
			capabilities: { tools: {} },
			instructions:
				"Control the locally running Screendance App. Start with app_status and app_capabilities, inspect the live document before acting, and use preview_render to review the composed frame. Enable automation in the app first. preview_render uses source-media time, changes the playhead, and writes a new PNG without overwriting files. The application owns its lifetime and remains open when this server exits.",
		},
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: AUTOMATION_COMMANDS.map((command) => ({
			name: command.name.replace(/\./g, "_"),
			description: command.description,
			inputSchema: command.inputSchema,
			annotations: {
				readOnlyHint: command.readOnly,
				destructiveHint: "destructive" in command && command.destructive,
				idempotentHint: command.readOnly,
				openWorldHint: false,
			},
		})),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		try {
			const command = AUTOMATION_COMMANDS.find(
				(item) => item.name.replace(/\./g, "_") === request.params.name,
			);
			if (!command)
				throw new AutomationClientError(
					"UNKNOWN_COMMAND",
					`Unknown tool: ${request.params.name}.`,
				);
			const validated = validateAutomationRequest({
				id: "mcp",
				method: command.name,
				params: request.params.arguments ?? {},
			});
			const params = { ...validated.params };
			for (const key of ["path", "outputPath"])
				if (typeof params[key] === "string") params[key] = resolve(params[key]);
			const result = await callAutomation(options, command.name, params);
			const content: (
				| { type: "text"; text: string }
				| { type: "image"; mimeType: string; data: string }
			)[] = [{ type: "text", text: JSON.stringify(result) }];
			if (
				command.name === "preview.render" &&
				result &&
				typeof result === "object" &&
				"outputPath" in result &&
				typeof result.outputPath === "string" &&
				typeof params.outputPath === "string"
			) {
				try {
					const [requestedPath, returnedPath] = await Promise.all([
						realpath(params.outputPath),
						realpath(result.outputPath),
					]);
					if (requestedPath !== returnedPath)
						return { content, structuredContent: { result } };
					const info = await stat(returnedPath);
					if (info.isFile() && info.size <= 8 * 1024 * 1024) {
						const bytes = await readFile(returnedPath);
						if (
							bytes
								.subarray(0, 8)
								.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
						) {
							content.push({
								type: "image",
								mimeType: "image/png",
								data: bytes.toString("base64"),
							});
						}
					}
				} catch {
					/* The saved path remains available if an inline preview cannot be read. */
				}
			}
			return { content, structuredContent: { result } };
		} catch (error) {
			const failure =
				error && typeof error === "object" && "code" in error && "message" in error
					? {
							code: String(error.code),
							message: String(error.message),
							...("details" in error && error.details !== undefined
								? { details: error.details }
								: {}),
						}
					: {
							code: "INTERNAL_ERROR",
							message: error instanceof Error ? error.message : String(error),
						};
			return {
				isError: true,
				content: [{ type: "text" as const, text: JSON.stringify({ error: failure }) }],
				structuredContent: { error: failure },
			};
		}
	});
	await server.connect(new StdioServerTransport());
	return server;
}
