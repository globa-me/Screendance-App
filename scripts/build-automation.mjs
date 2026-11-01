import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const outfile = fileURLToPath(new URL("../dist-automation/screendance.mjs", import.meta.url));
await build({
	absWorkingDir: root,
	entryPoints: ["cli/index.ts"],
	outfile,
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	banner: {
		js: '#!/usr/bin/env node\nimport { createRequire as __automationCreateRequire } from "node:module"; const require = __automationCreateRequire(import.meta.url);',
	},
	logLevel: "info",
});
await chmod(outfile, 0o755);
