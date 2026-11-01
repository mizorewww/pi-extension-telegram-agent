// Shared image preparation for vision and view_image: Telegram identity -> bounded provider-ready
// images. Photos and static stickers become one PNG/JPEG (WebP/GIF via Pi convertToPng, then
// Pi resizeImage with one fixed bound); videos and video stickers are sampled into 1-3 JPEG
// frames by ffmpeg (already bounded to 1280px). Vision sends the result to completeSimple;
// view_image installs it as derived cache files. No provider call happens here.

import type { Database } from "bun:sqlite";
import { convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";
import {
	ensureLocalMedia,
	isVideoMedia,
	isVisionMedia,
	type LocalMediaFailure,
	type MediaDownloadApi,
} from "./local-cache.ts";
import {
	extractVideoFrames,
	type VideoFrameInput,
	type VideoFrameOutcome,
	type VideoFrameResult,
	type VideoTranscoderAvailability,
} from "./video-frames.ts";

/**
 * Prepared images ride provider payloads as base64 (view_image) or a single vision request,
 * so the encoded size is bounded hard: 1024px / ~200KB keeps content readable while a
 * photo-heavy group cannot balloon one request body into tens of MB.
 */
export const MEDIA_IMAGE_RESIZE = { maxWidth: 1024, maxHeight: 1024, maxBytes: 200_000, jpegQuality: 80 } as const;

export type PreparedImageMime = "image/jpeg" | "image/png";

export interface PreparedImage {
	bytes: Uint8Array;
	mimeType: PreparedImageMime;
	/** Normalized position in the source duration (video frames only). */
	position?: number;
}

export type PrepareMediaImagesFailure =
	| LocalMediaFailure
	| VideoFrameOutcome
	| "unsupported_format"
	| "conversion_failed";

export type PrepareMediaImagesResult =
	| { ok: true; kind: "static" | "video"; sourceBytes: number; images: PreparedImage[] }
	| { ok: false; outcome: PrepareMediaImagesFailure };

export interface PrepareMediaImagesOptions {
	cacheDir: string;
	/** Startup snapshot: missing ffmpeg/ffprobe skips videos before any Telegram download. */
	videoTranscoder: VideoTranscoderAvailability;
	signal?: AbortSignal;
	/** Lets a routed bot reuse media received through another configured bot. */
	botApis?: ReadonlyMap<string, MediaDownloadApi>;
	/** Deterministic extraction seam; production uses ffprobe + ffmpeg. */
	extractFrames?: (input: VideoFrameInput) => Promise<VideoFrameResult>;
	/** Deterministic resize seam; production uses Pi resizeImage. */
	resize?: typeof resizeImage;
}

function transcoderReady(transcoder: VideoTranscoderAvailability): boolean {
	return transcoder.ffmpeg && transcoder.ffprobe;
}

/** Download (or reuse) the source and turn it into bounded PNG/JPEG images. Never throws. */
export async function prepareMediaImages(
	db: Database,
	api: MediaDownloadApi,
	botId: string,
	fileUniqueId: string,
	options: PrepareMediaImagesOptions,
): Promise<PrepareMediaImagesResult> {
	const media = db.query("SELECT kind, mime FROM media WHERE file_unique_id = ?").get(fileUniqueId) as {
		kind: string;
		mime: string | null;
	} | null;
	if (!media || !isVisionMedia(media.kind, media.mime)) return { ok: false, outcome: "media_unavailable" };
	let video = isVideoMedia(media.kind, media.mime);
	if (video && !transcoderReady(options.videoTranscoder)) return { ok: false, outcome: "video_transcoder_unavailable" };

	const local = await ensureLocalMedia(db, api, botId, fileUniqueId, {
		cacheDir: options.cacheDir,
		signal: options.signal,
		botApis: options.botApis,
	});
	if (!local.ok) return local;
	const sourceBytes = local.bytes.byteLength;
	// Sticker rows may be recorded as static before the download reveals a video container.
	if (!video && media.kind === "sticker" && local.mimeType.startsWith("video/")) {
		video = true;
		if (!transcoderReady(options.videoTranscoder)) return { ok: false, outcome: "video_transcoder_unavailable" };
	}

	if (video) {
		const frames = await (options.extractFrames ?? extractVideoFrames)({
			sourcePath: local.sourcePath,
			sourceBytes: local.bytes,
			sourceExtension: local.sourceExtension,
		});
		if (!frames.ok) return frames;
		return { ok: true, kind: "video", sourceBytes, images: frames.frames };
	}

	if (local.mimeType.startsWith("video/")) return { ok: false, outcome: "unsupported_format" };
	let bytes: Uint8Array = local.bytes;
	let mimeType: string = local.mimeType;
	if (mimeType === "image/webp" || mimeType === "image/gif") {
		const converted = await convertToPng(Buffer.from(bytes).toString("base64"), mimeType).catch(() => null);
		if (!converted) return { ok: false, outcome: "conversion_failed" };
		bytes = new Uint8Array(Buffer.from(converted.data, "base64"));
		mimeType = converted.mimeType;
	}
	// A resize failure falls back to the converted/original image rather than dropping it.
	const resized = await (options.resize ?? resizeImage)(bytes, mimeType, MEDIA_IMAGE_RESIZE).catch(() => null);
	if (resized) {
		bytes = new Uint8Array(Buffer.from(resized.data, "base64"));
		mimeType = resized.mimeType;
	}
	if (mimeType !== "image/png" && mimeType !== "image/jpeg") return { ok: false, outcome: "conversion_failed" };
	return { ok: true, kind: "static", sourceBytes, images: [{ bytes, mimeType }] };
}
