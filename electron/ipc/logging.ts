import fs from "node:fs";
import path from "node:path";
import { app, ipcMain, clipboard } from "electron";

let logFilePath: string | null = null;
let originalLog: typeof console.log;
let originalWarn: typeof console.warn;
let originalError: typeof console.error;

function getLogFilePath(): string {
	if (!logFilePath) {
		logFilePath = path.join(app.getPath("userData"), "screendance.log");
	}
	return logFilePath;
}

export function initializeLogger() {
	const logFile = getLogFilePath();

	// Clear the log file on startup to prevent it from growing indefinitely
	try {
		fs.writeFileSync(logFile, `=== Screendance App Logs Started at ${new Date().toISOString()} ===\n`, "utf-8");
	} catch (err) {
		process.stderr.write(`Failed to initialize log file at ${logFile}: ${err}\n`);
	}

	originalLog = console.log;
	originalWarn = console.warn;
	originalError = console.error;

	const writeLog = (level: string, args: unknown[]) => {
		const timestamp = new Date().toISOString();
		const message = args
			.map((arg) => {
				if (arg instanceof Error) {
					return arg.stack || arg.message;
				}
				if (typeof arg === "object") {
					try {
						return JSON.stringify(arg, null, 2);
					} catch {
						return String(arg);
					}
				}
				return String(arg);
			})
			.join(" ");

		const logLine = `[${timestamp}] [${level}] ${message}\n`;

		// Write to the file
		try {
			fs.appendFileSync(logFile, logLine, "utf-8");
		} catch {
			// Ignore log write errors to prevent infinite loops
		}
	};

	console.log = (...args: unknown[]) => {
		originalLog.apply(console, args);
		writeLog("INFO", args);
	};

	console.warn = (...args: unknown[]) => {
		originalWarn.apply(console, args);
		writeLog("WARN", args);
	};

	console.error = (...args: unknown[]) => {
		originalError.apply(console, args);
		writeLog("ERROR", args);
	};

	// Log system details on startup
	console.log("System Platform:", process.platform);
	console.log("System Arch:", process.arch);
	console.log("Electron Version:", process.versions.electron);
	console.log("Chrome Version:", process.versions.chrome);
	console.log("Node Version:", process.versions.node);
}

export function registerLoggingIpcHandlers() {
	ipcMain.handle("get-app-logs", async () => {
		const logFile = getLogFilePath();
		try {
			if (fs.existsSync(logFile)) {
				return await fs.promises.readFile(logFile, "utf-8");
			}
			return "Log file does not exist.";
		} catch (err) {
			return `Failed to read log file: ${err}`;
		}
	});

	ipcMain.handle("clear-app-logs", async () => {
		const logFile = getLogFilePath();
		try {
			await fs.promises.writeFile(
				logFile,
				`=== Logs Cleared at ${new Date().toISOString()} ===\n`,
				"utf-8",
			);
			return { success: true };
		} catch (err) {
			return { success: false, error: String(err) };
		}
	});

	ipcMain.handle("write-clipboard-text", async (_, text: string) => {
		clipboard.writeText(text);
	});
}
