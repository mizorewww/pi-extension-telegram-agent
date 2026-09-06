import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { InlineExtension, SessionEntry } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { join } from "node:path";
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

/** File bytes per image occurrence in the active Pi context, before base64 encoding. */
export function contextImageBytes(entries: readonly SessionEntry[], mediaDir: string): number {
	let bytes = 0;
	for (const entry of entries) {
		if (
			entry.type !== "custom_message" ||
			entry.customType !== TELEGRAM_CONTEXT_TYPE ||
			!isTelegramContextDetails(entry.details)
		)
			continue;
		for (const block of entry.details.blocks) {
			if (block.type !== "image") continue;
			try {
				bytes += statSync(join(mediaDir, block.name)).size;
			} catch {
				/* Missing files are also omitted by the provider projection. */
			}
		}
	}
	return bytes;
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
): AgentMessage[] {
	const lastTelegramContext = messages.findLastIndex(
		(message) => message.role === "custom" && message.customType === TELEGRAM_CONTEXT_TYPE,
	);
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
		if (images.length === 0 || !resolveImage) {
			// Text-only projection keeps the historical exact-string bytes.
			const text = candidates ? `${message.details.providerText}\n\n${candidates}` : message.details.providerText;
			return { ...message, content: text };
		}
		const content: ({ type: "text"; text: string } | ImageContent)[] = [];
		for (const block of message.details.blocks) {
			if (block.type === "text") {
				content.push({ type: "text", text: block.text });
				continue;
			}
			const resolved = resolveImage({ name: block.name, mime: block.mime });
			if (resolved) content.push(resolved);
		}
		if (candidates) {
			const last = content.at(-1);
			if (last?.type === "text") last.text += `\n\n${candidates}`;
			else content.push({ type: "text", text: candidates });
		}
		return { ...message, content };
	});
}

export function makeTelegramContextExtension(resolveImage?: TelegramContextImageResolver): InlineExtension {
	return {
		name: "tg-context",
		hidden: true,
		factory: (pi) => {
			pi.on("context", (event) => ({ messages: projectTelegramContext(event.messages, resolveImage) }));
		},
	};
}
