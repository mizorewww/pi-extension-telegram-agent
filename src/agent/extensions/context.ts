import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { MessageEventKind } from "../../db/message-events.ts";
import type { ContextMediaImage } from "../../media/context-media.ts";
import { SEND_NO_RETRY_ACK, SEND_SUCCESS_ACK } from "../tools.ts";

export const TELEGRAM_CONTEXT_TYPE = "telegram_context_v2";
export const TELEGRAM_CONTEXT_VERSION = 4;

export interface TelegramContextEventRef {
	ingestSeq: number;
	kind: MessageEventKind;
	chatId: number;
	messageId: number;
	fullMessageVisible: boolean;
}

/**
 * Provider-bound content block. Text blocks carry rendered Telegram grammar; image blocks
 * reference prepared files by cache-relative basename only — base64 bytes are materialized at
 * projection time and never persisted in the session, the DB, or logs.
 */
export type TelegramContextBlock = { type: "text"; text: string } | { type: "image"; name: string; mime: string };

export interface TelegramContextDetails {
	version: typeof TELEGRAM_CONTEXT_VERSION;
	consumedSeq: number;
	providerText: string;
	blocks: TelegramContextBlock[];
	stickerCandidates: string;
	visibleMessageIds: number[];
	events: TelegramContextEventRef[];
}

function isValidBlock(block: unknown): block is TelegramContextBlock {
	if (!block || typeof block !== "object") return false;
	const value = block as Partial<TelegramContextBlock>;
	if (value.type === "text") return typeof (value as { text?: unknown }).text === "string";
	if (value.type === "image") {
		const image = value as { name?: unknown; mime?: unknown };
		return (
			typeof image.name === "string" &&
			image.name.length > 0 &&
			!image.name.includes("/") &&
			!image.name.includes("\0") &&
			typeof image.mime === "string"
		);
	}
	return false;
}

export function isTelegramContextDetails(value: unknown): value is TelegramContextDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<TelegramContextDetails>;
	return (
		details.version === TELEGRAM_CONTEXT_VERSION &&
		Number.isSafeInteger(details.consumedSeq) &&
		(details.consumedSeq as number) >= 0 &&
		typeof details.providerText === "string" &&
		Array.isArray(details.blocks) &&
		details.blocks.every(isValidBlock) &&
		typeof details.stickerCandidates === "string" &&
		Array.isArray(details.visibleMessageIds) &&
		details.visibleMessageIds.every((id) => Number.isSafeInteger(id) && id > 0) &&
		Array.isArray(details.events) &&
		details.events.every(
			(event) =>
				event != null &&
				Number.isSafeInteger(event.ingestSeq) &&
				event.ingestSeq > 0 &&
				Number.isSafeInteger(event.chatId) &&
				Number.isSafeInteger(event.messageId) &&
				event.messageId > 0 &&
				typeof event.fullMessageVisible === "boolean",
		)
	);
}

/** Assemble provider-bound blocks from packed segments, merging adjacent text. */
export function buildTelegramContextBlocks(
	segments: readonly { text: string; images: readonly ContextMediaImage[] }[],
): TelegramContextBlock[] {
	const blocks: TelegramContextBlock[] = [];
	for (const segment of segments) {
		if (segment.text) {
			const last = blocks.at(-1);
			if (last?.type === "text") last.text += `\n${segment.text}`;
			else blocks.push({ type: "text", text: segment.text });
		}
		for (const image of segment.images) blocks.push({ type: "image", name: image.name, mime: image.mime });
	}
	return blocks;
}

/** Resolve one image reference to a provider block; null drops it (pruned/missing file). */
export type TelegramContextImageResolver = (ref: { name: string; mime: string }) => ImageContent | null;

/**
 * Keep the provider projection derived from extension-owned structured details. The same bytes
 * are also persisted as plain-text content for compaction/debugging, but restored sessions never
 * need to parse rendered Telegram grammar to recover message identities.
 */
export function projectTelegramContext(
	messages: AgentMessage[],
	resolveImage?: TelegramContextImageResolver,
	maxImages = 4,
): AgentMessage[] {
	const lastTelegramContext = messages.findLastIndex(
		(message) => message.role === "custom" && message.customType === TELEGRAM_CONTEXT_TYPE,
	);
	// Global per-call image budget: historical context messages keep their images only
	// while the budget lasts, newest first. Older images degrade to their text-only
	// placeholder (providerText already carries the [图片] marker), so a photo-heavy
	// group cannot balloon the provider payload into tens of MB of base64.
	const keptImages = new Map<number, number>();
	let budget = maxImages;
	for (let index = messages.length - 1; index >= 0 && budget > 0; index--) {
		const message = messages[index];
		if (message.role !== "custom" || message.customType !== TELEGRAM_CONTEXT_TYPE) continue;
		if (!isTelegramContextDetails(message.details)) continue;
		const images = message.details.blocks.filter((block) => block.type === "image");
		if (images.length === 0) continue;
		const kept = Math.min(images.length, budget);
		keptImages.set(index, kept);
		budget -= kept;
	}
	return messages.map((message, index) => {
		if (message.role === "toolResult" && message.toolName === "send") {
			const details = message.details as { sent?: unknown; outcome?: unknown } | undefined;
			const sent = Array.isArray(details?.sent)
				? details.sent.filter((id): id is number => Number.isSafeInteger(id) && (id as number) > 0)
				: [];
			if (sent.length > 0) {
				const ack = details?.outcome ? SEND_NO_RETRY_ACK : SEND_SUCCESS_ACK;
				return {
					...message,
					content: [{ type: "text", text: `${ack} sent_message_ids=${sent.map((id) => `#${id}`).join(",")}` }],
				};
			}
		}
		if (message.role !== "custom" || message.customType !== TELEGRAM_CONTEXT_TYPE) return message;
		if (!isTelegramContextDetails(message.details)) return message;
		const candidates = index === lastTelegramContext ? message.details.stickerCandidates.trim() : "";
		const images = message.details.blocks.filter((block) => block.type === "image");
		const keep = keptImages.get(index) ?? 0;
		if (images.length === 0 || !resolveImage || keep === 0) {
			// Text-only projection keeps the historical exact-string bytes.
			const text = candidates ? `${message.details.providerText}\n\n${candidates}` : message.details.providerText;
			return { ...message, content: text };
		}
		const content: ({ type: "text"; text: string } | ImageContent)[] = [];
		let attached = 0;
		for (const block of message.details.blocks) {
			if (block.type === "text") {
				content.push({ type: "text", text: block.text });
				continue;
			}
			if (attached >= keep) continue; // budget exhausted: keep the text placeholder, drop the image
			const resolved = resolveImage({ name: block.name, mime: block.mime });
			if (resolved) {
				content.push(resolved);
				attached++;
			}
		}
		if (candidates) {
			const last = content.at(-1);
			if (last?.type === "text") last.text += `\n\n${candidates}`;
			else content.push({ type: "text", text: candidates });
		}
		return { ...message, content };
	});
}

export function makeTelegramContextExtension(
	resolveImage?: TelegramContextImageResolver,
	maxImages = 4,
): InlineExtension {
	return {
		name: "tg-context",
		hidden: true,
		factory: (pi) => {
			pi.on("context", (event) => ({
				messages: projectTelegramContext(event.messages, resolveImage, maxImages),
			}));
		},
	};
}
