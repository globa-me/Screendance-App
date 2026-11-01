import { execFile as execFileCallback } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { isMacCodeComponent } from "./macos-code-components.mjs";
import { selectG2Identity } from "./macos-g2-signing.mjs";

const require = createRequire(import.meta.url);
const { sign } = require("app-builder-lib/out/codeSign/macCodeSign");
const execFile = promisify(execFileCallback);

function isIgnored(ignore, file) {
	return (Array.isArray(ignore) ? ignore : [ignore]).some((rule) => {
		if (!rule) return false;
		return typeof rule === "function" ? Boolean(rule(file)) : Boolean(file.match(rule));
	});
}

async function nativeSigningArguments(options, file, identity) {
	const perFile = options.optionsForFile ? await options.optionsForFile(file) : options;
	if (typeof perFile?.entitlements !== "string" || !perFile.entitlements)
		throw new Error(`Explicit inherited entitlements are required for native binary: ${file}`);
	if (perFile.hardenedRuntime === false)
		throw new Error(`Hardened Runtime is required for native binary: ${file}`);
	const args = ["--sign", identity, "--force"];
	if (options.keychain) args.push("--keychain", options.keychain);
	if (perFile.requirements) {
		if (perFile.requirements.startsWith("=")) args.push(`-r${perFile.requirements}`);
		else args.push("--requirements", perFile.requirements);
	}
	args.push(perFile.timestamp ? `--timestamp=${perFile.timestamp}` : "--timestamp");
	const flags = Array.isArray(perFile.signatureFlags)
		? perFile.signatureFlags
		: (perFile.signatureFlags ?? "")
				.split(",")
				.map((flag) => flag.trim())
				.filter(Boolean);
	args.push("--options", [...new Set([...flags, "runtime"])].join(","));
	args.push(...(perFile.additionalArguments ?? []), "--entitlements", perFile.entitlements, file);
	return args;
}

// electron-builder 26 replaces the selected SHA-1 with an ambiguous common
// name in its default signer. Keep the fingerprint through to osx-sign.
export function createG2Signer(dependencies = {}) {
	const selectIdentity = dependencies.selectIdentity ?? selectG2Identity;
	const signBundle = dependencies.signBundle ?? sign;
	const codesign = dependencies.execFile ?? execFile;
	return async function signMacG2(options) {
		const certificate = selectIdentity();
		if (options.identity !== certificate.sha1) {
			throw new Error("Builder signing identity does not match the selected G2 certificate.");
		}
		const signed = new Set();
		const ignored = (file) => isIgnored(options.ignore, file) || !isMacCodeComponent(file);
		// osx-sign sorts only by depth. Additional MacOS executables tie with the
		// main executable, whose signature already validates sibling nested code.
		// Sign explicit native binaries first, then let osx-sign seal their parents.
		const binaries = [...new Set(options.binaries ?? [])]
			.map((file) => path.resolve(file))
			.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
		for (const file of binaries) {
			if (ignored(file) || !statSync(file).isFile()) continue;
			await codesign(
				"/usr/bin/codesign",
				await nativeSigningArguments(options, file, certificate.sha1),
			);
			await codesign("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", file]);
			signed.add(file);
		}
		await signBundle({
			...options,
			identity: certificate.sha1,
			ignore: (file) => signed.has(path.resolve(file)) || ignored(file),
		});
	};
}

export default createG2Signer();
