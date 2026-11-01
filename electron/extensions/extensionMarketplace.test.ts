import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	root: "",
	manifestId: "com.example.fixture",
	entries: ["recordly-extension.json", "index.js"],
	archiveBytes: 100,
	archiveFiles: 2,
	attributes: "-rw-r--r--",
	extracted: 0,
	install: vi.fn(async (_source: string) => ({ manifest: { id: "com.example.fixture" } })),
}));
vi.mock("electron", () => ({
	app: { isPackaged: true, getPath: () => mocks.root, getVersion: () => "1.5.0" },
}));
vi.mock("./extensionLoader", () => ({
	getRegisteredExtensions: () => [],
	installExtensionFromPath: mocks.install,
}));
vi.mock("node:child_process", () => ({
	execFile: (
		_command: string,
		args: string[],
		_options: unknown,
		callback: (error: Error | null, stdout?: string) => void,
	) => {
		if (args[0] === "-Z") {
			const output =
				args[1] === "-l"
					? `${mocks.attributes} 3.0 unx 100 tx fixture\n${mocks.archiveFiles} files, ${mocks.archiveBytes} bytes uncompressed, 50 bytes compressed: 50%\n`
					: `${mocks.entries.join("\n")}\n`;
			callback(null, output);
			return;
		}
		const target = args[args.indexOf("-d") + 1];
		mocks.extracted++;
		void (async () => {
			await fs.writeFile(
				path.join(target, "recordly-extension.json"),
				JSON.stringify({
					id: mocks.manifestId,
					name: "Fixture",
					version: "1",
					main: "index.js",
					permissions: [],
				}),
			);
			await fs.writeFile(path.join(target, "index.js"), "export function activate() {};");
		})().then(
			() => callback(null, ""),
			(error) => callback(error),
		);
	},
}));

import { downloadAndInstallExtension } from "./extensionMarketplace";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(async () => {
	vi.clearAllMocks();
	mocks.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sd-market-")));
	mocks.manifestId = "com.example.fixture";
	mocks.entries = ["recordly-extension.json", "index.js"];
	mocks.archiveBytes = 100;
	mocks.archiveFiles = 2;
	mocks.attributes = "-rw-r--r--";
	mocks.extracted = 0;
	vi.stubEnv("SCREENDANCE_MARKETPLACE_URL", "https://market.example");
	fetchMock.mockImplementation(async () => new Response("fixture archive"));
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await fs.rm(mocks.root, { recursive: true, force: true });
});

describe("marketplace installation boundary", () => {
	it("uses the existing transactional installer only after catalog identity and archive inventory pass", async () => {
		expect(
			await downloadAndInstallExtension(
				"com.example.fixture",
				"https://market.example/archive.zip",
			),
		).toEqual({ success: true });
		expect(mocks.extracted).toBe(1);
		expect(mocks.install).toHaveBeenCalledOnce();
		expect(await fs.readdir(mocks.root)).toEqual([]);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://market.example/archive.zip",
			expect.objectContaining({ redirect: "manual" }),
		);
	});
	it.each([
		"../outside",
		"a/b",
		"",
		"..",
	])("refuses unsafe ids before network or filesystem work: %s", async (id) => {
		expect(
			await downloadAndInstallExtension(id, "https://market.example/archive.zip"),
		).toMatchObject({ success: false });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await fs.readdir(mocks.root)).toEqual([]);
	});
	it("refuses untrusted origins and cross-origin redirects before downloading their bodies", async () => {
		expect(
			await downloadAndInstallExtension(
				"com.example.fixture",
				"https://evil.example/archive.zip",
			),
		).toMatchObject({ success: false });
		expect(fetchMock).not.toHaveBeenCalled();
		fetchMock.mockResolvedValueOnce(
			new Response("", {
				status: 302,
				headers: { location: "https://evil.example/archive.zip" },
			}),
		);
		expect(
			await downloadAndInstallExtension(
				"com.example.fixture",
				"https://market.example/archive.zip",
			),
		).toMatchObject({ success: false, error: expect.stringContaining("untrusted origin") });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(mocks.install).not.toHaveBeenCalled();
		expect(await fs.readdir(mocks.root)).toEqual([]);
	});
	it("rejects downloaded identity mismatches without replacing an installed extension", async () => {
		mocks.manifestId = "other.extension";
		expect(
			await downloadAndInstallExtension(
				"com.example.fixture",
				"https://market.example/archive.zip",
			),
		).toMatchObject({ success: false, error: expect.stringContaining("does not match") });
		expect(mocks.install).not.toHaveBeenCalled();
		expect(await fs.readdir(mocks.root)).toEqual([]);
	});
	it.each([
		"../outside.js",
		"/absolute.js",
		"C:/outside.js",
		"folder/../../outside.js",
	])("rejects escaping archive names before extraction: %s", async (entry) => {
		mocks.entries = [entry];
		expect(
			await downloadAndInstallExtension(
				"com.example.fixture",
				"https://market.example/archive.zip",
			),
		).toMatchObject({ success: false });
		expect(mocks.extracted).toBe(0);
		expect(mocks.install).not.toHaveBeenCalled();
	});
	it("rejects symlink archives and excessive expanded sizes before extraction", async () => {
		mocks.attributes = "lrwxrwxrwx";
		expect(
			await downloadAndInstallExtension(
				"com.example.fixture",
				"https://market.example/archive.zip",
			),
		).toMatchObject({ success: false });
		expect(mocks.extracted).toBe(0);
		mocks.attributes = "-rw-r--r--";
		mocks.archiveBytes = 600 * 1024 * 1024;
		expect(
			await downloadAndInstallExtension(
				"com.example.fixture",
				"https://market.example/archive.zip",
			),
		).toMatchObject({ success: false });
		expect(mocks.extracted).toBe(0);
	});
	it("rejects archives over the download limit and cleans the owned temporary folder", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response("", { headers: { "content-length": String(129 * 1024 * 1024) } }),
		);
		expect(
			await downloadAndInstallExtension(
				"com.example.fixture",
				"https://market.example/archive.zip",
			),
		).toMatchObject({ success: false, error: expect.stringContaining("128 MiB") });
		expect(mocks.install).not.toHaveBeenCalled();
		expect(await fs.readdir(mocks.root)).toEqual([]);
	});
});
