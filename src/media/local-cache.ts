import type { Database } from "../db/db.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export const MEDIA_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const MIMES = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	m4v: "video/x-m4v",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
} as const;
export type SourceMediaMime = (typeof MIMES)[keyof typeof MIMES];
export interface MediaDownloadApi {
	getFile(fileId: string, signal?: AbortSignal): Promise<{ file_path?: string }>;
	downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array>;
}
export type LocalMediaFailure =
	| "aborted"
	| "media_unavailable"
	| "file_id_unavailable"
	| "telegram_file_unavailable"
	| "unsupported_format"
	| "telegram_download_failed"
	| "empty_file"
	| "download_oversize";
export type LocalMediaResult =
	| { ok: true; bytes: Uint8Array; mimeType: SourceMediaMime; sourceExtension: string; sourcePath: string | null }
	| { ok: false; outcome: LocalMediaFailure };
export interface EnsureLocalMediaOptions {
	cacheDir: string;
	signal?: AbortSignal;
}
export function sourceMediaMimeForPath(path: string): SourceMediaMime | null {
	return MIMES[extname(path).slice(1).toLowerCase() as keyof typeof MIMES] ?? null;
}
export function isVideoMedia(kind: string, mime: string | null | undefined): boolean {
	return (
		["video", "video_note", "animation"].includes(kind) ||
		(kind === "document" && Boolean(mime?.startsWith("video/"))) ||
		(kind === "sticker" && mime === "video/webm")
	);
}
export function isVisionMedia(kind: string, mime: string | null | undefined): boolean {
	return kind === "photo" || (kind === "sticker" && mime !== "application/x-tgsticker") || isVideoMedia(kind, mime);
}
/** The bot's newest Telegram file_id for a media identity. */
export function fileIdFor(db: Database, fileUniqueId: string): string | null {
	return (
		(
			db
				.prepare("SELECT file_id FROM media_file_ids WHERE file_unique_id = ? ORDER BY rowid DESC LIMIT 1")
				.get(fileUniqueId) as { file_id: string } | undefined
		)?.file_id ?? null
	);
}
export function resolveMediaSourcePath(cacheDir: string, storedPath: string | null): string | null {
	return storedPath &&
		basename(storedPath) === storedPath &&
		!storedPath.includes("\0") &&
		sourceMediaMimeForPath(storedPath)
		? join(cacheDir, storedPath)
		: null;
}
export function mediaCacheFileName(identity: string, extension: string): string {
	return `${createHash("sha256").update(identity).digest("hex").slice(0, 32)}.${extension}`;
}
/** Source files are reproducible cache, installed atomically with owner-only permissions. */
export function installMediaCacheFile(
	cacheDir: string,
	identity: string,
	extension: string,
	bytes: Uint8Array,
): string {
	mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
	const target = join(cacheDir, mediaCacheFileName(identity, extension));
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
		return target;
	} finally {
		rmSync(temporary, { force: true });
	}
}
export function dedupeInFlight<T>(inFlight: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> {
	let pending = inFlight.get(key);
	if (!pending) {
		pending = work().finally(() => inFlight.delete(key));
		inFlight.set(key, pending);
	}
	return pending;
}
const inFlight = new Map<string, Promise<LocalMediaResult>>();

export function ensureLocalMedia(
	db: Database,
	api: MediaDownloadApi,
	fileUniqueId: string,
	options: EnsureLocalMediaOptions,
): Promise<LocalMediaResult> {
	return dedupeInFlight(inFlight, fileUniqueId, async () => {
		const { cacheDir, signal } = options;
		if (signal?.aborted) return { ok: false, outcome: "aborted" };
		const media = db.prepare("SELECT kind, mime, local_path FROM media WHERE file_unique_id = ?").get(fileUniqueId) as
			| { kind: string; mime: string | null; local_path: string | null }
			| undefined;
		if (!media || !isVisionMedia(media.kind, media.mime)) return { ok: false, outcome: "media_unavailable" };
		const cached = resolveMediaSourcePath(cacheDir, media.local_path);
		if (cached) {
			try {
				const stat = statSync(cached);
				if (stat.isFile() && stat.size > 0 && stat.size <= MEDIA_DOWNLOAD_MAX_BYTES)
					return {
						ok: true,
						bytes: readFileSync(cached),
						mimeType: sourceMediaMimeForPath(cached)!,
						sourceExtension: extname(cached).slice(1),
						sourcePath: cached,
					};
			} catch {
				/* Evicted cache is downloaded again. */
			}
		}
		const fileId = fileIdFor(db, fileUniqueId);
		if (!fileId) return { ok: false, outcome: "file_id_unavailable" };
		let remotePath: string | undefined;
		try {
			remotePath = (await api.getFile(fileId, signal)).file_path;
		} catch {
			return { ok: false, outcome: signal?.aborted ? "aborted" : "telegram_file_unavailable" };
		}
		if (!remotePath) return { ok: false, outcome: "telegram_file_unavailable" };
		const mimeType = sourceMediaMimeForPath(remotePath);
		if (!mimeType) return { ok: false, outcome: "unsupported_format" };
		let bytes: Uint8Array;
		try {
			bytes = await api.downloadFile(remotePath, signal);
		} catch {
			return { ok: false, outcome: signal?.aborted ? "aborted" : "telegram_download_failed" };
		}
		if (signal?.aborted) return { ok: false, outcome: "aborted" };
		if (!bytes.length) return { ok: false, outcome: "empty_file" };
		if (bytes.length > MEDIA_DOWNLOAD_MAX_BYTES) return { ok: false, outcome: "download_oversize" };
		const sourceExtension = extname(remotePath).slice(1).toLowerCase();
		let sourcePath: string | null = null;
		try {
			sourcePath = installMediaCacheFile(cacheDir, fileUniqueId, sourceExtension, bytes);
			db.prepare("UPDATE media SET local_path = ? WHERE file_unique_id = ?").run(basename(sourcePath), fileUniqueId);
		} catch {
			if (sourcePath) rmSync(sourcePath, { force: true });
			sourcePath = null;
		}
		return { ok: true, bytes, mimeType, sourceExtension, sourcePath };
	});
}
