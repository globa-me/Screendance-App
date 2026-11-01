import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAutomationOutput, publishAutomationOutput } from "./output";

let directory: string;
let source: string;
let output: string;
const signal = () => new AbortController().signal;
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "sd-output-"));
	source = path.join(directory, "retained.mp4");
	output = path.join(directory, "result.mp4");
	await fs.writeFile(source, "complete encoded movie");
});
afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

describe("atomic job output publication", () => {
	it("publishes a new complete output while preserving the retained source", async () => {
		const commit = vi.fn();
		const target = await prepareAutomationOutput(output, false);
		await expect(
			publishAutomationOutput(target, source, signal(), commit),
		).resolves.toMatchObject({
			outputPath: await fs.realpath(directory).then((dir) => path.join(dir, "result.mp4")),
			bytes: 22,
		});
		expect(commit).toHaveBeenCalledTimes(1);
		expect(await fs.readFile(output, "utf8")).toBe("complete encoded movie");
		expect(await fs.readFile(source, "utf8")).toBe("complete encoded movie");
		expect(
			(await fs.readdir(directory)).filter((file) => file.startsWith(".screendance-export-")),
		).toEqual([]);
	});
	it("requires explicit permission before replacing an existing file", async () => {
		await fs.writeFile(output, "old movie");
		await expect(prepareAutomationOutput(output, false)).rejects.toMatchObject({
			code: "OUTPUT_EXISTS",
		});
		const target = await prepareAutomationOutput(output, true);
		await publishAutomationOutput(target, source, signal(), () => {});
		expect(await fs.readFile(output, "utf8")).toBe("complete encoded movie");
		expect(await fs.readFile(source, "utf8")).toBe("complete encoded movie");
	});
	it("never replaces a symlink destination even with overwrite=true", async () => {
		await fs.symlink(source, output);
		await expect(prepareAutomationOutput(output, true)).rejects.toMatchObject({
			code: "INVALID_PATH",
		});
		expect(await fs.readFile(source, "utf8")).toBe("complete encoded movie");
	});
	it("does not overwrite a file created after export preparation", async () => {
		const target = await prepareAutomationOutput(output, false);
		await fs.writeFile(output, "new user movie");
		await expect(
			publishAutomationOutput(target, source, signal(), () => {}),
		).rejects.toMatchObject({ code: "TARGET_CHANGED" });
		expect(await fs.readFile(output, "utf8")).toBe("new user movie");
	});
	it.each([
		"replace",
		"modify",
	])("refuses an existing target %s after preparation", async (change) => {
		await fs.writeFile(output, "old user movie");
		const target = await prepareAutomationOutput(output, true);
		if (change === "replace") {
			await fs.unlink(output);
			await fs.writeFile(output, "new user movie");
		} else await fs.appendFile(output, " modified");
		const changed = await fs.readFile(output, "utf8");
		await expect(
			publishAutomationOutput(target, source, signal(), () => {}),
		).rejects.toMatchObject({ code: "TARGET_CHANGED" });
		expect(await fs.readFile(output, "utf8")).toBe(changed);
	});
	it("detects a replaced output directory", async () => {
		const parent = path.join(directory, "folder");
		await fs.mkdir(parent);
		const target = await prepareAutomationOutput(path.join(parent, "result.mp4"), false);
		await fs.rename(parent, `${parent}-old`);
		await fs.mkdir(parent);
		await expect(
			publishAutomationOutput(target, source, signal(), () => {}),
		).rejects.toMatchObject({ code: "TARGET_CHANGED" });
		expect(await fs.readdir(parent)).toEqual([]);
	});
	it("honors cancellation before publication without deleting a retained source", async () => {
		const target = await prepareAutomationOutput(output, false);
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const commit = vi.fn();
		await expect(
			publishAutomationOutput(target, source, controller.signal, commit),
		).rejects.toThrow("cancelled");
		expect(commit).not.toHaveBeenCalled();
		await expect(fs.access(output)).rejects.toThrow();
		await expect(fs.access(source)).resolves.toBeUndefined();
	});
	it("keeps an existing destination unchanged when commit is declined after copying", async () => {
		await fs.writeFile(output, "old user movie");
		const target = await prepareAutomationOutput(output, true);
		await expect(
			publishAutomationOutput(target, source, signal(), () => {
				throw new Error("cancelled before publication");
			}),
		).rejects.toThrow("cancelled before publication");
		expect(await fs.readFile(output, "utf8")).toBe("old user movie");
		expect(await fs.readFile(source, "utf8")).toBe("complete encoded movie");
		expect(
			(await fs.readdir(directory)).filter((file) => file.startsWith(".screendance-export-")),
		).toEqual([]);
	});
	it("refuses a retained source symlink and an output that is its own retained artifact", async () => {
		const link = path.join(directory, "link.mp4");
		await fs.symlink(source, link);
		const target = await prepareAutomationOutput(output, false);
		await expect(
			publishAutomationOutput(target, link, signal(), () => {}),
		).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
		const sameTarget = await prepareAutomationOutput(source, true);
		await expect(
			publishAutomationOutput(sameTarget, source, signal(), () => {}),
		).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
		expect(await fs.readFile(source, "utf8")).toBe("complete encoded movie");
	});
	it("rejects forged prepared targets", async () => {
		const target = await prepareAutomationOutput(output, false);
		await expect(
			publishAutomationOutput({ ...target }, source, signal(), () => {}),
		).rejects.toMatchObject({ code: "ACCESS_DENIED" });
	});
});
