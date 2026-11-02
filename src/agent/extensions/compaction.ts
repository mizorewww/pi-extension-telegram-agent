import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	contentText,
	retryAssistantCall,
	type Api,
	type ImageContent,
	type Model,
	type TextContent,
} from "@earendil-works/pi-ai";
import {
	convertToLlm,
	resizeImage,
	type ModelRuntime,
	estimateTokens,
	serializeConversation,
	sessionEntryToContextMessages,
	type CompactionResult,
	type InlineExtension,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createImageRefResolver } from "../../media/prepare-images.ts";
import { log } from "../../observability/log.ts";
import type { PiRequestThinkingLevel } from "../model-ref.ts";
import { COMPACTION_SUMMARY_PROMPT } from "../prompt.ts";
import { guardProviderCall, providerRetryPolicy } from "../provider-guard.ts";
import { CONTEXT_IMAGE_TOKEN_ESTIMATE, estimateProviderTokensUpperBound } from "../token-packer.ts";
import { entryImageRefs, projectTelegramContext, type TelegramContextImageResolver, viewImageRefs } from "./context.ts";

type SessionBeforeCompactResult = { cancel?: boolean; compaction?: CompactionResult };

export function serializeCompactionMessages(messages: AgentMessage[]): string {
	return serializeConversation(convertToLlm(withoutThinking(messages)));
}

/** The bot's private reasoning is speculation; a summary must only record what the group said. */
function withoutThinking(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((message) =>
		message.role === "assistant"
			? { ...message, content: message.content.filter((block) => block.type !== "thinking") }
			: message,
	);
}

/** Preserve image/text order inside the transcript, without the ephemeral sticker catalog. */
export function buildCompactionContent(
	messages: AgentMessage[],
	previousSummary?: string,
	resolveImage?: TelegramContextImageResolver,
): string | (TextContent | ImageContent)[] {
	const ending =
		`\n</conversation>\n\n` +
		(previousSummary
			? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n把上面的旧摘要与新内容合并成一份更新的摘要。`
			: "请输出摘要。");
	if (!resolveImage) return `<conversation>\n${serializeCompactionMessages(messages)}${ending}`;
	const projected = convertToLlm(projectTelegramContext(withoutThinking(messages), resolveImage, false));
	const content: (TextContent | ImageContent)[] = [];
	const text = (value: string) => {
		const last = content.at(-1);
		if (last?.type === "text") last.text += value;
		else content.push({ type: "text", text: value });
	};
	text("<conversation>\n");
	for (const message of projected) {
		const withImages =
			(message.role === "user" || message.role === "toolResult") &&
			Array.isArray(message.content) &&
			message.content.some((b) => b.type === "image");
		if (withImages && Array.isArray(message.content)) {
			text(message.role === "user" ? "[User]: " : "[Viewed image]: ");
			for (const block of message.content) {
				if (block.type === "text") text(block.text);
				else if (block.type === "image") content.push(block);
			}
		} else text(serializeConversation([message]));
		text("\n\n");
	}
	text(ending);
	return content;
}

function contextImageCount(entry: SessionEntry): number {
	return entryImageRefs(entry).length;
}

/**
 * Encrypted reasoning signatures ride along on every assistant replay (the provider verifies
 * and continues the chain), but Pi's estimateTokens only counts `thinking` text. Charge the
 * signature bytes at the wire ratio so kept-entry budgets reflect the real provider cost.
 */
function contextSignatureTokens(entry: SessionEntry): number {
	if (entry.type !== "message") return 0;
	const message = entry.message;
	if (message.role !== "assistant" || !Array.isArray(message.content)) return 0;
	let bytes = 0;
	for (const block of message.content)
		if (block.type === "thinking" && typeof block.thinkingSignature === "string")
			bytes += block.thinkingSignature.length;
	return Math.ceil(bytes / 4);
}

/** Pi's own retained-window boundary: the previous compaction's kept start, else the branch start. */
function compactionBoundaryStart(entries: readonly SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "compaction") continue;
		const kept = entries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
		return kept >= 0 ? kept : index + 1;
	}
	return 0;
}

/**
 * Translate the image-inclusive retention budget into Pi's text-only units BEFORE Pi
 * prepares compaction. A before-compact handler is too late: Pi returns early if the
 * text fits, without ever emitting that event. Pi still owns valid cuts and split turns.
 */
export function compactionTextBudget(entries: readonly SessionEntry[], keepRecentTokens: number): number {
	const boundaryStart = compactionBoundaryStart(entries);
	let piTokens = 0;
	let chargedTokens = 0;
	let images = 0;
	for (let index = entries.length - 1; index >= boundaryStart && chargedTokens < keepRecentTokens; index--) {
		const entry = entries[index]!;
		const entryImages = contextImageCount(entry);
		const entryTokens = sessionEntryToContextMessages(entry).reduce((sum, message) => sum + estimateTokens(message), 0);
		piTokens += entryTokens;
		images += entryImages;
		chargedTokens += entryTokens + entryImages * CONTEXT_IMAGE_TOKEN_ESTIMATE + contextSignatureTokens(entry);
	}
	return images > 0 && chargedTokens >= keepRecentTokens
		? Math.min(keepRecentTokens, Math.max(1, piTokens))
		: keepRecentTokens;
}

export function makeTelegramCompactionExtension(
	handle: (event: SessionBeforeCompactEvent) => Promise<SessionBeforeCompactResult>,
): InlineExtension {
	return {
		name: "tg-compaction",
		hidden: true,
		factory: (pi) => {
			pi.on("session_before_compact", handle);
		},
	};
}

export interface CompactionSummaryOptions {
	botId: string;
	model: Model<Api>;
	reasoning: PiRequestThinkingLevel;
	modelRuntime: Pick<ModelRuntime, "streamSimple">;
	mediaDir: string;
	imageBudgetBytes: number;
	timeoutMs: number;
	retries: number;
	onUsage: (usage: Awaited<ReturnType<ModelRuntime["completeSimple"]>>["usage"]) => void;
}

type SummaryUsage = Awaited<ReturnType<ModelRuntime["completeSimple"]>>["usage"];
type SummaryResult = { summary: string; usage: SummaryUsage } | { failure: string };

/** Same accounting the window check uses: text at bytes/2 plus the flat per-image charge. */
function compactionContentTokens(content: string | (TextContent | ImageContent)[]): number {
	if (typeof content === "string") return estimateProviderTokensUpperBound(content);
	let tokens = 0;
	for (const block of content)
		tokens += block.type === "text" ? estimateProviderTokensUpperBound(block.text) : CONTEXT_IMAGE_TOKEN_ESTIMATE;
	return tokens;
}

function compactionContentText(content: string | (TextContent | ImageContent)[]): string {
	return typeof content === "string"
		? content
		: content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
}

function compactionContentImages(content: string | (TextContent | ImageContent)[]): number {
	return typeof content === "string" ? 0 : content.filter((block) => block.type === "image").length;
}

/** One transcript slice per call, sized so the merged summary always fits the window. */
function packSummaryChunks(messages: readonly AgentMessage[], budgetTokens: number): AgentMessage[][] {
	const chunks: AgentMessage[][] = [];
	let current: AgentMessage[] = [];
	let used = 0;
	for (const message of messages) {
		const cost =
			estimateProviderTokensUpperBound(serializeCompactionMessages([message])) +
			(viewImageRefs(message)?.images.length ?? 0) * CONTEXT_IMAGE_TOKEN_ESTIMATE;
		if (current.length > 0 && used + cost > budgetTokens) {
			chunks.push(current);
			current = [];
			used = 0;
		}
		current.push(message);
		used += cost;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/** Last resort for a single message bigger than a whole chunk: cut the transcript body,
 * keep head + tail + the closing instruction so the model still sees task shape. */
function truncateTranscriptForSummary(text: string, budgetTokens: number): string {
	if (estimateProviderTokensUpperBound(text) <= budgetTokens) return text;
	const boundary = text.lastIndexOf("</conversation>");
	const body = boundary >= 0 ? text.slice(0, boundary) : text;
	const tail = boundary >= 0 ? text.slice(boundary) : "";
	const budget = Math.max(0, budgetTokens - estimateProviderTokensUpperBound(tail));
	const points = [...body];
	const marker = `\n[truncated original_chars=${points.length}]\n`;
	let low = 0;
	let high = points.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const headCount = Math.ceil(mid / 2);
		const candidate = `${points.slice(0, headCount).join("")}${marker}${mid > headCount ? points.slice(-(mid - headCount)).join("") : ""}`;
		if (estimateProviderTokensUpperBound(candidate) <= budget) low = mid;
		else high = mid - 1;
	}
	const headCount = Math.ceil(low / 2);
	return `${points.slice(0, headCount).join("")}${marker}${low > headCount ? points.slice(-(low - headCount)).join("") : ""}${tail}`;
}

/** The configured summary model shares the native retry policy and request watchdog. */
export async function generateCompactionSummary(
	prep: SessionBeforeCompactEvent["preparation"],
	signal: AbortSignal,
	options: CompactionSummaryOptions,
): Promise<SummaryResult> {
	const { model } = options;
	const messages = [...prep.messagesToSummarize, ...prep.turnPrefixMessages];
	const imageReferences = messages.reduce((count, message) => count + (viewImageRefs(message)?.images.length ?? 0), 0);
	const resolveImage = model.input.includes("image") ? createImageRefResolver(options.mediaDir) : undefined;
	const maxTokens = Math.min(4096, model.maxTokens);
	// The estimate must leave room for the merged summary output plus a safety margin.
	const inputBudget = model.contextWindow - maxTokens - 2048;
	const promptTokens = estimateProviderTokensUpperBound(COMPACTION_SUMMARY_PROMPT);

	const runSummary = async (
		content: string | (TextContent | ImageContent)[],
		imagesAttached: number,
		extra: Record<string, unknown> = {},
	): Promise<SummaryResult> => {
		const inputTokens = promptTokens + compactionContentTokens(content);
		log.info("agent_runtime", "compaction_input", {
			bot_id: options.botId,
			vision_supported: model.input.includes("image"),
			images_attached: imagesAttached,
			images_unavailable: imageReferences - imagesAttached,
			input_tokens_estimated: inputTokens,
			...extra,
		});
		if (inputTokens > inputBudget) {
			log.warn("agent_runtime", "compaction_input_rejected", {
				bot_id: options.botId,
				category: "model_window_exceeded",
				...extra,
			});
			return { failure: "summary input exceeds model window" };
		}
		// Recovery must not send the same oversized image payload to the summary model.
		// Resize only this uncached summary request; stored files and chat prefixes stay intact.
		if (Array.isArray(content)) {
			const images = content.filter((block) => block.type === "image");
			const imageBytes = images.reduce((sum, image) => sum + Buffer.from(image.data, "base64").length, 0);
			if (imageBytes > options.imageBudgetBytes) {
				const maxBytes = Math.floor(options.imageBudgetBytes / images.length);
				const resized = new Map<string, Awaited<ReturnType<typeof resizeImage>>>();
				for (const image of images) {
					signal.throwIfAborted();
					const bytes = Buffer.from(image.data, "base64");
					if (bytes.length <= maxBytes) continue;
					const key = `${image.mimeType}:${image.data}`;
					if (!resized.has(key))
						resized.set(
							key,
							maxBytes > 0
								? await resizeImage(bytes, image.mimeType, { maxBytes: Math.floor(maxBytes / 3) * 4 })
								: null,
						);
					const result = resized.get(key);
					if (!result || Buffer.from(result.data, "base64").length > maxBytes) {
						log.warn("agent_runtime", "compaction_input_rejected", {
							bot_id: options.botId,
							category: "image_budget_exceeded",
							...extra,
						});
						return { failure: "summary images exceed transport budget" };
					}
					image.data = result.data;
					image.mimeType = result.mimeType;
				}
			}
		}
		const request = {
			systemPrompt: COMPACTION_SUMMARY_PROMPT,
			messages: [{ role: "user" as const, content, timestamp: Date.now() }],
		};
		const result = await retryAssistantCall(
			async () => {
				const response = await guardProviderCall(
					(attemptSignal) =>
						options.modelRuntime.streamSimple(model, request, {
							cacheRetention: "none",
							maxTokens,
							reasoning: options.reasoning,
							signal: attemptSignal,
							timeoutMs: options.timeoutMs,
							maxRetries: 0,
						}),
					model,
					signal,
					{ timeoutMs: options.timeoutMs },
				).result();
				try {
					options.onUsage(response.usage);
				} catch {
					log.warn("agent_runtime", "compaction_usage_failed", { bot_id: options.botId, category: "local_failure" });
				}
				return response;
			},
			providerRetryPolicy(options.retries),
			signal,
			{
				onRetryScheduled: (attempt, _maxAttempts, delayMs) =>
					log.warn("agent_runtime", "provider_retry_scheduled", {
						bot_id: options.botId,
						scope: "compaction",
						attempt,
						delay_ms: delayMs,
					}),
			},
		);
		if (result.stopReason === "error" || result.stopReason === "aborted") {
			return { failure: `summary generation ${result.stopReason}` };
		}
		const summary = contentText(result.content);
		if (!summary.trim()) return { failure: "empty summary" };
		return { summary, usage: result.usage };
	};

	const fullContent = buildCompactionContent(messages, prep.previousSummary, resolveImage);
	if (promptTokens + compactionContentTokens(fullContent) <= inputBudget) {
		return runSummary(fullContent, compactionContentImages(fullContent));
	}

	// Oversized transcript: summarize window-sized slices, each merged into the running
	// summary — a wedged session can always be recovered in place, never rejected outright.
	const rollingReserve = estimateProviderTokensUpperBound(prep.previousSummary ?? "") + 4_096;
	const chunks = packSummaryChunks(messages, Math.max(8_192, inputBudget - promptTokens - rollingReserve));
	log.info("agent_runtime", "compaction_chunked", {
		bot_id: options.botId,
		chunks: chunks.length,
		input_tokens_estimated: promptTokens + compactionContentTokens(fullContent),
	});
	let rolling = prep.previousSummary;
	let usage: SummaryUsage | undefined;
	for (const [index, chunk] of chunks.entries()) {
		signal.throwIfAborted();
		const extra = { chunk: `${index + 1}/${chunks.length}` };
		let content = buildCompactionContent(chunk, rolling, resolveImage);
		if (promptTokens + compactionContentTokens(content) > inputBudget) {
			// Degrade vision first: a text-only transcript still fits the same summarizer.
			content = buildCompactionContent(chunk, rolling, undefined);
		}
		if (promptTokens + compactionContentTokens(content) > inputBudget) {
			content = truncateTranscriptForSummary(compactionContentText(content), inputBudget - promptTokens);
		}
		const result = await runSummary(content, compactionContentImages(content), extra);
		if ("failure" in result) return result;
		rolling = result.summary;
		usage = result.usage;
	}
	return rolling === undefined || !rolling.trim() ? { failure: "empty summary" } : { summary: rolling, usage: usage! };
}
