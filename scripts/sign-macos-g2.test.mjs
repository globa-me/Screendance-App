import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createG2Signer } from "./sign-macos-g2.mjs";

const identity = "6E99F92E9A1BA1273CD084FAFE940A7280DB0A30";
function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "g2-signing-order-"));
	const app = path.join(root, "Screendance App.app");
	const macos = path.join(app, "Contents", "MacOS");
	mkdirSync(macos, { recursive: true });
	const launcher = path.join(macos, "screendance");
	const main = path.join(macos, "Screendance App");
	for (const file of [launcher, main]) {
		const bytes = Buffer.alloc(32);
		bytes.writeUInt32BE(0xcafebabe);
		writeFileSync(file, bytes);
	}
	const resource = path.join(macos, "data.bin");
	writeFileSync(resource, "not executable code");
	const perFile = {
		entitlements: "build/entitlements.mac.inherit.plist",
		hardenedRuntime: true,
		timestamp: "http://timestamp.apple.com/ts01",
		additionalArguments: ["--generate-entitlement-der"],
	};
	return {
		root,
		app,
		launcher,
		main,
		resource,
		perFile,
		options: {
			app,
			identity,
			binaries: [launcher],
			keychain: "/temporary/keychain",
			optionsForFile: async () => perFile,
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("signs and strictly verifies the launcher before the equal-depth Electron executable", async () => {
	const f = fixture();
	try {
		const calls = [];
		const signer = createG2Signer({
			selectIdentity: () => ({ sha1: identity }),
			execFile: async (command, args) => {
				await new Promise((resolve) => setImmediate(resolve));
				calls.push({ command, args });
			},
			signBundle: async (options) => {
				assert.equal(
					calls.length,
					2,
					"the native signature and verification must finish first",
				);
				assert.equal(options.identity, identity);
				assert.equal(options.optionsForFile, f.options.optionsForFile);
				assert.equal(
					options.ignore(f.launcher),
					true,
					"do not re-sign a child after sealing its parent",
				);
				assert.equal(options.ignore(f.main), false);
				assert.equal(options.ignore(f.app), false);
				assert.equal(options.ignore(f.resource), true);
				calls.push({ bundle: true });
			},
		});
		await signer({ ...f.options, binaries: [f.launcher, f.launcher] });
		assert.deepEqual(calls, [
			{
				command: "/usr/bin/codesign",
				args: [
					"--sign",
					identity,
					"--force",
					"--keychain",
					"/temporary/keychain",
					"--timestamp=http://timestamp.apple.com/ts01",
					"--options",
					"runtime",
					"--generate-entitlement-der",
					"--entitlements",
					"build/entitlements.mac.inherit.plist",
					f.launcher,
				],
			},
			{
				command: "/usr/bin/codesign",
				args: ["--verify", "--strict", "--verbose=2", f.launcher],
			},
			{ bundle: true },
		]);
	} finally {
		f.cleanup();
	}
});

test("refuses a mismatching identity before any signing operation", async () => {
	let called = false;
	const signer = createG2Signer({
		selectIdentity: () => ({ sha1: identity }),
		execFile: async () => {
			called = true;
		},
		signBundle: async () => {
			called = true;
		},
	});
	await assert.rejects(signer({ identity: "other" }), /does not match/);
	assert.equal(called, false);
});

test("does not seal the parent if the launcher signature or strict verification fails", async () => {
	const f = fixture();
	try {
		for (const failAt of [1, 2]) {
			let attempts = 0,
				parentSigned = false;
			const signer = createG2Signer({
				selectIdentity: () => ({ sha1: identity }),
				execFile: async () => {
					if (++attempts === failAt) throw new Error("native signing failed");
				},
				signBundle: async () => {
					parentSigned = true;
				},
			});
			await assert.rejects(signer(f.options), /native signing failed/);
			assert.equal(parentSigned, false);
		}
	} finally {
		f.cleanup();
	}
});

test("preserves builder ignore rules and filters additional non-code resources", async () => {
	const f = fixture();
	try {
		let attempts = 0;
		const signer = createG2Signer({
			selectIdentity: () => ({ sha1: identity }),
			execFile: async () => {
				attempts++;
			},
			signBundle: async (options) => {
				assert.equal(options.ignore(f.launcher), true);
				assert.equal(options.ignore(f.main), false);
				assert.equal(options.ignore(f.resource), true);
			},
		});
		await signer({
			...f.options,
			binaries: [f.launcher, f.resource],
			ignore: [/\/screendance$/],
		});
		assert.equal(attempts, 0);
	} finally {
		f.cleanup();
	}
});

test("requires explicit entitlements and Hardened Runtime for the native pre-sign", async () => {
	const f = fixture();
	try {
		let attempts = 0;
		const signer = createG2Signer({
			selectIdentity: () => ({ sha1: identity }),
			execFile: async () => {
				attempts++;
			},
			signBundle: async () => {
				attempts++;
			},
		});
		await assert.rejects(
			signer({ ...f.options, optionsForFile: () => ({ hardenedRuntime: true }) }),
			/entitlements are required/,
		);
		await assert.rejects(
			signer({
				...f.options,
				optionsForFile: () => ({ ...f.perFile, hardenedRuntime: false }),
			}),
			/Hardened Runtime is required/,
		);
		assert.equal(attempts, 0);
	} finally {
		f.cleanup();
	}
});
