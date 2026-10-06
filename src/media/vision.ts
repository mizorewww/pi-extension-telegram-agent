// Lazy, persistent photo/sticker/video vision shared by every bot in one deployment.
// Provider execution uses the daemon's shared Pi ModelRuntime; this module never
// starts another CLI or reads provider credential material.

import type { Database } from "bun:sqlite";
import { log } from "../observability/log.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { contentText, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import type { BotApi } from "../telegram/api.ts";
import { parsePiModelReference } from "../agent/model-ref.ts";
import {
	classifyPiProviderFailure,
	PiModelConfigurationError,
	type PiProviderFailureCategory,
} from "../agent/model-runtime.ts";
import { bytesBucket, dedupeInFlight, isVideoMedia, isVisionMedia, type MediaBytesBucket } from "./local-cache.ts";
import { appendMediaUpdateEvents } from "../db/message-events.ts";
import type { VisionScheduler } from "./vision-scheduler.ts";
import {
	prepareMediaImages,
	type PreparedImageMime,
	type PrepareMediaImagesFailure,
	type PrepareMediaImagesOptions,
} from "./prepare-images.ts";

export { fileIdForBot } from "./local-cache.ts";

const PHOTO_PROMPT = `你在帮一个群聊 bot 理解图片。简短描述：实际可见内容、重要文字/OCR（尤其是界面和报错）、人物或物体、对聊天可能有用的信息、不确定的地方。2-3 句话以内，用中文，直接给描述不要客套。`;

const STICKER_PROMPT = `你在帮一个群聊 bot 理解一张 sticker（聊天表情贴图）。把它理解为一种聊天表达，输出短描述：communicative intent（想表达什么）、emotion、intensity、gesture/画面要点、可见文字。一两句话，用中文，例如"得意的赞同，smug/amused，中等强度"。直接给描述不要客套。`;

const VIDEO_PROMPT = `你在帮一个群聊 bot 理解一段视频。下面是按时间顺序抽取的代表帧。综合描述动作或变化、人物与物体、重要文字/OCR、对聊天有用的信息和不确定处。2-3 句话以内，用中文，直接给描述不要客套；不要把单帧猜测说成确定的完整情节。`;

const VIDEO_STICKER_PROMPT = `你在帮一个群聊 bot 理解一个 video sticker。下面是按时间顺序抽取的代表帧。把它理解为聊天表达，概括动作变化、communicative intent、emotion、intensity、gesture/画面要点和可见文字。一两句话，用中文，直接给描述不要客套。`;

export const VISION_TIMEOUT_MS = 90_000;
export const VISION_MAX_OUTPUT_TOKENS = 256;

export type VisionKind = "photo" | "sticker" | "video";
export type VisionBytesBucket = MediaBytesBucket | "gte_512_kib";
export type VisionOutcome =
	| "ok"
	| "empty_response"
	| "media_download_aborted"
	| Exclude<PrepareMediaImagesFailure, "aborted">
	| PiProviderFailureCategory;

export interface VisionTelemetry {
	kind: VisionKind;
	sourceBytesBucket: VisionBytesBucket;
	convertedBytesBucket: VisionBytesBucket;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cost: number;
	outcome: VisionOutcome;
	frames?: number;
	providerCalled?: boolean;
}

export interface VisionDescriptionResult {
	text: string | null;
	telemetry: VisionTelemetry;
}

export interface VisionImageInput {
	bytes: Uint8Array;
	mimeType: PreparedImageMime;
	position?: number;
}

export interface VisionDescribeInput {
	kind: VisionKind;
	sourceBytes: number;
	images: VisionImageInput[];
	videoSticker?: boolean;
}

export interface VisionExecutor {
	readonly modelRef: string;
	readonly provider: string;
	readonly model: string;
	readonly readinessFailure: "unknown_model" | "image_input_unsupported" | null;
	describe(input: VisionDescribeInput): Promise<VisionDescriptionResult>;
}

export type VisionUpdateSink = (fileUniqueId: string, text: string) => void;
export type VisionTelemetrySink = (telemetry: VisionTelemetry) => void;

export interface EnsureVisionOptions extends PrepareMediaImagesOptions {
	/** Called exactly after a new non-empty description is persisted; cache hits do not emit. */
	onPersist?: VisionUpdateSink;
	/** Receives bounded aggregate fields only; never identity, path, prompt, or response text. */
	onTelemetry?: VisionTelemetrySink;
	/** Shared deployment-wide provider gate; cache/local work remains outside the queue. */
	scheduler?: VisionScheduler;
}

type VisionModelRuntime = Pick<ModelRuntime, "getModel" | "completeSimple">;

function boundedNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function emptyTelemetry(kind: VisionKind, outcome: VisionOutcome, latencyMs: number): VisionTelemetry {
	return {
		kind,
		sourceBytesBucket: "unavailable",
		convertedBytesBucket: "unavailable",
		latencyMs: Math.max(0, Math.round(latencyMs)),
		inputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		cost: 0,
		outcome,
	};
}

function usageTelemetry(
	kind: VisionKind,
	sourceBytes: number,
	convertedBytes: number,
	latencyMs: number,
	outcome: VisionOutcome,
	message: AssistantMessage | undefined,
	frames: number,
): VisionTelemetry {
	return {
		kind,
		sourceBytesBucket: bytesBucket(sourceBytes, "gte_512_kib"),
		convertedBytesBucket: bytesBucket(convertedBytes, "gte_512_kib"),
		latencyMs: Math.max(0, Math.round(latencyMs)),
		inputTokens: boundedNumber(message?.usage.input),
		outputTokens: boundedNumber(message?.usage.output),
		reasoningTokens: boundedNumber(message?.usage.reasoning),
		cost: boundedNumber(message?.usage.cost.total),
		outcome,
		frames,
		providerCalled: true,
	};
}

/** Create a lightweight vision adapter over the already-owned Pi runtime/auth snapshot. */
export function createPiVisionExecutor(runtime: VisionModelRuntime, modelRef: string): VisionExecutor {
	const selection = parsePiModelReference(modelRef);
	if (!selection) {
		throw new Error("invalid media.vision_model; expected provider/model:effort");
	}
	const model = runtime.getModel(selection.provider, selection.model);
	const readinessFailure = !model ? "unknown_model" : !model.input.includes("image") ? "image_input_unsupported" : null;

	return {
		modelRef: selection.canonical,
		provider: selection.provider,
		model: selection.model,
		readinessFailure,
		async describe(input): Promise<VisionDescriptionResult> {
			const startedAt = performance.now();
			const sourceBytes = input.sourceBytes;
			// Images arrive already converted/resized by prepareMediaImages; only encode them here.
			const convertedBytes = input.images.reduce((total, image) => total + image.bytes.byteLength, 0);
			const images = input.images.map((image) => ({
				data: Buffer.from(image.bytes).toString("base64"),
				mimeType: image.mimeType,
				...(image.position == null ? {} : { position: image.position }),
			}));

			const prompt =
				input.kind === "video"
					? input.videoSticker
						? VIDEO_STICKER_PROMPT
						: VIDEO_PROMPT
					: input.kind === "sticker"
						? STICKER_PROMPT
						: PHOTO_PROMPT;
			const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
				{ type: "text", text: prompt },
			];
			for (let index = 0; index < images.length; index++) {
				const image = images[index]!;
				if (input.kind === "video") {
					const percent = Math.round((image.position ?? 0) * 100);
					content.push({ type: "text", text: `Frame ${index + 1}/${images.length} · ${percent}%` });
				}
				content.push({ type: "image", data: image.data, mimeType: image.mimeType });
			}

			const context: Context = {
				messages: [
					{
						role: "user",
						content,
						timestamp: Date.now(),
					},
				],
			};
			const telemetry = (outcome: VisionOutcome, message?: AssistantMessage): VisionTelemetry =>
				usageTelemetry(
					input.kind,
					sourceBytes,
					convertedBytes,
					performance.now() - startedAt,
					outcome,
					message,
					input.images.length,
				);
			let message: AssistantMessage;
			try {
				// Single timeout layer: the SDK enforces VISION_TIMEOUT_MS inside completeSimple.
				message = await runtime.completeSimple(model!, context, {
					cacheRetention: "none",
					maxTokens: VISION_MAX_OUTPUT_TOKENS,
					maxRetries: 0,
					reasoning: selection.thinkingLevel,
					timeoutMs: VISION_TIMEOUT_MS,
				});
			} catch (error) {
				return { text: null, telemetry: telemetry(classifyPiProviderFailure(error)) };
			}

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				const category = classifyPiProviderFailure(new Error(message.errorMessage ?? message.stopReason));
				return { text: null, telemetry: telemetry(category, message) };
			}

			const text = contentText(message.content).trim();
			return { text: text || null, telemetry: telemetry(text ? "ok" : "empty_response", message) };
		},
	};
}

/** Fail startup with a fixed category before Telegram if the selected task model cannot see images. */
export function assertPiVisionExecutorReady(executor: VisionExecutor): void {
	if (executor.readinessFailure) {
		throw new PiModelConfigurationError(executor.readinessFailure, executor.provider, executor.model);
	}
}

const inFlightByDb = new WeakMap<Database, Map<string, Promise<string | null>>>();

/** Ensure a terminal vision result exists; same-identity calls share one provider request. */
export function ensureVision(
	db: Database,
	api: BotApi,
	botId: string,
	fileUniqueId: string,
	executor: VisionExecutor,
	options: EnsureVisionOptions,
): Promise<string | null> {
	return dedupeInFlight(inFlightByDb, db, fileUniqueId, () =>
		ensureVisionInner(db, api, botId, fileUniqueId, executor, options),
	);
}

function emitTelemetry(options: EnsureVisionOptions, telemetry: VisionTelemetry): void {
	try {
		options.onTelemetry?.(telemetry);
	} catch {
		log.error("vision", "telemetry_sink_failed", { category: "observer_failed" });
	}
}

async function ensureVisionInner(
	db: Database,
	api: BotApi,
	botId: string,
	fileUniqueId: string,
	executor: VisionExecutor,
	options: EnsureVisionOptions,
): Promise<string | null> {
	const startedAt = performance.now();
	const media = db.query("SELECT kind, mime, vision FROM media WHERE file_unique_id = ?").get(fileUniqueId) as {
		kind: string;
		mime: string | null;
		vision: string | null;
	} | null;
	if (!media || !isVisionMedia(media.kind, media.mime)) return null;
	const video = isVideoMedia(media.kind, media.mime);
	const kind: VisionKind = video ? "video" : (media.kind as "photo" | "sticker");
	if (media.vision) {
		const cached = JSON.parse(media.vision) as { text?: string | null };
		return cached.text?.trim() || null;
	}
	if (video) {
		if (!options.videoTranscoder.ffmpeg || !options.videoTranscoder.ffprobe) {
			emitTelemetry(options, emptyTelemetry(kind, "video_transcoder_unavailable", performance.now() - startedAt));
			return null;
		}
		if (options.scheduler) {
			return options.scheduler.schedule(() =>
				ensureVisionPrepared(db, api, botId, fileUniqueId, executor, options, media.kind, kind, startedAt, true),
			);
		}
	}
	return ensureVisionPrepared(db, api, botId, fileUniqueId, executor, options, media.kind, kind, startedAt, false);
}

/** Only outcomes that cannot change on retry are cached; ffmpeg/provider/transport failures retry later. */
function persistUnsupported(db: Database, fileUniqueId: string, kind: VisionKind, outcome: VisionOutcome): void {
	db.query("UPDATE media SET vision = ? WHERE file_unique_id = ?").run(
		JSON.stringify({ model: "none", kind, text: null, unsupported: true, outcome, at: Date.now() }),
		fileUniqueId,
	);
}

async function ensureVisionPrepared(
	db: Database,
	api: BotApi,
	botId: string,
	fileUniqueId: string,
	executor: VisionExecutor,
	options: EnsureVisionOptions,
	mediaKind: string,
	initialKind: VisionKind,
	startedAt: number,
	providerSlotReserved: boolean,
): Promise<string | null> {
	const prepared = await prepareMediaImages(db, api, botId, fileUniqueId, options);
	if (!prepared.ok) {
		const outcome: VisionOutcome = prepared.outcome === "aborted" ? "media_download_aborted" : prepared.outcome;
		if (outcome === "unsupported_format") persistUnsupported(db, fileUniqueId, initialKind, outcome);
		emitTelemetry(options, emptyTelemetry(initialKind, outcome, performance.now() - startedAt));
		return null;
	}
	const kind: VisionKind = prepared.kind === "video" ? "video" : initialKind;

	const describe = () =>
		executor.describe({
			kind,
			sourceBytes: prepared.sourceBytes,
			images: prepared.images,
			...(kind === "video" && mediaKind === "sticker" ? { videoSticker: true } : {}),
		});
	const result: VisionDescriptionResult =
		options.scheduler && !providerSlotReserved ? await options.scheduler.schedule(describe) : await describe();
	const text = result.text?.trim() || null;
	if (text) {
		db.query("UPDATE media SET vision = ? WHERE file_unique_id = ?").run(
			JSON.stringify({ model: executor.modelRef, kind, text, outcome: result.telemetry.outcome, at: Date.now() }),
			fileUniqueId,
		);
		appendMediaUpdateEvents(db, fileUniqueId, text);
	}
	emitTelemetry(options, result.telemetry);
	if (text && options.onPersist) {
		try {
			options.onPersist(fileUniqueId, text);
		} catch {
			// Persistence is authoritative; observer failures cannot retry provider work.
			log.error("vision", "update_sink_failed", { category: "observer_failed" });
		}
	}
	return text;
}
