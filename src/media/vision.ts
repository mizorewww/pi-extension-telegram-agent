// One cached description per Telegram media identity, shared across the deployment.
import type { Database } from "../db/db.ts";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { contentText, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import type { BotApi } from "../telegram/api.ts";
import type { BotConfig } from "../config.ts";
import { classifyPiProviderFailure, type PiProviderFailureCategory } from "../agent/model-runtime.ts";
import { appendMediaUpdateEvents } from "../db/message-events.ts";
import { dedupeInFlight, isVideoMedia, isVisionMedia } from "./local-cache.ts";
import {
	prepareMediaImages,
	type PreparedImage,
	type PrepareMediaImagesFailure,
	type PrepareMediaImagesOptions,
} from "./prepare-images.ts";
import type { VisionScheduler } from "./vision-scheduler.ts";

const PHOTO_PROMPT = `你在帮一个群聊 bot 理解图片。简短描述：实际可见内容、重要文字/OCR（尤其是界面和报错）、人物或物体、对聊天可能有用的信息、不确定的地方。2-3 句话以内，用中文，直接给描述不要客套。`;

const STICKER_PROMPT = `你在帮一个群聊 bot 理解一张 sticker（聊天表情贴图）。把它理解为一种聊天表达，输出短描述：communicative intent（想表达什么）、emotion、intensity、gesture/画面要点、可见文字。一两句话，用中文，例如"得意的赞同，smug/amused，中等强度"。直接给描述不要客套。`;

const VIDEO_PROMPT = `你在帮一个群聊 bot 理解一段视频。下面是按时间顺序抽取的代表帧。综合描述动作或变化、人物与物体、重要文字/OCR、对聊天有用的信息和不确定处。2-3 句话以内，用中文，直接给描述不要客套；不要把单帧猜测说成确定的完整情节。`;

const VIDEO_STICKER_PROMPT = `你在帮一个群聊 bot 理解一个 video sticker。下面是按时间顺序抽取的代表帧。把它理解为聊天表达，概括动作变化、communicative intent、emotion、intensity、gesture/画面要点和可见文字。一两句话，用中文，直接给描述不要客套。`;

export const VISION_TIMEOUT_MS = 90_000;
export const VISION_MAX_OUTPUT_TOKENS = 256;
export type VisionKind = "photo" | "sticker" | "video";
export type VisionOutcome =
	| "ok"
	| "empty_response"
	| "media_download_aborted"
	| Exclude<PrepareMediaImagesFailure, "aborted">
	| PiProviderFailureCategory;
export interface VisionDescribeInput {
	kind: VisionKind;
	images: PreparedImage[];
	videoSticker?: boolean;
}
export interface VisionExecutor {
	/** `provider/model` that writes descriptions now; recorded with each cached one. */
	model(): string;
	describe(input: VisionDescribeInput): Promise<{ text: string | null; outcome: VisionOutcome }>;
}
export interface EnsureVisionOptions extends PrepareMediaImagesOptions {
	scheduler?: VisionScheduler;
}

/** Describes media with the bot's current chat model, which hybrid mode requires to accept images. */
export function createPiVisionExecutor(
	runtime: Pick<ModelRuntime, "getModel" | "completeSimple">,
	bot: Pick<BotConfig, "provider" | "model" | "reasoningEffort">,
): VisionExecutor {
	return {
		model: () => `${bot.provider}/${bot.model}`,
		async describe(input) {
			const model = runtime.getModel(bot.provider, bot.model)!;
			const effort = bot.reasoningEffort;
			const prompt =
				input.kind === "video"
					? input.videoSticker
						? VIDEO_STICKER_PROMPT
						: VIDEO_PROMPT
					: input.kind === "sticker"
						? STICKER_PROMPT
						: PHOTO_PROMPT;
			const content: (ImageContent | TextContent)[] = [{ type: "text", text: prompt }];
			for (const [index, image] of input.images.entries()) {
				if (input.kind === "video")
					content.push({
						type: "text",
						text: `Frame ${index + 1}/${input.images.length} · ${Math.round((image.position ?? 0) * 100)}%`,
					});
				content.push({ type: "image", data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType });
			}
			const signal = AbortSignal.timeout(VISION_TIMEOUT_MS);
			try {
				const message = await awaitWithContext(
					runtime.completeSimple(
						model,
						{ messages: [{ role: "user", content, timestamp: Date.now() }] },
						{
							cacheRetention: "none",
							maxTokens: VISION_MAX_OUTPUT_TOKENS,
							maxRetries: 0,
							reasoning: effort === "off" ? undefined : effort,
							timeoutMs: VISION_TIMEOUT_MS,
							signal,
						},
					),
					withAbortSignal(signal, BACKGROUND_CONTEXT),
				);
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					return {
						text: null,
						outcome: classifyPiProviderFailure(new Error(message.errorMessage ?? message.stopReason)),
					};
				}
				const text = contentText(message.content).trim() || null;
				return { text, outcome: text ? "ok" : "empty_response" };
			} catch (error) {
				return { text: null, outcome: classifyPiProviderFailure(error) };
			}
		},
	};
}

const inFlight = new Map<string, Promise<string | null>>();
export function ensureVision(
	db: Database,
	api: BotApi,
	fileUniqueId: string,
	executor: VisionExecutor,
	options: EnsureVisionOptions,
): Promise<string | null> {
	return dedupeInFlight(inFlight, fileUniqueId, async () => {
		const media = db.prepare("SELECT kind, mime, vision FROM media WHERE file_unique_id = ?").get(fileUniqueId) as
			| { kind: string; mime: string | null; vision: string | null }
			| undefined;
		if (!media || !isVisionMedia(media.kind, media.mime)) return null;
		if (media.vision) return (JSON.parse(media.vision) as { text: string | null }).text;
		const kind: VisionKind = isVideoMedia(media.kind, media.mime)
			? "video"
			: media.kind === "sticker"
				? "sticker"
				: "photo";
		const run = async () => {
			const prepared = await prepareMediaImages(db, api, fileUniqueId, options);
			const result = prepared.ok
				? await executor.describe({
						kind,
						images: prepared.images,
						videoSticker: kind === "video" && media.kind === "sticker",
					})
				: {
						text: null,
						outcome: prepared.outcome === "aborted" ? ("media_download_aborted" as const) : prepared.outcome,
					};
			if (result.text || result.outcome === "unsupported_format") {
				db.prepare("UPDATE media SET vision = ? WHERE file_unique_id = ?").run(
					JSON.stringify({
						model: executor.model(),
						kind,
						text: result.text,
						outcome: result.outcome,
						at: Date.now(),
					}),
					fileUniqueId,
				);
				if (result.text) appendMediaUpdateEvents(db, fileUniqueId, result.text);
			}
			return result.text;
		};
		return options.scheduler ? options.scheduler.schedule(run) : run();
	});
}
