import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { InlineExtension, SessionEntry } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { ContextMediaImage } from "../../media/context-media.ts";
import { SEND_NO_RETRY_ACK, SEND_SUCCESS_ACK } from "../tools.ts";

export const TELEGRAM_CONTEXT_TYPE = "telegram_context_v2";
export const TELEGRAM_CONTEXT_VERSION = 6;

/** A batch's structured identity; its rendered text is the custom message content itself. */
export interface TelegramContextDetails {
	version: typeof TELEGRAM_CONTEXT_VERSION;
	consumedSeq: number;
	stickerCandidates: string;
	visibleMessageIds: number[];
}

/** A prepared image file referenced by cache-relative basename; bytes join only at projection. */
function isImageRef(value: unknown): value is ContextMediaImage {
	const image = value as { name?: unknown; mime?: unknown } | null;
	return (
		typeof image?.name === "string" &&
		image.name.length > 0 &&
		!image.name.includes("/") &&
		!image.name.includes("\0") &&
		typeof image.mime === "string"
	);
}

export function isTelegramContextDetails(value: unknown): value is TelegramContextDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<TelegramContextDetails>;
	return (
		details.version === TELEGRAM_CONTEXT_VERSION &&
		Number.isSafeInteger(details.consumedSeq) &&
		(details.consumedSeq as number) >= 0 &&
		typeof details.stickerCandidates === "string" &&
		Array.isArray(details.visibleMessageIds) &&
		details.visibleMessageIds.every((id) => Number.isSafeInteger(id) && id > 0)
	);
}

const VIEW_IMAGE_TOOL = "view_image";

/** Persisted view_image result details: image references only, never bytes. */
export interface ViewImageDetails {
	messageId: number;
	images: ContextMediaImage[];
}

function isViewImageDetails(value: unknown): value is ViewImageDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<ViewImageDetails>;
	return Number.isSafeInteger(details.messageId) && Array.isArray(details.images) && details.images.every(isImageRef);
}

/** Image refs of a successful view_image tool result message, else null. */
export function viewImageRefs(message: AgentMessage): ViewImageDetails | null {
	if (message.role !== "toolResult" || message.toolName !== VIEW_IMAGE_TOOL || message.isError) return null;
	return isViewImageDetails(message.details) ? message.details : null;
}

/** Image refs carried by one session entry: only view_image results hold images. */
export function entryImageRefs(entry: SessionEntry): readonly ContextMediaImage[] {
	return entry.type === "message" ? (viewImageRefs(entry.message)?.images ?? []) : [];
}

/** File bytes per image occurrence in the active Pi context, before base64 encoding. */
export function contextImageBytes(entries: readonly SessionEntry[], mediaDir: string): number {
	let bytes = 0;
	for (const ref of entries.flatMap((entry) => entryImageRefs(entry))) {
		try {
			bytes += statSync(join(mediaDir, ref.name)).size;
		} catch {
			/* Missing files are also omitted by the provider projection. */
		}
	}
	return bytes;
}

/** Resolve one image reference to a provider block; null drops it (pruned/missing file). */
export type TelegramContextImageResolver = (ref: { name: string; mime: string }) => ImageContent | null;

/** Projection-only message carrying the sticker candidate block; never persisted. */
const TELEGRAM_STICKER_CANDIDATES_TYPE = "telegram_sticker_candidates";

/**
 * Project persisted entries for the provider. Restored sessions recover message identities from
 * structured details, never by parsing the rendered Telegram grammar in the content.
 *
 * Each batch's sticker note rides its own message right after that batch: glued to the chat text
 * it read as if the last speaker had pasted it, and keeping every note in place makes each
 * request a strict prefix of the next one.
 */
export function projectTelegramContext(
	messages: AgentMessage[],
	resolveImage?: TelegramContextImageResolver,
	includeStickerCandidates = true,
): AgentMessage[] {
	return messages.flatMap((message): AgentMessage[] => {
		const viewed = resolveImage ? viewImageRefs(message) : null;
		if (viewed && message.role === "toolResult") {
			const images = viewed.images.flatMap((ref) => resolveImage!(ref) ?? []);
			return [{ ...message, content: [...message.content, ...images] }];
		}
		if (message.role === "toolResult" && message.toolName === "send") {
			const details = message.details as { sent?: unknown; outcome?: unknown } | undefined;
			const sent = Array.isArray(details?.sent)
				? details.sent.filter((id): id is number => Number.isSafeInteger(id) && (id as number) > 0)
				: [];
			if (sent.length > 0) {
				const ack = details?.outcome ? SEND_NO_RETRY_ACK : SEND_SUCCESS_ACK;
				return [
					{
						...message,
						content: [{ type: "text", text: `${ack} sent_message_ids=${sent.map((id) => `#${id}`).join(",")}` }],
					},
				];
			}
		}
		if (message.role !== "custom" || message.customType !== TELEGRAM_CONTEXT_TYPE) return [message];
		if (!isTelegramContextDetails(message.details)) return [message];
		const candidates = includeStickerCandidates ? message.details.stickerCandidates.trim() : "";
		if (!candidates) return [message];
		return [
			message,
			{
				role: "custom",
				customType: TELEGRAM_STICKER_CANDIDATES_TYPE,
				content: candidates,
				display: false,
				timestamp: message.timestamp,
			},
		];
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
