// Telegram downloads and video sampling are local policy; Pi prepares native image blocks.
import type { Database } from "../db/db.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import {
	dedupeInFlight,
	ensureLocalMedia,
	isVideoMedia,
	isVisionMedia,
	type LocalMediaFailure,
	type MediaDownloadApi,
} from "./local-cache.ts";
import { extractVideoFrames, type VideoFrameOutcome } from "./video-frames.ts";

export const MEDIA_IMAGE_RESIZE = { maxWidth: 1024, maxHeight: 1024, maxBytes: 200_000 } as const;
export type PreparedImageMime = string;
export interface PreparedImage {
	bytes: Uint8Array;
	mimeType: PreparedImageMime;
	position?: number;
}
export type PrepareMediaImagesFailure = LocalMediaFailure | VideoFrameOutcome | "conversion_failed";
export type PrepareMediaImagesResult =
	| { ok: true; kind: "static" | "video"; images: PreparedImage[] }
	| { ok: false; outcome: PrepareMediaImagesFailure };
export interface PrepareMediaImagesOptions {
	cacheDir: string;
	videoTranscoder: boolean;
	signal?: AbortSignal;
}
const processor = createNodePhotonImages();
const inFlight = new Map<string, Promise<PrepareMediaImagesResult>>();

export function prepareMediaImages(
	db: Database,
	api: MediaDownloadApi,
	fileUniqueId: string,
	options: PrepareMediaImagesOptions,
): Promise<PrepareMediaImagesResult> {
	return dedupeInFlight(inFlight, fileUniqueId, async () => {
		const media = db.prepare("SELECT kind, mime FROM media WHERE file_unique_id = ?").get(fileUniqueId) as
			| { kind: string; mime: string | null }
			| undefined;
		if (!media || !isVisionMedia(media.kind, media.mime)) return { ok: false, outcome: "media_unavailable" };
		const video = isVideoMedia(media.kind, media.mime);
		if (video && !options.videoTranscoder) return { ok: false, outcome: "video_transcoder_unavailable" };
		const local = await ensureLocalMedia(db, api, fileUniqueId, options);
		if (!local.ok) return local;
		let sources: PreparedImage[] = [local];
		if (video) {
			const frames = await extractVideoFrames(local);
			if (!frames.ok) return frames;
			sources = frames.frames;
		}
		const images: PreparedImage[] = [];
		for (const source of sources) {
			if (options.signal?.aborted) return { ok: false, outcome: "aborted" };
			// Buffer.slice() aliases its pool; Pi transfers a Uint8Array copy to its worker.
			const image = await (await processor)
				.prepare(Uint8Array.from(source.bytes), source.mimeType, MEDIA_IMAGE_RESIZE)
				.catch(() => undefined);
			if (!image) return { ok: false, outcome: "conversion_failed" };
			images.push({ bytes: Buffer.from(image.data, "base64"), mimeType: image.mimeType, position: source.position });
		}
		return { ok: true, kind: video ? "video" : "static", images };
	});
}

/** Pi persists the returned images; source cache pruning never changes a previous request. */
export async function ensureViewImages(
	db: Database,
	api: MediaDownloadApi,
	fileUniqueId: string,
	options: PrepareMediaImagesOptions,
): Promise<{ ok: true; images: ImageContent[] } | { ok: false; outcome: PrepareMediaImagesFailure }> {
	const prepared = await prepareMediaImages(db, api, fileUniqueId, options);
	return prepared.ok
		? {
				ok: true,
				images: prepared.images.map((image) => ({
					type: "image",
					data: Buffer.from(image.bytes).toString("base64"),
					mimeType: image.mimeType,
				})),
			}
		: prepared;
}
