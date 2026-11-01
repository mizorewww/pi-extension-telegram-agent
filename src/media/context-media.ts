// Image files for view_image: turn a Telegram media identity into bounded images the main model
// sees directly. Bytes come from the shared prepare-images pipeline; this module installs them in
// the media cache dir and records them in media.context_files, so pruning and projection share
// one source of truth. voice / audio / non-video document / TGS stickers never produce images.

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { dedupeInFlight, installMediaCacheFile, type MediaDownloadApi } from "./local-cache.ts";
import {
	prepareMediaImages,
	type PrepareMediaImagesFailure,
	type PrepareMediaImagesOptions,
} from "./prepare-images.ts";

/** Cache-relative prepared image ready to become an ImageContent block. */
export interface ContextMediaImage {
	name: string;
	mime: string;
}

export type EnsureContextMediaOptions = PrepareMediaImagesOptions;

export type ContextMediaFailure = PrepareMediaImagesFailure | "install_failed";

export type ContextMediaResult =
	| { ok: true; images: ContextMediaImage[] }
	| { ok: false; outcome: ContextMediaFailure };

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

const inFlightByDb = new WeakMap<Database, Map<string, Promise<ContextMediaResult>>>();

/** Ensure prepared context images exist; same-identity calls share one preparation. Never throws. */
export function ensureContextMedia(
	db: Database,
	api: MediaDownloadApi,
	botId: string,
	fileUniqueId: string,
	options: EnsureContextMediaOptions,
): Promise<ContextMediaResult> {
	return dedupeInFlight(inFlightByDb, db, fileUniqueId, () =>
		ensureContextMediaInner(db, api, botId, fileUniqueId, options),
	);
}

async function ensureContextMediaInner(
	db: Database,
	api: MediaDownloadApi,
	botId: string,
	fileUniqueId: string,
	options: EnsureContextMediaOptions,
): Promise<ContextMediaResult> {
	const cached = contextMediaRefs(db, fileUniqueId);
	if (cached) return { ok: true, images: cached };
	const prepared = await prepareMediaImages(db, api, botId, fileUniqueId, options);
	if (!prepared.ok) return prepared;

	const images: ContextMediaImage[] = [];
	for (let index = 0; index < prepared.images.length; index++) {
		const image = prepared.images[index]!;
		const extension = image.mimeType === "image/png" ? "png" : "jpg";
		const suffix = prepared.kind === "video" ? `frame${index}` : "ctx";
		try {
			const path = installMediaCacheFile(options.cacheDir, `${fileUniqueId}#${suffix}`, extension, image.bytes);
			images.push({ name: basename(path), mime: image.mimeType });
		} catch {
			return { ok: false, outcome: "install_failed" };
		}
	}
	db.query("UPDATE media SET context_files = ? WHERE file_unique_id = ?").run(JSON.stringify(images), fileUniqueId);
	return { ok: true, images };
}
