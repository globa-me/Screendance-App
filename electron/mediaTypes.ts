import path from "node:path";

export const MEDIA_CONTENT_TYPES: Record<string, string> = {
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
};

export function getMediaContentType(filePath: string): string {
	return MEDIA_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function isSupportedLocalMediaPath(filePath: string): boolean {
	return path.extname(filePath).toLowerCase() in MEDIA_CONTENT_TYPES;
}

/**
 * Media, image and font files the renderer may read from anywhere on disk.
 * Approvals of renderer-supplied paths are limited to these types too, so an
 * approval can never expose documents, keys or project files.
 */
const RENDERER_READABLE_EXTENSIONS = new Set([
	".mp4",
	".m4v",
	".webm",
	".mov",
	".mkv",
	".avi",
	".wav",
	".mp3",
	".m4a",
	".aac",
	".ogg",
	".oga",
	".opus",
	".flac",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".avif",
	".heic",
	".heif",
	".bmp",
	".tif",
	".tiff",
	".svg",
	".ttf",
	".otf",
	".woff",
	".woff2",
]);

export function isRendererMediaFile(filePath: string): boolean {
	return RENDERER_READABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
