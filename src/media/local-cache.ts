import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";

export const MEDIA_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

export type StaticMediaMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
export type VideoMediaMime =
	| "video/mp4"
	| "video/webm"
	| "video/quicktime"
	| "video/x-m4v"
	| "video/x-matroska"
	| "video/x-msvideo";
export type SourceMediaMime = StaticMediaMime | VideoMediaMime;
export type LocalMediaKind = "photo" | "sticker" | "animation" | "video" | "video_note" | "document";

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
	| {
			ok: true;
			kind: LocalMediaKind;
			bytes: Uint8Array;
			mimeType: SourceMediaMime;
			sourceExtension: string;
			/** The installed cache file; null only when installing it failed. */
			sourcePath: string | null;
	  }
	| { ok: false; outcome: LocalMediaFailure };

function writeExclusive(path: string, bytes: Uint8Array): void {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export interface EnsureLocalMediaOptions {
	cacheDir: string;
	signal?: AbortSignal;
	/** Every configured Bot API, keyed by the same bot_id stored beside its file_id. */
	botApis?: ReadonlyMap<string, MediaDownloadApi>;
}

let temporarySequence = 0;

export function staticMediaMimeForPath(path: string): StaticMediaMime | null {
	const extension = extname(path).slice(1).toLowerCase();
	if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
	if (extension === "png") return "image/png";
	if (extension === "webp") return "image/webp";
	if (extension === "gif") return "image/gif";
	return null;
}

export function sourceMediaMimeForPath(path: string): SourceMediaMime | null {
	const extension = extname(path).slice(1).toLowerCase();
	const image = staticMediaMimeForPath(path);
	if (image) return image;
	if (extension === "mp4") return "video/mp4";
	if (extension === "webm") return "video/webm";
	if (extension === "mov") return "video/quicktime";
	if (extension === "m4v") return "video/x-m4v";
	if (extension === "mkv") return "video/x-matroska";
	if (extension === "avi") return "video/x-msvideo";
	return null;
}

function normalizedSourceExtension(path: string): string | null {
	const extension = extname(path).slice(1).toLowerCase();
	return sourceMediaMimeForPath(path) ? extension : null;
}

export function isVideoMedia(kind: string, mime: string | null | undefined): boolean {
	if (kind === "video" || kind === "video_note" || kind === "animation") return true;
	if (kind === "document") return mime?.startsWith("video/") ?? false;
	return kind === "sticker" && mime === "video/webm";
}

/** True when this media can produce image(s) for a model: photo, non-TGS sticker, any video. */
export function isVisionMedia(kind: string, mime: string | null | undefined): boolean {
	return kind === "photo" || (kind === "sticker" && mime !== "application/x-tgsticker") || isVideoMedia(kind, mime);
}

export function fileIdForBot(db: Database, botId: string, fileUniqueId: string): string | null {
	const row = db
		.query("SELECT file_id FROM media_file_ids WHERE bot_id = ? AND file_unique_id = ?")
		.get(botId, fileUniqueId) as { file_id: string } | null;
	return row?.file_id ?? null;
}

export function downloadSource(
	db: Database,
	preferredApi: MediaDownloadApi,
	preferredBotId: string,
	fileUniqueId: string,
	botApis?: ReadonlyMap<string, MediaDownloadApi>,
): { api: MediaDownloadApi; fileId: string } | null {
	const mappings = db
		.query(`
			SELECT bot_id AS botId, file_id AS fileId
			  FROM media_file_ids
			 WHERE file_unique_id = ?
			 ORDER BY CASE WHEN bot_id = ? THEN 0 ELSE 1 END, rowid DESC
		`)
		.all(fileUniqueId, preferredBotId) as { botId: string; fileId: string }[];
	for (const mapping of mappings) {
		if (mapping.botId === preferredBotId) return { api: preferredApi, fileId: mapping.fileId };
		const api = botApis?.get(mapping.botId);
		if (api) return { api, fileId: mapping.fileId };
	}
	return null;
}

/** Resolve a cache-relative source filename inside this deployment's media directory. */
export function resolveMediaSourcePath(cacheDir: string, storedPath: string | null): string | null {
	if (!storedPath || storedPath.includes("\0")) return null;
	const filename = basename(storedPath);
	if (!filename || filename === "." || filename === ".." || !sourceMediaMimeForPath(filename)) return null;
	return join(cacheDir, filename);
}

function readExisting(path: string): { bytes: Uint8Array; mimeType: SourceMediaMime; sourceExtension: string } | null {
	const mimeType = sourceMediaMimeForPath(path);
	const sourceExtension = normalizedSourceExtension(path);
	if (!mimeType || !sourceExtension) return null;
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size <= 0 || stat.size > MEDIA_DOWNLOAD_MAX_BYTES) return null;
		return { bytes: new Uint8Array(readFileSync(path)), mimeType, sourceExtension };
	} catch {
		return null;
	}
}

/** Cache file name for an identity (a file_unique_id, or one with a `#slot` for derived images). */
export function mediaCacheFileName(identity: string, extension: string): string {
	return `${createHash("sha256").update(identity).digest("hex").slice(0, 32)}.${extension}`;
}

/** Install complete bytes with owner-only permissions, then expose them with one rename. */
export function installMediaCacheFile(
	cacheDir: string,
	identity: string,
	extension: string,
	bytes: Uint8Array,
): string {
	mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
	const target = join(cacheDir, mediaCacheFileName(identity, extension));
	const temporary = `${target}.${process.pid}.${temporarySequence++}.tmp`;
	try {
		writeExclusive(temporary, bytes);
		renameSync(temporary, target);
		return target;
	} catch {
		try {
			rmSync(temporary, { force: true });
		} catch {
			// A failed cleanup must not expose the original filesystem error or media identity.
		}
		throw new Error("media cache install failed");
	}
}

/** Coalesce concurrent same-identity async work; each caller owns its map. */
export function dedupeInFlight<T>(inFlight: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> {
	const existing = inFlight.get(key);
	if (existing) return existing;
	const promise = work().finally(() => inFlight.delete(key));
	inFlight.set(key, promise);
	return promise;
}

const inFlight = new Map<string, Promise<LocalMediaResult>>();

/** Share Telegram download and atomic cache installation across vision and view_image. */
export function ensureLocalMedia(
	db: Database,
	api: MediaDownloadApi,
	botId: string,
	fileUniqueId: string,
	options: EnsureLocalMediaOptions,
): Promise<LocalMediaResult> {
	return dedupeInFlight(inFlight, fileUniqueId, () => ensureLocalMediaInner(db, api, botId, fileUniqueId, options));
}

async function ensureLocalMediaInner(
	db: Database,
	api: MediaDownloadApi,
	botId: string,
	fileUniqueId: string,
	options: EnsureLocalMediaOptions,
): Promise<LocalMediaResult> {
	const { cacheDir, signal } = options;
	if (signal?.aborted) return { ok: false, outcome: "aborted" };
	const media = db.query("SELECT kind, mime, local_path FROM media WHERE file_unique_id = ?").get(fileUniqueId) as {
		kind: string;
		mime: string | null;
		local_path: string | null;
	} | null;
	if (!media || !isVisionMedia(media.kind, media.mime)) {
		return { ok: false, outcome: "media_unavailable" };
	}
	const kind = media.kind as LocalMediaKind;
	if (media.local_path) {
		const existingPath = resolveMediaSourcePath(cacheDir, media.local_path);
		const existing = existingPath ? readExisting(existingPath) : null;
		if (existing) return { ok: true, kind, ...existing, sourcePath: existingPath };
	}

	const source = downloadSource(db, api, botId, fileUniqueId, options.botApis);
	if (!source) return { ok: false, outcome: "file_id_unavailable" };
	let remotePath: string | null = null;
	try {
		remotePath = (await source.api.getFile(source.fileId, signal)).file_path ?? null;
	} catch {
		return { ok: false, outcome: signal?.aborted ? "aborted" : "telegram_file_unavailable" };
	}
	if (signal?.aborted) return { ok: false, outcome: "aborted" };
	if (!remotePath) return { ok: false, outcome: "telegram_file_unavailable" };
	const mimeType = sourceMediaMimeForPath(remotePath);
	const extension = normalizedSourceExtension(remotePath);
	if (!mimeType || !extension) return { ok: false, outcome: "unsupported_format" };

	let bytes: Uint8Array;
	try {
		bytes = await source.api.downloadFile(remotePath, signal);
	} catch {
		return { ok: false, outcome: signal?.aborted ? "aborted" : "telegram_download_failed" };
	}
	if (signal?.aborted) return { ok: false, outcome: "aborted" };
	if (bytes.byteLength === 0) return { ok: false, outcome: "empty_file" };
	if (bytes.byteLength > MEDIA_DOWNLOAD_MAX_BYTES) return { ok: false, outcome: "download_oversize" };

	let sourcePath: string | null = null;
	try {
		sourcePath = installMediaCacheFile(cacheDir, fileUniqueId, extension, bytes);
		if (signal?.aborted) {
			rmSync(sourcePath, { force: true });
			return { ok: false, outcome: "aborted" };
		}
		db.query("UPDATE media SET local_path = ? WHERE file_unique_id = ?").run(basename(sourcePath), fileUniqueId);
	} catch {
		if (sourcePath) {
			try {
				rmSync(sourcePath, { force: true });
			} catch {
				// The DB remains authoritative; cleanup failure is intentionally non-sensitive.
			}
		}
		return { ok: true, kind, bytes, mimeType, sourceExtension: extension, sourcePath: null };
	}
	return { ok: true, kind, bytes, mimeType, sourceExtension: extension, sourcePath };
}
