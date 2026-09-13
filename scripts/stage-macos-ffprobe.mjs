import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const cacheRoot = path.join(projectRoot, ".tmp", "ffprobe-packages");
const destinationRoot = path.join(projectRoot, "node_modules", "ffprobe-static", "bin", "darwin");

const targets = [
	{
		arch: "arm64",
		packageSpec: "@ffprobe-installer/darwin-arm64@5.0.1",
		archiveName: "ffprobe-installer-darwin-arm64-5.0.1.tgz",
	},
	{
		arch: "x64",
		packageSpec: "@ffprobe-installer/darwin-x64@5.1.0",
		archiveName: "ffprobe-installer-darwin-x64-5.1.0.tgz",
	},
];

await mkdir(cacheRoot, { recursive: true });

for (const target of targets) {
	const archivePath = path.join(cacheRoot, target.archiveName);
	try {
		execFileSync("test", ["-f", archivePath]);
	} catch {
		execFileSync(
			process.platform === "win32" ? "npm.cmd" : "npm",
			["pack", target.packageSpec, "--pack-destination", cacheRoot],
			{ cwd: projectRoot, stdio: "inherit" },
		);
	}

	const extractionRoot = path.join(cacheRoot, `extract-${target.arch}`);
	await mkdir(extractionRoot, { recursive: true });
	execFileSync("tar", ["-xzf", archivePath, "-C", extractionRoot, "package/ffprobe"]);

	const destinationDir = path.join(destinationRoot, target.arch);
	const destinationPath = path.join(destinationDir, "ffprobe");
	await mkdir(destinationDir, { recursive: true });
	await copyFile(path.join(extractionRoot, "package", "ffprobe"), destinationPath);
	await chmod(destinationPath, 0o755);
	console.log(`[ffprobe-static] Staged ${target.arch} binary -> ${destinationPath}`);
}
