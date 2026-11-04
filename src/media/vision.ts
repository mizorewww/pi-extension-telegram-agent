// One cached description per Telegram media identity, shared across the deployment.
import type { Database } from "../db/db.ts";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { contentText, type AssistantMessage, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import type { BotApi } from "../telegram/api.ts";
import { parsePiModelReference } from "../agent/model-ref.ts";
import {
	classifyPiProviderFailure,
	PiModelConfigurationError,
	type PiProviderFailureCategory,
} from "../agent/model-runtime.ts";
import { appendMediaUpdateEvents } from "../db/message-events.ts";
import { log } from "../observability/log.ts";
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
export interface VisionTelemetry {
	kind: VisionKind;
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
export interface VisionDescribeInput {
	kind: VisionKind;
	images: PreparedImage[];
	videoSticker?: boolean;
}
export interface VisionExecutor {
	readonly modelRef: string;
	readonly provider: string;
	readonly model: string;
	readonly readinessFailure: "unknown_model" | "image_input_unsupported" | null;
	describe(input: VisionDescribeInput): Promise<VisionDescriptionResult>;
}
export interface EnsureVisionOptions extends PrepareMediaImagesOptions {
	onTelemetry?: (telemetry: VisionTelemetry) => void;
	scheduler?: VisionScheduler;
}
function telemetry(
	kind: VisionKind,
	started: number,
	outcome: VisionOutcome,
	message?: AssistantMessage,
): VisionTelemetry {
	return {
		kind,
		latencyMs: Math.round(performance.now() - started),
		outcome,
		inputTokens: message?.usage.input ?? 0,
		outputTokens: message?.usage.output ?? 0,
		reasoningTokens: message?.usage.reasoning ?? 0,
		cost: message?.usage.cost.total ?? 0,
	};
}
export function createPiVisionExecutor(
	runtime: Pick<ModelRuntime, "getModel" | "completeSimple">,
	modelRef: string,
): VisionExecutor {
	const selection = parsePiModelReference(modelRef);
	if (!selection) throw new Error("invalid media.vision_model; expected provider/model:effort");
	const model = runtime.getModel(selection.provider, selection.model);
	return {
		modelRef: selection.canonical,
		provider: selection.provider,
		model: selection.model,
		readinessFailure: !model ? "unknown_model" : !model.input.includes("image") ? "image_input_unsupported" : null,
		async describe(input) {
			const started = performance.now();
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
			let message: AssistantMessage | undefined;
			let outcome: VisionOutcome;
			let text: string | null = null;
			try {
				message = await deadline((signal) =>
					runtime.completeSimple(
						model!,
						{ messages: [{ role: "user", content, timestamp: Date.now() }] },
						{
							cacheRetention: "none",
							maxTokens: VISION_MAX_OUTPUT_TOKENS,
							maxRetries: 0,
							reasoning: selection.thinkingLevel,
							timeoutMs: VISION_TIMEOUT_MS,
							signal,
						},
					),
				);
				if (message.stopReason === "error" || message.stopReason === "aborted")
					outcome = classifyPiProviderFailure(new Error(message.errorMessage ?? message.stopReason));
				else {
					text = contentText(message.content).trim() || null;
					outcome = text ? "ok" : "empty_response";
				}
			} catch (error) {
				outcome = classifyPiProviderFailure(error);
			}
			return {
				text,
				telemetry: {
					...telemetry(input.kind, started, outcome, message),
					frames: input.images.length,
					providerCalled: true,
				},
			};
		},
	};
}
export function assertPiVisionExecutorReady(executor: VisionExecutor): void {
	if (executor.readinessFailure)
		throw new PiModelConfigurationError(executor.readinessFailure, executor.provider, executor.model);
}
/** A provider that ignores its timeout still releases the shared vision slot. */
function deadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const signal = AbortSignal.timeout(VISION_TIMEOUT_MS);
	return awaitWithContext(work(signal), withAbortSignal(signal, BACKGROUND_CONTEXT));
}

const inFlight = new Map<string, Promise<string | null>>();
export function ensureVision(
	db: Database,
	api: BotApi,
	botId: string,
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
			const started = performance.now();
			const prepared = await prepareMediaImages(db, api, botId, fileUniqueId, options);
			const result = prepared.ok
				? await executor.describe({
						kind,
						images: prepared.images,
						videoSticker: kind === "video" && media.kind === "sticker",
					})
				: {
						text: null,
						telemetry: telemetry(
							kind,
							started,
							prepared.outcome === "aborted" ? "media_download_aborted" : prepared.outcome,
						),
					};
			if (result.text || result.telemetry.outcome === "unsupported_format") {
				db.prepare("UPDATE media SET vision = ? WHERE file_unique_id = ?").run(
					JSON.stringify({
						model: executor.modelRef,
						kind,
						text: result.text,
						outcome: result.telemetry.outcome,
						at: Date.now(),
					}),
					fileUniqueId,
				);
				if (result.text) appendMediaUpdateEvents(db, fileUniqueId, result.text);
			}
			try {
				options.onTelemetry?.(result.telemetry);
			} catch {
				log.error("vision", "telemetry_sink_failed", { category: "observer_failed" });
			}
			return result.text;
		};
		return options.scheduler ? options.scheduler.schedule(run) : run();
	});
}
