import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Security boundaries between the renderer (including extensions) and main.
// See docs/audits/2026-11-04-mac-app-store-and-bugs/README.md, B1–B5.
describe("renderer security boundaries", () => {
	let tempRoot: string;
	let userDataPath: string;
	let tempPath: string;
	let appPath: string;
	let outsidePath: string;

	beforeEach(async () => {
		tempRoot = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), "screendance-security-")),
		);
		userDataPath = path.join(tempRoot, "UserData");
		tempPath = path.join(tempRoot, "Temp");
		appPath = path.join(tempRoot, "App");
		outsidePath = path.join(tempRoot, "Outside");
		await Promise.all(
			[userDataPath, tempPath, appPath, outsidePath].map((dir) =>
				fs.mkdir(dir, { recursive: true }),
			),
		);

		vi.resetModules();
		vi.doMock("electron", () => ({
			app: {
				isPackaged: false,
				getAppPath: () => appPath,
				getPath: (name: string) => {
					if (name === "userData") return userDataPath;
					if (name === "temp") return tempPath;
					return tempRoot;
				},
				setPath: () => undefined,
			},
		}));
	});

	afterEach(async () => {
		vi.resetModules();
		vi.doUnmock("electron");
		vi.unstubAllEnvs();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	describe("write destinations (B3)", () => {
		it("accepts only dialog-approved destinations", async () => {
			const { approveWriteDestination, isApprovedWriteDestination } = await import(
				"./ipc/utils"
			);
			const chosen = path.join(outsidePath, "export.mp4");
			expect(isApprovedWriteDestination(chosen)).toBe(false);
			approveWriteDestination(chosen);
			expect(isApprovedWriteDestination(chosen)).toBe(true);
			expect(isApprovedWriteDestination(path.join(outsidePath, "other.mp4"))).toBe(false);
		});

		it("allows the alpha .mov correction but not arbitrary extensions", async () => {
			const { approveWriteDestination, isApprovedWriteDestination } = await import(
				"./ipc/utils"
			);
			approveWriteDestination(path.join(outsidePath, "clip.webm"));
			expect(isApprovedWriteDestination(path.join(outsidePath, "clip.mov"))).toBe(true);
			expect(isApprovedWriteDestination(path.join(outsidePath, "clip.sh"))).toBe(false);
			expect(isApprovedWriteDestination(path.join(outsidePath, "clip.plist"))).toBe(false);
		});

		it("accepts the smoke-export output from the launch environment", async () => {
			const smokeOutput = path.join(outsidePath, "smoke.mp4");
			vi.stubEnv("RECORDLY_SMOKE_EXPORT", "1");
			vi.stubEnv("RECORDLY_SMOKE_EXPORT_OUTPUT", smokeOutput);
			const { isApprovedWriteDestination } = await import("./ipc/utils");
			expect(isApprovedWriteDestination(smokeOutput)).toBe(true);
			expect(isApprovedWriteDestination(`${smokeOutput}.report.json`)).toBe(true);
		});
	});

	describe("renderer reads (B4)", () => {
		it("refuses non-media files outside app-managed folders", async () => {
			const secret = path.join(outsidePath, "id_rsa");
			const project = path.join(outsidePath, "work.scrdance");
			await fs.writeFile(secret, "secret");
			await fs.writeFile(project, "{}");
			const { isRendererReadablePath } = await import("./fileAccessGuard");
			expect(isRendererReadablePath(secret)).toBe(false);
			expect(isRendererReadablePath(project)).toBe(false);
		});

		it("allows media files anywhere and anything in app-managed folders", async () => {
			const wallpaper = path.join(outsidePath, "wallpaper.jpg");
			const userDataFile = path.join(userDataPath, "extensions", "ext", "index.js");
			await fs.writeFile(wallpaper, "jpg");
			await fs.mkdir(path.dirname(userDataFile), { recursive: true });
			await fs.writeFile(userDataFile, "export {}");
			const { isRendererReadablePath } = await import("./fileAccessGuard");
			expect(isRendererReadablePath(wallpaper)).toBe(true);
			expect(isRendererReadablePath(userDataFile)).toBe(true);
		});

		it("refuses a media-named symlink that points at a non-media file", async () => {
			const secret = path.join(outsidePath, "token.json");
			const disguised = path.join(outsidePath, "innocent.png");
			await fs.writeFile(secret, "{}");
			await fs.symlink(secret, disguised);
			const { isRendererReadablePath } = await import("./fileAccessGuard");
			expect(isRendererReadablePath(disguised)).toBe(false);
		});

		it("never approves non-media session paths supplied by the renderer", async () => {
			const secret = path.join(outsidePath, "credentials");
			const video = path.join(outsidePath, "take.mov");
			await fs.writeFile(secret, "secret");
			await fs.writeFile(video, "mov");
			const { replaceApprovedSessionLocalReadPaths, isAllowedLocalReadPath } = await import(
				"./ipc/project/manager"
			);
			await replaceApprovedSessionLocalReadPaths([video, secret]);
			expect(isAllowedLocalReadPath(video)).toBe(true);
			expect(isAllowedLocalReadPath(secret)).toBe(false);
		});
	});

	describe("media server (B5)", () => {
		it("requires the launch token, refuses foreign origins and other methods", async () => {
			const video = path.join(outsidePath, "clip.mp4");
			await fs.writeFile(video, "video-bytes");
			const { ensureMediaServer, buildMediaUrl } = await import("./mediaServer");
			const { rememberApprovedLocalReadPath } = await import("./ipc/project/manager");
			await rememberApprovedLocalReadPath(video);

			const baseUrl = await ensureMediaServer();
			const goodUrl = buildMediaUrl(baseUrl, video);
			const tokenless = `${baseUrl}/video?path=${encodeURIComponent(video)}`;

			const ok = await fetch(goodUrl, { headers: { Origin: "https://evil.example" } });
			expect(ok.status).toBe(200);
			expect(await ok.text()).toBe("video-bytes");
			expect(ok.headers.get("access-control-allow-origin")).toBeNull();

			expect((await fetch(tokenless)).status).toBe(403);
			expect((await fetch(`${tokenless}&token=wrong`)).status).toBe(403);
			expect((await fetch(goodUrl, { method: "POST" })).status).toBe(405);
			const preflight = await fetch(goodUrl, {
				method: "OPTIONS",
				headers: { Origin: "https://evil.example" },
			});
			expect(preflight.status).toBe(403);
		});

		it("grants CORS only to the app's dev renderer origin", async () => {
			vi.stubEnv("VITE_DEV_SERVER_URL", "http://localhost:5173/");
			const { getAllowedCorsOrigin } = await import("./mediaServer");
			expect(getAllowedCorsOrigin("http://localhost:5173")).toBe("http://localhost:5173");
			expect(getAllowedCorsOrigin("https://evil.example")).toBeNull();
			expect(getAllowedCorsOrigin(undefined)).toBeNull();
		});
	});

	describe("whisper executable (B2)", () => {
		it("runs only executables the user picked in the main-process dialog", async () => {
			vi.doMock("./ipc/paths/binaries", () => ({
				getBundledWhisperExecutableCandidates: () => [],
			}));
			const fakeWhisper = path.join(outsidePath, "whisper-cli");
			await fs.writeFile(fakeWhisper, "#!/bin/sh\n", { mode: 0o755 });
			const {
				isTrustedWhisperExecutablePath,
				resolveWhisperExecutablePath,
				trustWhisperExecutablePath,
				UntrustedWhisperExecutableError,
			} = await import("./ipc/captions/generate");

			expect(await isTrustedWhisperExecutablePath("/bin/sh")).toBe(false);
			await expect(
				resolveWhisperExecutablePath("/bin/sh", { requireTrusted: true }),
			).rejects.toBeInstanceOf(UntrustedWhisperExecutableError);

			await trustWhisperExecutablePath(fakeWhisper);
			expect(await isTrustedWhisperExecutablePath(fakeWhisper)).toBe(true);
			await expect(
				resolveWhisperExecutablePath(fakeWhisper, { requireTrusted: true }),
			).resolves.toBe(fakeWhisper);
			vi.doUnmock("./ipc/paths/binaries");
		});
	});
});
