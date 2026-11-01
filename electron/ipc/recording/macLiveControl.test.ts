import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	deriveMicrophoneSidecarPath,
	handleNativeLiveCommandLine,
	parseSourceSwitchViewport,
	rejectPendingNativeLiveCommands,
	sendNativeLiveCommand,
} from "./macLiveControl";

function captureStdin() {
	const stdin = new PassThrough();
	const written: string[] = [];
	stdin.on("data", (chunk) => written.push(chunk.toString()));
	return { stdin, written };
}

describe("native live commands", () => {
	it("writes the command and resolves with the helper's JSON reply", async () => {
		const { stdin, written } = captureStdin();
		const pending = sendNativeLiveCommand(stdin, "source", { windowId: 42 });
		await new Promise((resolve) => setImmediate(resolve));
		expect(written.join("")).toBe('switch_source {"windowId":42}\n');

		expect(
			handleNativeLiveCommandLine(
				'SOURCE_SWITCHED {"viewport":{"x":0,"y":0,"width":1,"height":1}}',
			),
		).toBe(true);
		await expect(pending).resolves.toEqual({ viewport: { x: 0, y: 0, width: 1, height: 1 } });
	});

	it("rejects with the helper's failure message", async () => {
		const { stdin } = captureStdin();
		const pending = sendNativeLiveCommand(stdin, "microphone", { enabled: true });
		handleNativeLiveCommandLine("MICROPHONE_UPDATE_FAILED MICROPHONE_CAPTURE_UNAVAILABLE");
		await expect(pending).rejects.toThrow("MICROPHONE_CAPTURE_UNAVAILABLE");
	});

	it("allows one in-flight command per kind and rejects all on helper exit", async () => {
		const { stdin } = captureStdin();
		const first = sendNativeLiveCommand(stdin, "source", { displayId: 1 });
		await expect(sendNativeLiveCommand(stdin, "source", { displayId: 2 })).rejects.toThrow(
			"already in progress",
		);
		rejectPendingNativeLiveCommands("helper exited");
		await expect(first).rejects.toThrow("helper exited");
	});

	it("ignores unrelated output lines", () => {
		expect(handleNativeLiveCommandLine('AUDIO_LEVEL {"system":0}')).toBe(false);
		expect(handleNativeLiveCommandLine("Recording started")).toBe(false);
	});
});

describe("parseSourceSwitchViewport", () => {
	it("returns null for a full-frame source", () => {
		expect(
			parseSourceSwitchViewport({ viewport: { x: 0, y: 0, width: 1, height: 1 } }),
		).toBeNull();
	});

	it("returns the letterboxed content rect", () => {
		expect(
			parseSourceSwitchViewport({ viewport: { x: 0.125, y: 0, width: 0.75, height: 1 } }),
		).toEqual({ x: 0.125, y: 0, width: 0.75, height: 1 });
	});

	it("rejects malformed payloads", () => {
		expect(
			parseSourceSwitchViewport({ viewport: { x: 0, y: 0, width: 0, height: 1 } }),
		).toBeNull();
		expect(parseSourceSwitchViewport(null)).toBeNull();
	});
});

describe("deriveMicrophoneSidecarPath", () => {
	it("matches the helper's sidecar naming", () => {
		expect(deriveMicrophoneSidecarPath("/r/recording-1.mp4")).toBe("/r/recording-1.mic.m4a");
		expect(deriveMicrophoneSidecarPath("/r/recording-1.MOV")).toBe("/r/recording-1.mic.m4a");
	});
});
