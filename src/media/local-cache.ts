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

export const MEDIA_CACHE_MAX_BYTES = 1024 * 1024;
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

export type LocalMediaCacheOutcome = "cached" | "ready" | "oversize" | "install_failed";

export type LocalMediaResult =
	| {
			ok: true;
			kind: LocalMediaKind;
			bytes: Uint8Array;
			mimeType: SourceMediaMime;
			sourceExtension: string;
			sourcePath: string | null;
			mediaPath: string | null;
			cacheOutcome: LocalMediaCacheOutcome;
	  }
	| { ok: false; outcome: LocalMediaFailure };

export type MediaBytesBucket = "unavailable" | "lt_32_kib" | "32_128_kib" | "128_512_kib";

/** Bucket encoded byte size; the caller pins its own top-band label so telemetry bands never drift. */
export function bytesBucket<TopBand extends string>(bytes: number, topBand: TopBand): MediaBytesBucket | TopBand {
	if (bytes < 32 * 1024) return "lt_32_kib";
	if (bytes < 128 * 1024) return "32_128_kib";
	if (bytes < 512 * 1024) return "128_512_kib";
	return topBand;
}

export interface MediaCacheFileOps {
	mkdir(path: string): void;
	read(path: string): Uint8Array;
	stat(path: string): { isFile(): boolean; size: number };
	writeExclusive(path: string, bytes: Uint8Array): void;
	rename(from: string, to: string): void;
	remove(path: string): void;
}

const defaultFileOps: MediaCacheFileOps = {
	mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
	read: (path) => new Uint8Array(readFileSync(path)),
	stat: (path) => statSync(path),
	writeExclusive: (path, bytes) => {
		const fd = openSync(path, "wx", 0o600);
		try {
			writeFileSync(fd, bytes);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	},
	rename: renameSync,
	remove: (path) => rmSync(path, { force: true }),
};

export interface EnsureLocalMediaOptions {
	cacheDir?: string;
	signal?: AbortSignal;
	fileOps?: MediaCacheFileOps;
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

function downloadSource(
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

function isReadyPath(
	path: string | null,
	mimeForPath: (path: string) => unknown,
	maxBytes: number,
	fileOps: MediaCacheFileOps,
): boolean {
	if (!path || !mimeForPath(path)) return false;
	try {
		const stat = fileOps.stat(path);
		return stat.isFile() && stat.size > 0 && stat.size <= maxBytes;
	} catch {
		return false;
	}
}

export function isDisplayReadyPath(path: string | null, fileOps: MediaCacheFileOps = defaultFileOps): boolean {
	return isReadyPath(path, staticMediaMimeForPath, MEDIA_CACHE_MAX_BYTES, fileOps);
}

export function isSourceReadyPath(path: string | null, fileOps: MediaCacheFileOps = defaultFileOps): boolean {
	return isReadyPath(path, sourceMediaMimeForPath, MEDIA_DOWNLOAD_MAX_BYTES, fileOps);
}

/** Resolve a cache-relative source filename inside this deployment's media directory. */
export function resolveMediaSourcePath(cacheDir: string, storedPath: string | null): string | null {
	if (!storedPath || storedPath.includes("\0")) return null;
	const filename = basename(storedPath);
	if (!filename || filename === "." || filename === ".." || !sourceMediaMimeForPath(filename)) return null;
	return join(cacheDir, filename);
}

/** Resolve only a display-ready static-image filename; video sources never enter IPC. */
export function resolveMediaCachePath(cacheDir: string, storedPath: string | null): string | null {
	const sourcePath = resolveMediaSourcePath(cacheDir, storedPath);
	return sourcePath && staticMediaMimeForPath(sourcePath) ? sourcePath : null;
}

/**
 * Canonicalize legacy absolute cache paths after a checkout/deployment move. Existing files are
 * addressed by basename inside the configured cache directory; missing/unsupported entries are
 * cleared so the bounded display-media queue can acquire them again.
 */
export function reconcileMediaCachePaths(
	db: Database,
	cacheDir: string,
	fileOps: MediaCacheFileOps = defaultFileOps,
): { migrated: number; invalidated: number } {
	const rows = db.query("SELECT file_unique_id, local_path FROM media WHERE local_path IS NOT NULL").all() as {
		file_unique_id: string;
		local_path: string;
	}[];
	let migrated = 0;
	let invalidated = 0;
	const update = db.query("UPDATE media SET local_path = ? WHERE file_unique_id = ?");
	const reconcile = db.transaction(() => {
		for (const row of rows) {
			const resolved = resolveMediaSourcePath(cacheDir, row.local_path);
			if (resolved && isSourceReadyPath(resolved, fileOps)) {
				const canonical = basename(resolved);
				if (row.local_path !== canonical) {
					update.run(canonical, row.file_unique_id);
					migrated++;
				}
				continue;
			}
			update.run(null, row.file_unique_id);
			invalidated++;
		}
	});
	reconcile();
	return { migrated, invalidated };
}

function readExisting(
	path: string,
	fileOps: MediaCacheFileOps,
): { bytes: Uint8Array; mimeType: SourceMediaMime; sourceExtension: string } | null {
	const mimeType = sourceMediaMimeForPath(path);
	const sourceExtension = normalizedSourceExtension(path);
	if (!mimeType || !sourceExtension) return null;
	try {
		const stat = fileOps.stat(path);
		if (!stat.isFile() || stat.size <= 0 || stat.size > MEDIA_DOWNLOAD_MAX_BYTES) return null;
		const bytes = fileOps.read(path);
		if (bytes.byteLength !== stat.size || bytes.byteLength === 0 || bytes.byteLength > MEDIA_DOWNLOAD_MAX_BYTES)
			return null;
		return { bytes, mimeType, sourceExtension };
	} catch {
		return null;
	}
}

/** Install complete bytes with owner-only permissions, then expose them with one rename. */
export function installMediaCacheFile(
	cacheDir: string,
	fileUniqueId: string,
	extension: string,
	bytes: Uint8Array,
	fileOps: MediaCacheFileOps = defaultFileOps,
): string {
	fileOps.mkdir(cacheDir);
	const basename = createHash("sha256").update(fileUniqueId).digest("hex").slice(0, 32);
	const target = join(cacheDir, `${basename}.${extension}`);
	const temporary = `${target}.${process.pid}.${temporarySequence++}.tmp`;
	try {
		fileOps.writeExclusive(temporary, bytes);
		fileOps.rename(temporary, target);
		return target;
	} catch {
		try {
			fileOps.remove(temporary);
		} catch {
			// A failed cleanup must not expose the original filesystem error or media identity.
		}
		throw new Error("media cache install failed");
	}
}

/** Coalesce concurrent same-identity async work per database; each caller owns its WeakMap namespace. */
export function dedupeInFlight<T>(
	byDb: WeakMap<Database, Map<string, Promise<T>>>,
	db: Database,
	key: string,
	work: () => Promise<T>,
): Promise<T> {
	let inFlight = byDb.get(db);
	if (!inFlight) {
		inFlight = new Map();
		byDb.set(db, inFlight);
	}
	const existing = inFlight.get(key);
	if (existing) return existing;
	const map = inFlight;
	const promise = work().finally(() => {
		map.delete(key);
	});
	map.set(key, promise);
	return promise;
}

const inFlightByDb = new WeakMap<Database, Map<string, Promise<LocalMediaResult>>>();

/** Share Telegram download and atomic cache installation across UI precache and context media. */
export function ensureLocalMedia(
	db: Database,
	api: MediaDownloadApi,
	botId: string,
	fileUniqueId: string,
	options: EnsureLocalMediaOptions = {},
): Promise<LocalMediaResult> {
	return dedupeInFlight(inFlightByDb, db, fileUniqueId, () =>
		ensureLocalMediaInner(db, api, botId, fileUniqueId, options),
	);
}

async function ensureLocalMediaInner(
	db: Database,
	api: MediaDownloadApi,
	botId: string,
	fileUniqueId: string,
	options: EnsureLocalMediaOptions,
): Promise<LocalMediaResult> {
	const fileOps = options.fileOps ?? defaultFileOps;
	const cacheDir = options.cacheDir ?? join(process.cwd(), "data", "media");
	const signal = options.signal;
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
	const video = isVideoMedia(media.kind, media.mime);
	if (media.local_path) {
		const existingPath = resolveMediaSourcePath(cacheDir, media.local_path);
		const existing = existingPath ? readExisting(existingPath, fileOps) : null;
		if (existing) {
			const existingVideo = video || existing.mimeType.startsWith("video/");
			const displayReady = !existingVideo && isDisplayReadyPath(existingPath, fileOps);
			return {
				ok: true,
				kind,
				...existing,
				sourcePath: existingPath,
				mediaPath: displayReady ? existingPath : null,
				cacheOutcome: displayReady || existingVideo ? "cached" : "oversize",
			};
		}
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
	const sourceVideo = video || mimeType.startsWith("video/");

	let bytes: Uint8Array;
	try {
		bytes = await source.api.downloadFile(remotePath, signal);
	} catch {
		return { ok: false, outcome: signal?.aborted ? "aborted" : "telegram_download_failed" };
	}
	if (signal?.aborted) return { ok: false, outcome: "aborted" };
	if (bytes.byteLength === 0) return { ok: false, outcome: "empty_file" };
	if (bytes.byteLength > MEDIA_DOWNLOAD_MAX_BYTES) return { ok: false, outcome: "download_oversize" };
	if (!sourceVideo && bytes.byteLength > MEDIA_CACHE_MAX_BYTES) {
		return {
			ok: true,
			kind,
			bytes,
			mimeType,
			sourceExtension: extension,
			sourcePath: null,
			mediaPath: null,
			cacheOutcome: "oversize",
		};
	}

	let sourcePath: string | null = null;
	try {
		sourcePath = installMediaCacheFile(cacheDir, fileUniqueId, extension, bytes, fileOps);
		if (signal?.aborted) {
			fileOps.remove(sourcePath);
			return { ok: false, outcome: "aborted" };
		}
		db.query("UPDATE media SET local_path = ? WHERE file_unique_id = ?").run(basename(sourcePath), fileUniqueId);
	} catch {
		if (sourcePath) {
			try {
				fileOps.remove(sourcePath);
			} catch {
				// The DB remains authoritative; cleanup failure is intentionally non-sensitive.
			}
		}
		return {
			ok: true,
			kind,
			bytes,
			mimeType,
			sourceExtension: extension,
			sourcePath: null,
			mediaPath: null,
			cacheOutcome: "install_failed",
		};
	}
	return {
		ok: true,
		kind,
		bytes,
		mimeType,
		sourceExtension: extension,
		sourcePath,
		mediaPath: sourceVideo ? null : sourcePath,
		cacheOutcome: "ready",
	};
}
