// Normalize a Telegram message object into our canonical message row.
// See docs/data-model.md. Grammar for LLM serialization lives elsewhere (Phase 3).

import { stickerMime } from "../media/sticker-catalog.ts";
import { normalizeRichMessage, RICH_MESSAGE_UNAVAILABLE } from "./rich-message.ts";

export interface CanonicalMessage {
	chat_id: number;
	message_id: number;
	date: number;
	thread_id: number | null;
	sender_id: number | null;
	display_name: string | null;
	username: string | null;
	sender_tag: string | null;
	sender_chat: string | null;
	is_bot: boolean;
	text: string | null;
	caption: string | null;
	entities: unknown[] | null;
	rich_message: string | null;
	/** Ephemeral normalization diagnostic; never persisted or serialized. */
	rich_truncated: boolean;
	reply_to_message_id: number | null;
	reply_to_sender_id: number | null;
	reply_snapshot: ReplySnapshot | null;
	quote: unknown | null;
	forward_origin: unknown | null;
	edit_date: number | null;
	media: MediaInfo | null;
}

/** One-hop reply content supplied by Telegram, independent of locally retained history. */
export type ReplySnapshot = Pick<CanonicalMessage, "display_name" | "username" | "text" | "media">;

export interface MediaInfo {
	kind: "photo" | "sticker" | "animation" | "video" | "video_note" | "document" | "voice" | "audio";
	file_unique_id: string;
	file_id: string;
	mime?: string;
	width?: number;
	height?: number;
	sticker_set?: string;
	sticker_emoji?: string;
}

export function normalizeMessage(msg: any, editDate: number | null = null): CanonicalMessage {
	const from = msg.from ?? null;
	const senderChat = msg.sender_chat ?? null;
	const media = extractMedia(msg);
	const rich = msg.rich_message == null ? null : normalizeRichMessage(msg.rich_message);
	// Telegram embeds only one parent. Do not recursively import a conversation as new messages.
	const parent = msg.reply_to_message
		? normalizeMessage({ ...msg.reply_to_message, chat: msg.chat, reply_to_message: undefined })
		: null;
	return {
		chat_id: msg.chat.id,
		message_id: msg.message_id,
		date: msg.date,
		thread_id: msg.message_thread_id ?? null,
		sender_id: from?.id ?? senderChat?.id ?? null,
		display_name: from ? [from.first_name, from.last_name].filter(Boolean).join(" ") : (senderChat?.title ?? null),
		username: from?.username ?? null,
		sender_tag: null, // group admin custom title; not present on messages, enriched separately if needed
		sender_chat: senderChat ? JSON.stringify(senderChat) : null,
		is_bot: Boolean(from?.is_bot),
		text: rich?.text && rich.text !== RICH_MESSAGE_UNAVAILABLE ? rich.text : (msg.text ?? rich?.text ?? null),
		caption: msg.caption ?? null,
		entities: msg.entities ?? msg.caption_entities ?? null,
		rich_message: rich?.source ?? null,
		rich_truncated: Boolean(rich?.truncated || rich?.rawTruncated),
		reply_to_message_id: msg.reply_to_message?.message_id ?? null,
		reply_to_sender_id: msg.reply_to_message?.from?.id ?? msg.reply_to_message?.sender_chat?.id ?? null,
		reply_snapshot:
			parent && (parent.text || parent.caption || parent.media)
				? {
						display_name: parent.display_name,
						username: parent.username,
						text: parent.text ?? parent.caption,
						media: parent.media,
					}
				: null,
		quote: msg.quote ?? null,
		forward_origin: msg.forward_origin ?? null,
		edit_date: editDate ?? msg.edit_date ?? null,
		media,
	};
}

function extractMedia(msg: any): MediaInfo | null {
	if (Array.isArray(msg.photo) && msg.photo.length > 0) {
		const p = msg.photo[msg.photo.length - 1]; // largest size
		return { kind: "photo", file_unique_id: p.file_unique_id, file_id: p.file_id, width: p.width, height: p.height };
	}
	if (msg.sticker) {
		const s = msg.sticker;
		return {
			kind: "sticker",
			file_unique_id: s.file_unique_id,
			file_id: s.file_id,
			mime: stickerMime(s),
			width: s.width,
			height: s.height,
			sticker_set: s.set_name,
			sticker_emoji: s.emoji,
		};
	}
	for (const kind of ["animation", "video", "video_note", "document", "voice", "audio"] as const) {
		const m = msg[kind];
		if (m) {
			return {
				kind,
				file_unique_id: m.file_unique_id,
				file_id: m.file_id,
				mime: m.mime_type,
				width: m.width,
				height: m.height,
			};
		}
	}
	return null;
}

/** Extract the message-bearing payload from an update, or null. */
export function extractUpdateMessage(update: any): { message: any; edited: boolean } | null {
	if (update.message) return { message: update.message, edited: false };
	if (update.edited_message) return { message: update.edited_message, edited: true };
	return null;
}
