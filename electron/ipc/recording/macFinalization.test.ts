import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCaptureDiagnostics, RecordingSessionData } from "../types";

const mocks = vi.hoisted(() => ({
	context: {
		projectPath: "/projects/keep.scrdance" as string | null,
		videoPath: "/projects/original.mov" as string | null,
		session: {
			videoPath: "/projects/original.mov",
			webcamPath: "/projects/camera.mov",
			timeOffsetMs: 240,
		} as RecordingSessionData | null,
	},
	diagnostics: null as NativeCaptureDiagnostics | null,
	setProjectPath: vi.fn((target: string | null) => {
		mocks.context.projectPath = target;
	}),
	setVideoPath: vi.fn((target: string | null) => {
		mocks.context.videoPath = target;
	}),
	validate: vi.fn(async (_target: string) => ({
		fileSizeBytes: 102400,
		durationSeconds: 2.5 as number | null,
	})),
	snapshot: vi.fn(),
	persistCursor: vi.fn(async (_target: string) => {}),
	prune: vi.fn(async (_protected: string[]) => {}),
	isAuto: vi.fn((_target: string) => true),
	recordDiagnostics: vi.fn(),
	fileSize: vi.fn(async (_target: string) => 512),
}));

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("../cursor/telemetry", () => ({
	snapshotCursorTelemetryForPersistence: mocks.snapshot,
	persistPendingCursorTelemetry: mocks.persistCursor,
}));
vi.mock("../state", () => ({
	get lastNativeCaptureDiagnostics() {
		return mocks.diagnostics;
	},
	setCurrentProjectPath: mocks.setProjectPath,
	setCurrentVideoPath: mocks.setVideoPath,
	nativeCaptureMicrophonePath: null,
	nativeCaptureOutputBuffer: "",
	nativeCaptureStopRequested: false,
	nativeCaptureSystemAudioPath: null,
	nativeCaptureTargetPath: null,
	nativeScreenRecordingActive: false,
	selectedSource: null,
	setNativeCaptureMicrophonePath: vi.fn(),
	setNativeCaptureProcess: vi.fn(),
	setNativeCaptureStopRequested: vi.fn(),
	setNativeCaptureSystemAudioPath: vi.fn(),
	setNativeCaptureTargetPath: vi.fn(),
	setNativeScreenRecordingActive: vi.fn(),
}));
vi.mock("../utils", () => ({ isAutoRecordingPath: mocks.isAuto, moveFileWithOverwrite: vi.fn() }));
vi.mock("./diagnostics", () => ({
	validateRecordedVideo: mocks.validate,
	recordNativeCaptureDiagnostics: mocks.recordDiagnostics,
	getFileSizeIfPresent: mocks.fileSize,
}));
vi.mock("./events", () => ({ emitRecordingInterrupted: vi.fn() }));
vi.mock("./prune", () => ({ pruneAutoRecordings: mocks.prune }));

import { finalizeStoredVideo } from "./mac";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.context.projectPath = "/projects/keep.scrdance";
	mocks.context.videoPath = "/projects/original.mov";
	mocks.context.session = {
		videoPath: "/projects/original.mov",
		webcamPath: "/projects/camera.mov",
		timeOffsetMs: 240,
	};
	mocks.diagnostics = {
		backend: "mac-screencapturekit",
		phase: "stop",
		timestamp: "2026-10-24T05:00:00Z",
		outputPath: "/recordings/new-take.mov",
		sourceId: "screen:1:0",
	};
	mocks.validate.mockResolvedValue({ fileSizeBytes: 102400, durationSeconds: 2.5 });
	mocks.persistCursor.mockResolvedValue(undefined);
	mocks.isAuto.mockReturnValue(true);
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("native capture finalization context", () => {
	it("validates and persists a discarded take without replacing the existing editor project, video or session", async () => {
		const previous = { ...mocks.context };
		const result = await finalizeStoredVideo("/recordings/discarded.mov", {
			preserveProjectContext: true,
		});
		expect(result).toMatchObject({ success: true, path: "/recordings/discarded.mov" });
		expect(mocks.validate).toHaveBeenCalledExactlyOnceWith("/recordings/discarded.mov");
		expect(mocks.snapshot).toHaveBeenCalledTimes(1);
		expect(mocks.persistCursor).toHaveBeenCalledExactlyOnceWith("/recordings/discarded.mov");
		expect(mocks.prune).toHaveBeenCalledExactlyOnceWith(["/recordings/discarded.mov"]);
		expect(mocks.context).toEqual(previous);
		expect(mocks.context.session).toBe(previous.session);
		expect(mocks.setProjectPath).not.toHaveBeenCalled();
		expect(mocks.setVideoPath).not.toHaveBeenCalled();
		expect(mocks.recordDiagnostics).toHaveBeenCalledWith(
			expect.objectContaining({
				outputPath: "/recordings/discarded.mov",
				fileSizeBytes: 102400,
			}),
		);
		expect(mocks.validate.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.snapshot.mock.invocationCallOrder[0],
		);
		expect(mocks.snapshot.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.persistCursor.mock.invocationCallOrder[0],
		);
	});

	it.each([
		undefined,
		{ preserveProjectContext: false },
	])("keeps normal stop behavior and publishes the new source (options=%j)", async (options) => {
		const previousSession = mocks.context.session;
		expect(await finalizeStoredVideo("/recordings/kept.mov", options)).toMatchObject({
			success: true,
			path: "/recordings/kept.mov",
		});
		expect(mocks.context.videoPath).toBe("/recordings/kept.mov");
		expect(mocks.context.projectPath).toBeNull();
		expect(mocks.context.session).toBe(previousSession);
		expect(mocks.setVideoPath).toHaveBeenCalledExactlyOnceWith("/recordings/kept.mov");
		expect(mocks.setProjectPath).toHaveBeenCalledExactlyOnceWith(null);
		expect(mocks.validate).toHaveBeenCalledExactlyOnceWith("/recordings/kept.mov");
		expect(mocks.snapshot).toHaveBeenCalledTimes(1);
		expect(mocks.persistCursor).toHaveBeenCalledExactlyOnceWith("/recordings/kept.mov");
		expect(mocks.validate.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.setVideoPath.mock.invocationCallOrder[0],
		);
	});

	it.each([
		false,
		true,
	])("never changes editor context when validation fails (preserve=%s)", async (preserveProjectContext) => {
		const previous = { ...mocks.context };
		const validationError = new Error("Recorded video contains no valid frames");
		mocks.validate.mockRejectedValueOnce(validationError);
		await expect(
			finalizeStoredVideo("/recordings/invalid.mov", { preserveProjectContext }),
		).rejects.toBe(validationError);
		expect(mocks.context).toEqual(previous);
		expect(mocks.context.session).toBe(previous.session);
		expect(mocks.setVideoPath).not.toHaveBeenCalled();
		expect(mocks.setProjectPath).not.toHaveBeenCalled();
		expect(mocks.snapshot).not.toHaveBeenCalled();
		expect(mocks.persistCursor).not.toHaveBeenCalled();
		expect(mocks.prune).not.toHaveBeenCalled();
		expect(mocks.recordDiagnostics).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				outputPath: "/recordings/invalid.mov",
				fileSizeBytes: 512,
				error: validationError.message,
			}),
		);
	});

	it("retains preserved editor context even if cursor persistence fails after validation", async () => {
		const previous = { ...mocks.context };
		mocks.persistCursor.mockRejectedValueOnce(new Error("Cursor sidecar write failed"));
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(
			finalizeStoredVideo("/recordings/discarded.mov", { preserveProjectContext: true }),
		).resolves.toMatchObject({ success: true });
		expect(mocks.context).toEqual(previous);
		expect(mocks.context.session).toBe(previous.session);
		expect(mocks.setProjectPath).not.toHaveBeenCalled();
		expect(mocks.setVideoPath).not.toHaveBeenCalled();
		expect(mocks.validate).toHaveBeenCalledExactlyOnceWith("/recordings/discarded.mov");
		expect(mocks.persistCursor).toHaveBeenCalledExactlyOnceWith("/recordings/discarded.mov");
		expect(warning).toHaveBeenCalled();
	});
});
