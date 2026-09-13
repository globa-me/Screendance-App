import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const { executeAppBuilderAsJson } = require("app-builder-lib/out/util/appBuilder");
const root = path.resolve(process.argv[2] || "release/notarized");
const requestedArchitectures = new Set((process.argv[3] || "arm64,x64").split(","));
const product = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).productName;
const run = (tool, args) => execFileSync(tool, args, { stdio: "inherit" });
const candidates = [
	{ arch: "arm64", app: path.join(root, "mac-arm64", `${product}.app`) },
	{ arch: "x64", app: path.join(root, "mac", `${product}.app`) },
]
	.filter((candidate) => requestedArchitectures.has(candidate.arch))
	.map((candidate) => ({
		...candidate,
		dmg: path.join(root, `${product}-${candidate.arch}.dmg`),
	}));

if (candidates.length === 0) {
	throw new Error("No supported macOS architectures were selected (expected arm64 and/or x64).");
}

// Fail closed: never generate release metadata for an unnotarized candidate.
for (const { app, dmg } of candidates) {
	run("codesign", ["--verify", "--deep", "--strict", app]);
	run("codesign", ["--verify", "--strict", dmg]);
	for (const file of [app, dmg]) run("xcrun", ["stapler", "validate", file]);
	run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
	run("spctl", [
		"--assess",
		"--type",
		"open",
		"--context",
		"context:primary-signature",
		"--verbose=4",
		dmg,
	]);
}

// Stapling changes the DMG bytes. Its blockmap and hashes must be refreshed.
for (const { dmg } of candidates) {
	await executeAppBuilderAsJson(["blockmap", "--input", dmg, "--output", `${dmg}.blockmap`]);
}
const metadataPath = path.join(root, "latest-mac.yml");
const metadata = yaml.load(readFileSync(metadataPath, "utf8"));
const names = readdirSync(root);
const resolveArtifact = (url) => {
	const name = names.find((entry) => entry === url || entry.replaceAll(" ", "-") === url);
	if (!name) throw new Error(`Missing update artifact: ${url}`);
	return path.join(root, name);
};
const hash = (file, algorithm, encoding) =>
	createHash(algorithm).update(readFileSync(file)).digest(encoding);
for (const file of metadata.files) {
	const artifact = resolveArtifact(file.url);
	file.size = statSync(artifact).size;
	file.sha512 = hash(artifact, "sha512", "base64");
}
metadata.sha512 = hash(resolveArtifact(metadata.path), "sha512", "base64");
writeFileSync(metadataPath, yaml.dump(metadata));
const checksumFiles = names
	.filter((name) => /\.(dmg|zip|blockmap)$/.test(name) || name === "latest-mac.yml")
	.sort();
writeFileSync(
	path.join(root, "SHA256SUMS.txt"),
	checksumFiles
		.map((name) => `${hash(path.join(root, name), "sha256", "hex")}  ${name}\n`)
		.join(""),
);
console.log(`Verified release and refreshed metadata: ${root}`);
