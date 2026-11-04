import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { approvedLocalReadPaths } from "./ipc/state";
import { getMediaContentType } from "./mediaTypes";
import { getPackagedRendererBaseUrl } from "./rendererServer";

let mediaServerBaseUrl: string | null = null;
let mediaServerStartPromise: Promise<string> | null = null;

// Per-launch secret: other local processes and web pages in the user's browser
// can reach 127.0.0.1, so a media URL is only honored with this token.
const MEDIA_SERVER_TOKEN = randomBytes(24).toString("hex");

export function isValidMediaServerToken(candidate: string | null): boolean {
	if (!candidate) return false;
	const expected = Buffer.from(MEDIA_SERVER_TOKEN);
	const actual = Buffer.from(candidate);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function getOrigin(url: string | null | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

/** CORS is granted only to the app's own renderer origins, never to `*`. */
export function getAllowedCorsOrigin(requestOrigin: string | undefined): string | null {
	if (!requestOrigin) return null;
	const allowedOrigins = [
		getOrigin(getPackagedRendererBaseUrl()),
		getOrigin(process.env["VITE_DEV_SERVER_URL"]),
	].filter((origin): origin is string => Boolean(origin));
	return allowedOrigins.includes(requestOrigin) ? requestOrigin : null;
}

export function resolveHttpByteRange(
	rangeHeader: string,
	fileSize: number,
): { start: number; end: number } | null {
	const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
	if (!match || (!match[1] && !match[2])) {
		return null;
	}

	if (fileSize === 0) {
		return null;
	}

	if (!match[1] && match[2]) {
		// Suffix range: bytes=-500
		const suffixLength = Number.parseInt(match[2], 10);
		if (Number.isNaN(suffixLength) || suffixLength <= 0) {
			return null;
		}

		return {
			start: Math.max(0, fileSize - suffixLength),
			end: fileSize - 1,
		};
	}

	const start = Number.parseInt(match[1], 10);
	if (Number.isNaN(start) || start < 0 || start >= fileSize) {
		return null;
	}

	const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1;
	if (Number.isNaN(requestedEnd) || requestedEnd < start) {
		return null;
	}

	return {
		start,
		end: Math.min(requestedEnd, fileSize - 1),
	};
}

async function resolveRealPath(filePath: string): Promise<string | null> {
	try {
		return await fs.realpath(path.resolve(filePath));
	} catch {
		return null;
	}
}

export function isAllowedMediaPath(realPath: string): boolean {
	return approvedLocalReadPaths.has(realPath);
}

async function handleMediaRequest(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	try {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");

		if (url.pathname !== "/video") {
			response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Not Found");
			return;
		}

		const method = request.method ?? "GET";
		if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
			response.writeHead(405, { Allow: "GET, HEAD, OPTIONS" });
			response.end();
			return;
		}

		const allowedOrigin = getAllowedCorsOrigin(request.headers.origin);
		const corsHeaders: Record<string, string> = allowedOrigin
			? {
					"Access-Control-Allow-Origin": allowedOrigin,
					Vary: "Origin",
					"Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
				}
			: {};

		if (method === "OPTIONS") {
			response.writeHead(allowedOrigin ? 204 : 403, {
				...corsHeaders,
				...(allowedOrigin
					? {
							"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
							"Access-Control-Allow-Headers": "Range",
						}
					: {}),
			});
			response.end();
			return;
		}

		if (!isValidMediaServerToken(url.searchParams.get("token"))) {
			response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Forbidden");
			return;
		}

		const rawPath = url.searchParams.get("path");
		if (!rawPath) {
			response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Missing path parameter");
			return;
		}

		const resolvedPath = await resolveRealPath(rawPath);
		if (!resolvedPath || !isAllowedMediaPath(resolvedPath)) {
			console.warn(`[media-server] Blocked access to unapproved path: ${rawPath}`);
			response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Forbidden");
			return;
		}

		const stat = await fs.stat(resolvedPath);
		if (!stat.isFile()) {
			response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Not Found");
			return;
		}

		const contentType = getMediaContentType(resolvedPath);
		const fileSize = stat.size;
		const rangeHeader = request.headers.range;

		if (rangeHeader) {
			if (fileSize === 0) {
				response.writeHead(416, { ...corsHeaders, "Content-Range": `bytes */0` });
				response.end();
				return;
			}

			const byteRange = resolveHttpByteRange(rangeHeader, fileSize);
			if (!byteRange) {
				response.writeHead(416, { ...corsHeaders, "Content-Range": `bytes */${fileSize}` });
				response.end();
				return;
			}

			const { start, end } = byteRange;

			const chunkSize = end - start + 1;
			response.writeHead(206, {
				...corsHeaders,
				"Content-Range": `bytes ${start}-${end}/${fileSize}`,
				"Accept-Ranges": "bytes",
				"Content-Length": String(chunkSize),
				"Content-Type": contentType,
				"Cache-Control": "no-cache",
			});

			if (request.method === "HEAD") {
				response.end();
				return;
			}

			const stream = createReadStream(resolvedPath, { start, end });
			stream.pipe(response);
			stream.on("error", () => {
				if (!response.headersSent) {
					response.writeHead(500, { "Content-Type": "text/plain" });
				}
				response.end();
			});
		} else {
			response.writeHead(200, {
				...corsHeaders,
				"Accept-Ranges": "bytes",
				"Content-Length": String(fileSize),
				"Content-Type": contentType,
				"Cache-Control": "no-cache",
			});

			if (request.method === "HEAD") {
				response.end();
				return;
			}

			const stream = createReadStream(resolvedPath);
			stream.pipe(response);
			stream.on("error", () => {
				if (!response.headersSent) {
					response.writeHead(500, { "Content-Type": "text/plain" });
				}
				response.end();
			});
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Not Found");
			return;
		}

		console.error("[media-server] Error handling request:", error);
		response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
		response.end("Internal Server Error");
	}
}

export function getMediaServerBaseUrl(): string | null {
	return mediaServerBaseUrl;
}

export async function ensureMediaServer(): Promise<string> {
	if (mediaServerBaseUrl) {
		return mediaServerBaseUrl;
	}

	if (mediaServerStartPromise) {
		return mediaServerStartPromise;
	}

	mediaServerStartPromise = new Promise((resolve, reject) => {
		const server = createServer((request, response) => {
			void handleMediaRequest(request, response);
		});

		server.once("error", (error) => {
			reject(error);
		});

		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Media server did not expose a TCP address"));
				return;
			}

			mediaServerBaseUrl = `http://127.0.0.1:${address.port}`;
			console.log(`[media-server] Listening at ${mediaServerBaseUrl}`);
			resolve(mediaServerBaseUrl);
		});
	});

	return mediaServerStartPromise;
}

export function buildMediaUrl(baseUrl: string, filePath: string): string {
	const resolved = path.resolve(filePath);
	return `${baseUrl}/video?path=${encodeURIComponent(resolved)}&token=${MEDIA_SERVER_TOKEN}`;
}
