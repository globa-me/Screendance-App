import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "darwin") {
	console.log("[ffmpeg-static] Universal staging skipped outside macOS.");
	process.exit(0);
}

const projectRoot = process.cwd();
const ffmpegPath = path.join(projectRoot, "node_modules", "ffmpeg-static", "ffmpeg");
const cacheRoot = path.join(projectRoot, ".tmp", "ffmpeg-static");
const installerPath = path.join(projectRoot, "scripts", "install-ffmpeg-static.mjs");
await mkdir(cacheRoot, { recursive: true });

const slices = [];
for (const arch of ["arm64", "x64"]) {
	execFileSync(process.execPath, [installerPath], {
		cwd: projectRoot,
		stdio: "inherit",
		env: {
			...process.env,
			npm_config_arch: arch,
			npm_config_platform: "darwin",
			FFMPEG_STATIC_FORCE_INSTALL: "1",
		},
	});
	const slicePath = path.join(cacheRoot, `ffmpeg-darwin-${arch}`);
	await copyFile(ffmpegPath, slicePath);
	slices.push(slicePath);
}

execFileSync("lipo", ["-create", ...slices, "-output", ffmpegPath], { stdio: "inherit" });
await chmod(ffmpegPath, 0o755);
execFileSync("lipo", ["-info", ffmpegPath], { stdio: "inherit" });
