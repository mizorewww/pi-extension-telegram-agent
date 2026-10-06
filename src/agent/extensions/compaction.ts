import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	estimateTokens,
	serializeConversation,
	sessionEntryToContextMessages,
	type CompactionResult,
	type InlineExtension,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { CONTEXT_IMAGE_TOKEN_ESTIMATE } from "../token-packer.ts";
import {
	isTelegramContextDetails,
	projectTelegramContext,
	TELEGRAM_CONTEXT_TYPE,
	type TelegramContextImageResolver,
} from "./context.ts";

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
		if (message.role === "user" && Array.isArray(message.content) && message.content.some((b) => b.type === "image")) {
			text("[User]: ");
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
	if (entry.type !== "custom_message" || entry.customType !== TELEGRAM_CONTEXT_TYPE) return 0;
	if (!isTelegramContextDetails(entry.details)) return 0;
	let count = 0;
	for (const block of entry.details.blocks) if (block.type === "image") count++;
	return count;
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
		chargedTokens += entryTokens + entryImages * CONTEXT_IMAGE_TOKEN_ESTIMATE;
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
