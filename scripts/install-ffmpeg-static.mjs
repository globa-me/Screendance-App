import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const maxAttempts = Number.parseInt(process.env.FFMPEG_STATIC_INSTALL_ATTEMPTS ?? "3", 10);
const baseDelayMs = Number.parseInt(process.env.FFMPEG_STATIC_INSTALL_DELAY_MS ?? "2000", 10);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	if (process.env.FFMPEG_STATIC_FORCE_INSTALL === "1") {
		rmSync(path.join(projectRoot, "node_modules", "ffmpeg-static", "ffmpeg"), { force: true });
	}

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const result = spawnSync(process.execPath, ["node_modules/ffmpeg-static/install.js"], {
			stdio: "inherit",
			cwd: projectRoot,
			env: process.env,
		});

		if (result.status === 0) {
			return;
		}

		if (attempt === maxAttempts) {
			process.exit(result.status ?? 1);
		}

		const delayMs = baseDelayMs * attempt;
		console.warn(
			`[ffmpeg-static] Install attempt ${attempt}/${maxAttempts} failed; retrying in ${delayMs}ms...`,
		);
		await sleep(delayMs);
	}
}

await main();
