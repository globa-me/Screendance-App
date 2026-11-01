import fs from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAutomationSocket } from "./socketServer";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const action of cleanup.splice(0).reverse()) await action();
});

async function host() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sd-api-"));
	cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
	const endpointPath = path.join(directory, "private", "endpoint.json");
	const dispatch = vi.fn(async () => ({ title: "Тестовый проект" }));
	const server = await startAutomationSocket({ endpointPath, dispatch });
	cleanup.push(server.close);
	return { ...server, dispatch, endpointPath };
}

function send(socketPath: string, payload: string, split = false): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let response = "";
		socket.setEncoding("utf8");
		socket.setTimeout(2000, () => socket.destroy(new Error("Socket test timed out")));
		socket.on("error", reject);
		socket.on("data", (chunk) => {
			response += chunk;
		});
		socket.on("close", () => resolve(response));
		socket.on("connect", () => {
			if (split) {
				socket.write(payload.slice(0, 5));
				setTimeout(() => socket.write(payload.slice(5)), 5);
			} else socket.write(payload);
		});
	});
}

describe("private automation socket", () => {
	it("publishes private credentials, accepts fragmented authenticated requests, and dispatches once", async () => {
		const server = await host();
		for (const target of [server.endpointPath, server.endpoint.socketPath]) {
			expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
		}
		for (const directory of [
			path.dirname(server.endpointPath),
			path.dirname(server.endpoint.socketPath),
		]) {
			expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
		}
		expect(JSON.parse(await fs.readFile(server.endpointPath, "utf8"))).toEqual(server.endpoint);
		const payload = JSON.stringify({
			...server.endpoint,
			id: "request-1",
			method: "project.inspect",
			params: {},
		});
		expect(
			JSON.parse(await send(server.endpoint.socketPath, `${payload}\n${payload}\n`, true)),
		).toEqual({
			id: "request-1",
			result: { title: "Тестовый проект" },
		});
		expect(server.dispatch).toHaveBeenCalledExactlyOnceWith({
			id: "request-1",
			method: "project.inspect",
			params: {},
		});
	});

	it.each([
		[{ token: "wrong", protocolVersion: 1, method: "app.status" }, "ACCESS_DENIED"],
		[{ protocolVersion: 2, method: "app.status" }, "PROTOCOL_MISMATCH"],
		[{ method: "no.such.command" }, "UNKNOWN_COMMAND"],
		[{ method: "app.status", params: { unexpected: true } }, "INVALID_PARAMS"],
		[
			{ method: "preview.render", params: { timeMs: -1, outputPath: "/tmp/x.png" } },
			"INVALID_PARAMS",
		],
		[{ method: "video.open", params: {} }, "INVALID_PARAMS"],
		[{ id: "", method: "app.status" }, "INVALID_REQUEST"],
	])("rejects invalid requests without dispatch: %j", async (override, code) => {
		const server = await host();
		const result = JSON.parse(
			await send(
				server.endpoint.socketPath,
				`${JSON.stringify({
					token: server.endpoint.token,
					protocolVersion: 1,
					id: "test",
					params: {},
					...override,
				})}\n`,
			),
		);
		expect(result.error.code).toBe(code);
		expect(server.dispatch).not.toHaveBeenCalled();
	});

	it("bounds requests before JSON parsing and rejects malformed JSON", async () => {
		const server = await host();
		expect(await send(server.endpoint.socketPath, "x".repeat(16 * 1024 * 1024 + 1))).toBe("");
		expect(JSON.parse(await send(server.endpoint.socketPath, "{broken\n"))).toMatchObject({
			error: { code: "INVALID_REQUEST" },
		});
		expect(server.dispatch).not.toHaveBeenCalled();
	});

	it("does not replace an active host descriptor and removes only its own descriptor on close", async () => {
		const server = await host();
		await expect(
			startAutomationSocket({ endpointPath: server.endpointPath, dispatch: vi.fn() }),
		).rejects.toMatchObject({ code: "ALREADY_RUNNING" });
		expect(JSON.parse(await fs.readFile(server.endpointPath, "utf8"))).toEqual(server.endpoint);
		const replacement = { ...server.endpoint, token: "another-owner" };
		await fs.writeFile(server.endpointPath, JSON.stringify(replacement));
		await server.close();
		expect(JSON.parse(await fs.readFile(server.endpointPath, "utf8"))).toEqual(replacement);
		await expect(fs.stat(server.endpoint.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes the endpoint and closes idle clients on shutdown", async () => {
		const server = await host();
		const client = createConnection(server.endpoint.socketPath);
		await new Promise<void>((resolve, reject) => {
			client.once("connect", resolve);
			client.once("error", reject);
		});
		const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
		await server.close();
		await closed;
		await expect(fs.stat(server.endpointPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(`${server.endpointPath}.lock`)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("allows only one concurrent startup for the same endpoint", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sd-race-"));
		cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
		const endpointPath = path.join(directory, "endpoint.json");
		const attempts = await Promise.allSettled(
			Array.from({ length: 8 }, () =>
				startAutomationSocket({ endpointPath, dispatch: vi.fn() }),
			),
		);
		const successes = attempts.filter((result) => result.status === "fulfilled");
		for (const success of successes) cleanup.push(success.value.close);
		expect(successes).toHaveLength(1);
		for (const result of attempts)
			if (result.status === "rejected") expect(result.reason.code).toBe("ALREADY_RUNNING");
		expect(JSON.parse(await fs.readFile(endpointPath, "utf8"))).toEqual(
			successes[0].value.endpoint,
		);
	});

	it("recovers abandoned credentials and dead-process locks", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sd-stale-"));
		cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
		const endpointPath = path.join(directory, "endpoint.json");
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ socketPath: path.join(directory, "missing.sock"), token: "old" }),
		);
		await fs.writeFile(
			`${endpointPath}.lock`,
			JSON.stringify({ token: "old", pid: 2147483647 }),
			{ mode: 0o600 },
		);
		const server = await startAutomationSocket({ endpointPath, dispatch: vi.fn() });
		cleanup.push(server.close);
		expect(JSON.parse(await fs.readFile(endpointPath, "utf8"))).toEqual(server.endpoint);
		expect(JSON.parse(await fs.readFile(`${endpointPath}.lock`, "utf8"))).toMatchObject({
			token: server.endpoint.token,
			pid: process.pid,
		});
	});

	it("refuses shared or symlink endpoint directories without changing their permissions", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sd-untrusted-"));
		cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
		const shared = path.join(directory, "shared");
		await fs.mkdir(shared, { mode: 0o755 });
		await fs.chmod(shared, 0o755);
		await expect(
			startAutomationSocket({
				endpointPath: path.join(shared, "endpoint.json"),
				dispatch: vi.fn(),
			}),
		).rejects.toMatchObject({ code: "ACCESS_DENIED" });
		expect((await fs.stat(shared)).mode & 0o777).toBe(0o755);
		const alias = path.join(directory, "alias");
		await fs.symlink(directory, alias);
		await expect(
			startAutomationSocket({
				endpointPath: path.join(alias, "endpoint.json"),
				dispatch: vi.fn(),
			}),
		).rejects.toMatchObject({ code: "ACCESS_DENIED" });
	});
});
