import { AutomationClientError, callAutomation, exitCodeForError } from "./client";
import { helpText, parseArguments } from "./commands";

// Keep startup failures off stdout when invoked as an MCP transport.
let mcpMode = process.argv.includes("mcp") && process.argv.includes("serve");

async function main() {
	const command = parseArguments(process.argv.slice(2));
	mcpMode = command.kind === "mcp";
	if (command.kind === "help") {
		process.stdout.write(helpText);
		return;
	}
	if (command.kind === "mcp") {
		const { serveMcp } = await import("./mcp");
		await serveMcp(command.options);
		return;
	}
	if (["install", "uninstall", "setup"].includes(command.kind)) {
		const { installCli, clientSetup } = await import("./install");
		const result =
			command.kind === "setup"
				? clientSetup(command.client!)
				: await installCli(command.directory, command.kind === "uninstall");
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	const result = await callAutomation(command.options, command.method!, command.params);
	process.stdout.write(`${JSON.stringify(result, null, command.json ? undefined : 2)}\n`);
}

main().catch((error: unknown) => {
	const failure =
		error instanceof AutomationClientError
			? {
					code: error.code,
					message: error.message,
					...(error.details === undefined ? {} : { details: error.details }),
				}
			: {
					code: "INTERNAL_ERROR",
					message: error instanceof Error ? error.message : String(error),
				};
	if (process.argv.includes("--json") && !mcpMode)
		process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
	else process.stderr.write(`${failure.code}: ${failure.message}\n`);
	process.exitCode = exitCodeForError(failure.code);
});
