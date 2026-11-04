// Shared image preparation for vision and view_image: Telegram identity -> bounded provider-ready
// images. Photos and static stickers become one PNG/JPEG (WebP/GIF via Pi convertToPng, then
// Pi resizeImage with one fixed bound); videos and video stickers are sampled into 1-3 JPEG
// frames by ffmpeg and bound the same way. Vision sends the result to completeSimple;
// view_image installs it as derived cache files whose names follow from the media identity, so
// pruning and projection need no record of them. No provider call happens here.

import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";
import {
	dedupeInFlight,
	ensureLocalMedia,
	installMediaCacheFile,
	isVideoMedia,
	isVisionMedia,
	type LocalMediaFailure,
	type MediaDownloadApi,
	mediaCacheFileName,
} from "./local-cache.ts";
import {
	extractVideoFrames,
	VIDEO_FRAME_MAX,
	type VideoFrameInput,
	type VideoFrameOutcome,
	type VideoFrameResult,
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
	| "conversion_failed"
	| "install_failed";

export type PrepareMediaImagesResult =
	| { ok: true; kind: "static" | "video"; images: PreparedImage[] }
	| { ok: false; outcome: PrepareMediaImagesFailure };

export interface PrepareMediaImagesOptions {
	cacheDir: string;
	/** Startup snapshot: without FFmpeg, videos are skipped before any Telegram download. */
	videoTranscoder: boolean;
	signal?: AbortSignal;
	/** Lets a routed bot reuse media received through another configured bot. */
	botApis?: ReadonlyMap<string, MediaDownloadApi>;
	/** Deterministic extraction seam; production uses ffprobe + ffmpeg. */
	extractFrames?: (input: VideoFrameInput) => Promise<VideoFrameResult>;
	/** Deterministic resize seam; production uses Pi resizeImage. */
	resize?: typeof resizeImage;
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
	const video = isVideoMedia(media.kind, media.mime);
	if (video && !options.videoTranscoder) return { ok: false, outcome: "video_transcoder_unavailable" };

	const local = await ensureLocalMedia(db, api, botId, fileUniqueId, {
		cacheDir: options.cacheDir,
		signal: options.signal,
		botApis: options.botApis,
	});
	if (!local.ok) return local;

	if (video) {
		const frames = await (options.extractFrames ?? extractVideoFrames)({
			sourcePath: local.sourcePath,
			sourceBytes: local.bytes,
			sourceExtension: local.sourceExtension,
		});
		if (!frames.ok) return frames;
		const images: PreparedImage[] = [];
		for (const frame of frames.frames) {
			const bounded = await boundImage(options.resize ?? resizeImage, frame.bytes, frame.mimeType);
			if (!bounded) return { ok: false, outcome: "conversion_failed" };
			images.push({ ...bounded, position: frame.position });
		}
		return { ok: true, kind: "video", images };
	}

	let bytes: Uint8Array = local.bytes;
	let mimeType: string = local.mimeType;
	if (mimeType === "image/webp" || mimeType === "image/gif") {
		const converted = await convertToPng(Buffer.from(bytes).toString("base64"), mimeType).catch(() => null);
		if (!converted) return { ok: false, outcome: "conversion_failed" };
		bytes = new Uint8Array(Buffer.from(converted.data, "base64"));
		mimeType = converted.mimeType;
	}
	const resized = await boundImage(options.resize ?? resizeImage, bytes, mimeType);
	return resized ? { ok: true, kind: "static", images: [resized] } : { ok: false, outcome: "conversion_failed" };
}

/** One image under the provider budget, or null when Pi cannot resize or encode it. */
async function boundImage(
	resize: typeof resizeImage,
	bytes: Uint8Array,
	mimeType: string,
): Promise<PreparedImage | null> {
	const resized = await resize(bytes, mimeType, MEDIA_IMAGE_RESIZE).catch(() => null);
	if (
		!resized ||
		resized.data.length > MEDIA_IMAGE_RESIZE.maxBytes ||
		(resized.mimeType !== "image/png" && resized.mimeType !== "image/jpeg")
	)
		return null;
	return { bytes: new Uint8Array(Buffer.from(resized.data, "base64")), mimeType: resized.mimeType };
}

/** A prepared image file in the media cache dir; view_image results store only these refs. */
export interface ImageRef {
	name: string;
	mime: string;
}

export type ViewImagesResult = { ok: true; images: ImageRef[] } | { ok: false; outcome: PrepareMediaImagesFailure };

const PREPARED_MIMES: PreparedImageMime[] = ["image/png", "image/jpeg"];
const extensionFor = (mime: string) => (mime === "image/png" ? "png" : "jpg");
const slots = (video: boolean) =>
	video ? Array.from({ length: VIDEO_FRAME_MAX }, (_, index) => `frame${index}`) : ["ctx"];

/** Every derived file name this identity can have; pruning removes whichever exist. */
export function derivedImageNames(fileUniqueId: string): string[] {
	return [...slots(false), ...slots(true)].flatMap((slot) =>
		PREPARED_MIMES.map((mime) => mediaCacheFileName(`${fileUniqueId}#${slot}`, extensionFor(mime))),
	);
}

/** Already-prepared images: the still, or the leading run of video frames. */
function existingImages(cacheDir: string, fileUniqueId: string): ImageRef[] {
	const found = (slot: string): ImageRef | null => {
		for (const mime of PREPARED_MIMES) {
			const name = mediaCacheFileName(`${fileUniqueId}#${slot}`, extensionFor(mime));
			try {
				const bytes = statSync(join(cacheDir, name)).size;
				if (bytes > 0 && Math.ceil(bytes / 3) * 4 <= MEDIA_IMAGE_RESIZE.maxBytes) return { name, mime };
			} catch {
				/* Missing cache files are regenerated below. */
			}
		}
		return null;
	};
	const still = found("ctx");
	if (still) return [still];
	const frames: ImageRef[] = [];
	for (const slot of slots(true)) {
		const frame = found(slot);
		if (!frame) break;
		frames.push(frame);
	}
	return frames;
}

/**
 * Resolve a prepared image reference into a provider ImageContent at projection time. Reads are
 * synchronous and local; a missing/unreadable file drops the block (never throws into projection).
 */
export function createImageRefResolver(cacheDir: string): (ref: ImageRef) => ImageContent | null {
	return (ref) => {
		if (!ref.name || basename(ref.name) !== ref.name || ref.name.includes("\0")) return null;
		try {
			const bytes = readFileSync(join(cacheDir, ref.name));
			if (bytes.byteLength === 0 || Math.ceil(bytes.byteLength / 3) * 4 > MEDIA_IMAGE_RESIZE.maxBytes) return null;
			return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: ref.mime };
		} catch {
			return null;
		}
	};
}

const viewInFlight = new Map<string, Promise<ViewImagesResult>>();

/** view_image: prepared image files for one media identity, made once and reused. Never throws. */
export function ensureViewImages(
	db: Database,
	api: MediaDownloadApi,
	botId: string,
	fileUniqueId: string,
	options: PrepareMediaImagesOptions,
): Promise<ViewImagesResult> {
	return dedupeInFlight(viewInFlight, fileUniqueId, async (): Promise<ViewImagesResult> => {
		const cached = existingImages(options.cacheDir, fileUniqueId);
		if (cached.length > 0) return { ok: true, images: cached };
		const prepared = await prepareMediaImages(db, api, botId, fileUniqueId, options);
		if (!prepared.ok) return prepared;
		const images: ImageRef[] = [];
		const names = slots(prepared.kind === "video");
		for (const [index, image] of prepared.images.entries()) {
			try {
				const identity = `${fileUniqueId}#${names[index]}`;
				const path = installMediaCacheFile(options.cacheDir, identity, extensionFor(image.mimeType), image.bytes);
				images.push({ name: basename(path), mime: image.mimeType });
			} catch {
				return { ok: false, outcome: "install_failed" };
			}
		}
		return { ok: true, images };
	});
}
