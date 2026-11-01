import { describe, expect, it } from "vitest";
import {
	AUTOMATION_COMMANDS,
	AutomationError,
	validateAutomationRequest,
} from "../../shared/automation";

const request = (method: string, params?: unknown) =>
	validateAutomationRequest({ id: "test", method, ...(params === undefined ? {} : { params }) });

describe("external automation contract", () => {
	it("keeps all command names unique and publishes closed parameter objects", () => {
		expect(new Set(AUTOMATION_COMMANDS.map((command) => command.name)).size).toBe(
			AUTOMATION_COMMANDS.length,
		);
		for (const command of AUTOMATION_COMMANDS)
			expect(command.inputSchema.additionalProperties, command.name).toBe(false);
	});
	it("accepts partial recording configuration without inventing omitted settings", () => {
		expect(request("recording.configure", { microphoneEnabled: false })).toMatchObject({
			params: { microphoneEnabled: false },
		});
		expect(request("recording.configure", {})).toMatchObject({ params: {} });
		expect(
			request("recording.configure", {
				countdownSeconds: 0,
				systemAudioEnabled: true,
				webcamDeviceId: "camera/raw:id",
			}),
		).toMatchObject({
			params: {
				countdownSeconds: 0,
				systemAudioEnabled: true,
				webcamDeviceId: "camera/raw:id",
			},
		});
	});
	it("allows saving the current project and explicit Save As without requiring optional fields", () => {
		expect(request("project.save")).toMatchObject({ params: {} });
		expect(
			request("project.save", { path: "/tmp/Мой проект.scrdance", overwrite: false }),
		).toMatchObject({ params: { path: "/tmp/Мой проект.scrdance", overwrite: false } });
	});
	it("requires actual source IDs and permission kinds", () => {
		expect(request("sources.select", { sourceId: "window:123:0" }).params.sourceId).toBe(
			"window:123:0",
		);
		for (const kind of ["screen", "accessibility", "microphone", "camera"])
			expect(request("permissions.request", { kind }).params.kind).toBe(kind);
	});
	it.each([
		["recording.configure", { microphoneEnabled: "false" }],
		["recording.configure", { webcamEnabled: 1 }],
		["recording.configure", { systemAudioEnabled: null }],
		["recording.configure", { microphoneDeviceId: "" }],
		["recording.configure", { webcamDeviceId: "x\0y" }],
		["recording.configure", { microphoneDeviceId: "x".repeat(513) }],
		["recording.configure", { countdownSeconds: -1 }],
		["recording.configure", { countdownSeconds: 11 }],
		["recording.configure", { countdownSeconds: 1.5 }],
		["recording.configure", { countdownSeconds: Infinity }],
		["recording.configure", { countdownSeconds: NaN }],
		["recording.configure", { enabled: true }],
		["recording.configure", null],
		["recording.configure", []],
		["permissions.request", { kind: "photos" }],
		["permissions.request", {}],
		["sources.select", {}],
		["sources.select", { sourceId: "   " }],
		["project.save", { overwrite: "true" }],
		["project.save", { path: "x".repeat(4097) }],
		["project.save", { overwrite: false, force: true }],
		["recording.start", { toggle: true }],
		["project.open", {}],
		["preview.render", { timeMs: -1, outputPath: "/tmp/a.png" }],
	])("rejects invalid %s parameters %j", (method, params) => {
		expect(() => request(method as string, params)).toThrow(AutomationError);
		try {
			request(method as string, params);
		} catch (error) {
			expect(error).toMatchObject({ code: "INVALID_PARAMS" });
		}
	});
	it("rejects inherited required parameters rather than accepting prototype values", () => {
		expect(() => request("sources.select", Object.create({ sourceId: "screen:0:0" }))).toThrow(
			AutomationError,
		);
	});
});
