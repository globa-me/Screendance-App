import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "darwin")
	throw new Error("The packaged automation launcher requires macOS.");
const output = path.join(root, "dist-automation", "native");
await fs.mkdir(output, { recursive: true });
const source = path.join(root, "electron/native/automation-launcher/main.swift");
const sdk = execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
	encoding: "utf8",
}).trim();
const binaries = [];
for (const [arch, target] of [
	["arm64", "arm64-apple-macos14.0"],
	["x64", "x86_64-apple-macos14.0"],
]) {
	const binary = path.join(output, `screendance-${arch}`);
	execFileSync("xcrun", ["swiftc", "-O", "-sdk", sdk, "-target", target, source, "-o", binary], {
		stdio: "inherit",
	});
	binaries.push(binary);
}
const universal = path.join(output, "screendance");
execFileSync("xcrun", ["lipo", "-create", ...binaries, "-output", universal], { stdio: "inherit" });
const architectures = execFileSync("xcrun", ["lipo", "-archs", universal], { encoding: "utf8" })
	.trim()
	.split(/\s+/);
if (!["arm64", "x86_64"].every((arch) => architectures.includes(arch)))
	throw new Error("CLI launcher must include arm64 and x64.");
await fs.chmod(universal, 0o755);
console.log(`Universal macOS14+ CLI launcher: ${universal}`);
