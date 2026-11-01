import { spawnSync } from "node:child_process";
import { selectG2Identity } from "./macos-g2-signing.mjs";

try {
	if (process.platform !== "darwin") throw new Error("G2 release builds require macOS.");
	const certificate = selectG2Identity();
	console.log(`[g2-signing] Selected ${JSON.stringify(certificate)}`);
	if (!process.argv.includes("--check")) {
		const result = spawnSync(
			"npm",
			[
				"run",
				"build:mac:package",
				"--",
				...process.argv.slice(2),
				`--config.mac.identity=${certificate.sha1}`,
				"--publish=never",
			],
			{
				stdio: "inherit",
				env: { ...process.env, G2_SIGNING_SHA1: certificate.sha1 },
			},
		);
		if (result.error) throw result.error;
		process.exitCode = result.status ?? 1;
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
