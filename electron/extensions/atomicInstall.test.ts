import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceExtensionDirectory } from "./atomicInstall";

let root: string;
let source: string;
let target: string;
beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sd-ext-")));
	source = path.join(root, "source");
	target = path.join(root, "installed");
	await fs.mkdir(source);
	await fs.mkdir(target);
	await fs.writeFile(path.join(source, "index.js"), "new version");
	await fs.writeFile(path.join(target, "index.js"), "working version");
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});
async function clean() {
	expect((await fs.readdir(root)).filter((entry) => entry.startsWith("."))).toEqual([]);
}

describe("transactional extension replacement", () => {
	it("keeps the old version until a complete staged copy is validated and then commits", async () => {
		const commit = vi.fn(async () => {
			expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("new version");
		});
		await replaceExtensionDirectory(
			source,
			target,
			async (staging) => {
				expect(await fs.readFile(path.join(staging, "index.js"), "utf8")).toBe(
					"new version",
				);
				expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe(
					"working version",
				);
			},
			commit,
		);
		expect(commit).toHaveBeenCalledOnce();
		expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("new version");
		await clean();
	});
	it("preserves the installed version if staging validation fails", async () => {
		const commit = vi.fn(async () => {});
		await expect(
			replaceExtensionDirectory(
				source,
				target,
				async () => {
					throw new Error("Invalid entry point");
				},
				commit,
			),
		).rejects.toThrow("Invalid entry point");
		expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("working version");
		expect(commit).not.toHaveBeenCalled();
		await clean();
	});
	it("restores the old directory if publishing the staged version fails", async () => {
		const rename = fs.rename.bind(fs);
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (path.basename(String(from)).startsWith(".install-"))
				throw new Error("Simulated disk failure");
			return rename(from, to);
		});
		await expect(
			replaceExtensionDirectory(
				source,
				target,
				async () => {},
				async () => {},
			),
		).rejects.toThrow("Simulated disk failure");
		expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("working version");
		await clean();
	});
	it("restores the old directory if metadata persistence fails after publication", async () => {
		await expect(
			replaceExtensionDirectory(
				source,
				target,
				async () => {},
				async () => {
					throw new Error("Cannot save extension state");
				},
			),
		).rejects.toThrow("Cannot save extension state");
		expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("working version");
		await clean();
	});
	it("does not remove a different directory that replaces the target during installation", async () => {
		await expect(
			replaceExtensionDirectory(
				source,
				target,
				async () => {
					await fs.rename(target, path.join(root, "previous"));
					await fs.mkdir(target);
					await fs.writeFile(path.join(target, "index.js"), "newer user install");
				},
				async () => {},
			),
		).rejects.toThrow("target changed");
		expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("newer user install");
		await clean();
	});
	it("refuses self installs, descendant sources and symlink targets", async () => {
		await expect(
			replaceExtensionDirectory(
				target,
				target,
				async () => {},
				async () => {},
			),
		).rejects.toThrow("separate directories");
		await fs.symlink(source, path.join(root, "alias"));
		await expect(
			replaceExtensionDirectory(
				source,
				path.join(root, "alias"),
				async () => {},
				async () => {},
			),
		).rejects.toThrow("regular directory");
		expect(await fs.readFile(path.join(source, "index.js"), "utf8")).toBe("new version");
	});
});
