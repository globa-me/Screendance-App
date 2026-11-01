import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isMacCodeComponent } from "./macos-code-components.mjs";

test("signs Mach-O formats and code bundles while ordinary resources remain sealed by the parent", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "mac-code-components-"));
	try {
		for (const value of [
			0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf,
			0xbfbafeca,
		]) {
			const name = path.join(root, String(value));
			const bytes = Buffer.alloc(32);
			bytes.writeUInt32BE(value);
			writeFileSync(name, bytes);
			assert.equal(isMacCodeComponent(name), true);
		}
		for (const [name, bytes] of [
			["locale.pak", Buffer.from([4, 0, 0, 0, 10, 0])],
			["image.png", Buffer.from([137, 80, 78, 71, 13, 10])],
			["helper.sh", Buffer.from("#!/bin/sh\nexit 0")],
			["empty", Buffer.alloc(0)],
		]) {
			const file = path.join(root, name);
			writeFileSync(file, bytes);
			assert.equal(isMacCodeComponent(file), false);
		}
		for (const ext of [".app", ".framework", ".xpc", ".appex", ".bundle"]) {
			const file = path.join(root, `Code${ext}`);
			mkdirSync(file);
			assert.equal(isMacCodeComponent(file), true);
		}
		const resources = path.join(root, "Resources");
		mkdirSync(resources);
		assert.equal(isMacCodeComponent(resources), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
