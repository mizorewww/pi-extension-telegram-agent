// Context media preparation: turn a Telegram media identity into bounded image files the main
// model can see directly (no auxiliary vision model, no text descriptions). Photos and static
// stickers become one converted/resized image; videos (incl. video stickers and GIF animations)
// are sampled into 1-3 JPEG frames. Prepared files live in the media cache dir next to the
// source download and are recorded in media.context_files so pruning and context packing share
// one source of truth. voice / audio / non-video document / TGS stickers never produce images.

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";
import {
	dedupeInFlight,
	ensureLocalMedia,
	installMediaCacheFile,
	isVideoMedia,
	isVisionMedia,
	staticMediaMimeForPath,
	type MediaDownloadApi,
} from "./local-cache.ts";
import {
	extractVideoFrames,
	inspectVideoTranscoder,
	type VideoFrameInput,
	type VideoFrameResult,
	type VideoTranscoderAvailability,
} from "./video-frames.ts";

/** Cache-relative prepared image ready to become an ImageContent block. */
export interface ContextMediaImage {
	name: string;
	mime: string;
}

export interface EnsureContextMediaOptions {
	/** Deterministic test seam; production uses data/media under cwd. */
	cacheDir?: string;
	signal?: AbortSignal;
	/** Lets a routed bot reuse media received through another configured bot. */
	botApis?: ReadonlyMap<string, MediaDownloadApi>;
	/** Startup snapshot: missing ffmpeg/ffprobe skips videos before any download. */
	videoTranscoder?: VideoTranscoderAvailability;
	/** Deterministic extraction seam; production uses ffprobe + ffmpeg. */
	extractFrames?: (input: VideoFrameInput) => Promise<VideoFrameResult>;
	convert?: typeof convertToPng;
	resize?: typeof resizeImage;
}

function parseContextFiles(value: string | null): ContextMediaImage[] | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return null;
		const refs = parsed.filter(
			(entry): entry is ContextMediaImage =>
				entry != null &&
				typeof entry === "object" &&
				typeof (entry as ContextMediaImage).name === "string" &&
				(entry as ContextMediaImage).name.length > 0 &&
				typeof (entry as ContextMediaImage).mime === "string",
		);
		return refs.length > 0 ? refs : null;
	} catch {
		return null;
	}
}

/** Already-prepared context images for this media identity, if any. */
export function contextMediaRefs(db: Database, fileUniqueId: string): ContextMediaImage[] | null {
	const row = db.query("SELECT context_files FROM media WHERE file_unique_id = ?").get(fileUniqueId) as {
		context_files: string | null;
	} | null;
	return parseContextFiles(row?.context_files ?? null);
}

/**
 * Resolve a prepared image reference into a provider ImageContent at projection time. Reads are
 * synchronous and local; a missing/unreadable file drops the block (never throws into projection).
 */
export function createContextImageResolver(cacheDir: string): (ref: ContextMediaImage) => ImageContent | null {
	return (ref) => {
		if (!ref.name || basename(ref.name) !== ref.name || ref.name.includes("\0")) return null;
		try {
			const bytes = readFileSync(join(cacheDir, ref.name));
			if (bytes.byteLength === 0) return null;
			return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: ref.mime };
		} catch {
			return null;
		}
	};
}

const inFlightByDb = new WeakMap<Database, Map<string, Promise<ContextMediaImage[] | null>>>();

/** Ensure prepared context images exist; same-identity calls share one preparation. */
export function ensureContextMedia(
	db: Database,
	api: MediaDownloadApi,
	botId: string,
	fileUniqueId: string,
	options: EnsureContextMediaOptions = {},
): Promise<ContextMediaImage[] | null> {
	return dedupeInFlight(inFlightByDb, db, fileUniqueId, () =>
		ensureContextMediaInner(db, api, botId, fileUniqueId, options),
	);
}

function installDerived(
	cacheDir: string,
	fileUniqueId: string,
	suffix: string,
	extension: string,
	bytes: Uint8Array,
): string | null {
	try {
		const path = installMediaCacheFile(cacheDir, `${fileUniqueId}#${suffix}`, extension, bytes);
		return basename(path);
	} catch {
		return null;
	}
}

async function ensureContextMediaInner(
	db: Database,
	api: MediaDownloadApi,
	botId: string,
	fileUniqueId: string,
	options: EnsureContextMediaOptions,
): Promise<ContextMediaImage[] | null> {
	const cached = contextMediaRefs(db, fileUniqueId);
	if (cached) return cached;
	const media = db.query("SELECT kind, mime FROM media WHERE file_unique_id = ?").get(fileUniqueId) as {
		kind: string;
		mime: string | null;
	} | null;
	if (!media || !isVisionMedia(media.kind, media.mime)) return null;
	let video = isVideoMedia(media.kind, media.mime);
	if (video) {
		const transcoder = options.videoTranscoder ?? inspectVideoTranscoder();
		if (!transcoder.ffmpeg || !transcoder.ffprobe) return null;
	}
	const cacheDir = options.cacheDir ?? join(process.cwd(), "data", "media");
	const local = await ensureLocalMedia(db, api, botId, fileUniqueId, {
		cacheDir,
		signal: options.signal,
		botApis: options.botApis,
	});
	if (!local.ok) return null;
	if (!video && media.kind === "sticker" && local.mimeType.startsWith("video/")) video = true;

	let refs: ContextMediaImage[] | null = null;
	if (video) {
		const prepared = await (options.extractFrames ?? extractVideoFrames)({
			sourcePath: local.sourcePath,
			sourceBytes: local.bytes,
			sourceExtension: local.sourceExtension,
		});
		if (!prepared.ok) return null;
		const installed: ContextMediaImage[] = [];
		for (let index = 0; index < prepared.frames.length; index++) {
			const name = installDerived(cacheDir, fileUniqueId, `frame${index}`, "jpg", prepared.frames[index]!.bytes);
			if (!name) return null;
			installed.push({ name, mime: "image/jpeg" });
		}
		refs = installed.length > 0 ? installed : null;
	} else {
		if (!staticMediaMimeForPath(`source.${local.sourceExtension}`)) return null;
		let bytes: Uint8Array = local.bytes;
		let mimeType: string = local.mimeType;
		if (mimeType === "image/webp" || mimeType === "image/gif") {
			const convert = options.convert ?? convertToPng;
			const converted = await convert(Buffer.from(bytes).toString("base64"), mimeType).catch(() => null);
			if (!converted) return null;
			bytes = new Uint8Array(Buffer.from(converted.data, "base64"));
			mimeType = converted.mimeType;
		}
		// A resize failure falls back to the converted/original image rather than dropping it.
		// Context images ride the provider payload as base64, so bound the encoded size hard:
		// the Pi default (4.5MB) leaves Telegram photos untouched and lets a photo-heavy group
		// balloon the request body into tens of MB. 1024px / ~200KB keeps content readable
		// while keeping the per-call payload bounded.
		const resize = options.resize ?? resizeImage;
		const resized = await resize(bytes, mimeType, {
			maxWidth: 1024,
			maxHeight: 1024,
			maxBytes: 200_000,
			jpegQuality: 80,
		}).catch(() => null);
		if (resized) {
			bytes = new Uint8Array(Buffer.from(resized.data, "base64"));
			mimeType = resized.mimeType;
		}
		const extension = mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : null;
		if (!extension) return null;
		const name = installDerived(cacheDir, fileUniqueId, "ctx", extension, bytes);
		refs = name ? [{ name, mime: mimeType }] : null;
	}
	if (!refs) return null;
	db.query("UPDATE media SET context_files = ? WHERE file_unique_id = ?").run(JSON.stringify(refs), fileUniqueId);
	return refs;
}
