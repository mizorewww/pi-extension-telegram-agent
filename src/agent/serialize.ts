// Serialize immutable Telegram events into the fixed LLM grammar (docs/cache.md, schema v8).
// Grammar stability is a cache invariant: never change existing output shape.
//
// Media renders as a text placeholder (`[图片]` / `[sticker 😄]` / `[video]` ...); set names never
// appear (serializer v4). Written bytes never change retroactively: a later vision description
// arrives as a media_update delta. In context-media mode the actual image bytes additionally travel as
// interleaved image content blocks anchored to the event's text segment (token-packer.ts,
// extensions/context.ts).

import type { Database } from "bun:sqlite";
import type { MediaUpdatePayload, MessageEvent } from "../db/message-events.ts";
import type { ReplySnapshot } from "../telegram/normalize.ts";

export const TELEGRAM_SERIALIZER_VERSION = 5;

export interface MessageRow {
	chat_id: number;
	message_id: number;
	date: number;
	thread_id: number | null;
	sender_id: number | null;
	display_name: string | null;
	username: string | null;
	sender_tag: string | null;
	sender_chat?: string | null;
	is_bot: number;
	text: string | null;
	caption: string | null;
	entities: string | null;
	rich_message?: string | null;
	reply_to_message_id: number | null;
	reply_to_sender_id?: number | null;
	reply_snapshot?: string | null;
	quote: string | null;
	forward_origin?: string | null;
	edit_date: number | null;
	media: string | null;
}

/** Stable short alias (u<N>) for users without username. */
export function getOrCreateAlias(db: Database, chatId: number, userId: number): string {
	const existing = db.query("SELECT alias FROM aliases WHERE chat_id = ? AND user_id = ?").get(chatId, userId) as {
		alias: string;
	} | null;
	if (existing) return existing.alias;
	// alias from rowid: stable, unique, race-free (same pattern as sticker short_id).
	const { lastInsertRowid } = db
		.query("INSERT INTO aliases (chat_id, user_id, alias) VALUES (?, ?, '')")
		.run(chatId, userId);
	const alias = `u${lastInsertRowid}`;
	db.query("UPDATE aliases SET alias = ? WHERE rowid = ?").run(alias, lastInsertRowid);
	return alias;
}

function senderLabel(db: Database, m: MessageRow): string {
	const name = m.display_name ?? (m.sender_id != null ? String(m.sender_id) : "?");
	const parts: string[] = [];
	if (m.username) parts.push(`@${m.username}`);
	else if (m.sender_id != null) parts.push(getOrCreateAlias(db, m.chat_id, m.sender_id));
	if (m.is_bot) parts.push("bot");
	if (m.sender_tag) parts.push(`tag:${m.sender_tag}`);
	return parts.length > 0 ? `${name} (${parts.join(" · ")})` : name;
}

/** Fixed text anchor for media; descriptions arrive later as media_update deltas, never inline. */
function mediaPlaceholder(mediaJson: string): string {
	const media = JSON.parse(mediaJson) as { kind: string; sticker_emoji?: string };
	if (media.kind === "sticker") return `[sticker${media.sticker_emoji ? " " + media.sticker_emoji : ""}]`;
	if (media.kind === "photo") return "[图片]";
	return `[${media.kind}]`;
}

function fmtTime(dateSec: number): string {
	const d = new Date(dateSec * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDate(dateSec: number): string {
	const d = new Date(dateSec * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Prefer the immutable embedded parent; old rows can still resolve locally retained history. */
export function replySnapshot(db: Database, row: MessageRow): ReplySnapshot | null {
	if (row.reply_snapshot) return JSON.parse(row.reply_snapshot) as ReplySnapshot;
	if (row.reply_to_message_id == null) return null;
	const parent = db
		.query(
			"SELECT text, caption, media, display_name, username, sender_id FROM messages WHERE chat_id = ? AND message_id = ?",
		)
		.get(row.chat_id, row.reply_to_message_id) as MessageRow | null;
	if (!parent) return null;
	return {
		display_name: parent.display_name,
		username: parent.username,
		text: parent.text ?? parent.caption,
		media: parent.media ? JSON.parse(parent.media) : null,
	};
}

export interface SerializeOptions {
	/** Message ids whose content is already visible in the model's current context. */
	visibleIds: Set<number>;
}

function renderReply(db: Database, m: MessageRow, opts: SerializeOptions): string {
	let line = "";
	if (m.reply_to_message_id != null) {
		line += ` ↪ #${m.reply_to_message_id}`;
		if (!opts.visibleIds.has(m.reply_to_message_id)) {
			const parent = replySnapshot(db, m);
			if (parent) {
				line += ` ${parent.username ? `@${parent.username}` : (parent.display_name ?? "?")}`;
				if (parent.text) line += ` "${parent.text.replace(/\s+/g, " ").trim()}"`;
				else if (parent.media) line += ` ${mediaPlaceholder(JSON.stringify(parent.media))}`;
			} else line += ` (原消息不可见)`;
		}
	}
	if (m.quote) {
		const q = JSON.parse(m.quote) as { text?: string };
		if (q.text) line += ` quote="${q.text.replace(/\s+/g, " ")}"`;
	}
	return line;
}

/** Render one message row (no date separator). */
function renderMessageLine(db: Database, m: MessageRow, opts: SerializeOptions): string {
	let line = `[${fmtTime(m.date)}] #${m.message_id} ${senderLabel(db, m)}${renderReply(db, m, opts)}`;
	line += ":";
	const body = m.text ?? m.caption ?? (m.media ? mediaPlaceholder(m.media) : "");
	if (body) line += ` ${body}`;
	if (m.media && (m.text || m.caption)) line += ` ${mediaPlaceholder(m.media)}`;
	if (m.edit_date) line += " (edited)";
	return line;
}

export interface SerializedEventSegment {
	event: MessageEvent;
	/** Rendered text for this event, including a leading date separator when the day changes. */
	text: string;
}

/**
 * Serialize events one segment each so context-mode media image blocks can interleave at the
 * exact message position. For pure message runs, joining segment texts with "\n" is byte-identical
 * to the historical whole-batch rendering. One deliberate difference: a media_update delta between
 * two same-day messages no longer re-emits the `--- YYYY-MM-DD ---` separator (the day state now
 * spans segments; the old per-batch reset duplicated the line). A vision description that
 * arrives later is appended as its own media_update segment, never rewritten into a message.
 */
export function serializeMessageEventSegments(
	db: Database,
	events: MessageEvent[],
	opts: SerializeOptions,
): SerializedEventSegment[] {
	const segments: SerializedEventSegment[] = [];
	let lastDate: string | null = null;
	for (const event of events) {
		if (event.kind === "message") {
			const row = event.payload as MessageRow;
			const day = fmtDate(row.date);
			const separator = day !== lastDate ? `--- ${day} ---\n` : "";
			lastDate = day;
			segments.push({ event, text: `${separator}${renderMessageLine(db, row, opts)}` });
			opts.visibleIds.add(row.message_id);
			continue;
		}
		if (event.kind === "media_update") {
			const payload = event.payload as MediaUpdatePayload;
			const label =
				payload.media_kind === "photo" ? "图片" : payload.media_kind === "sticker" ? "sticker" : payload.media_kind;
			segments.push({ event, text: `[media_update #${event.messageId}] [${label}: ${payload.text}]` });
			continue;
		}
		const row = event.payload as MessageRow;
		if (event.kind === "edit") {
			const body = row.text ?? row.caption ?? "";
			const reply = renderReply(db, row, opts);
			segments.push({
				event,
				text: `[message_edit #${event.messageId}]${reply ? `${reply}:` : ""}${body ? ` ${body}` : " [empty]"}`,
			});
		} else {
			const reply = renderReply(db, row, opts).trim() || "reply metadata updated";
			segments.push({ event, text: `[message_metadata #${event.messageId}] ${reply}` });
		}
	}
	return segments;
}

/** Delta events are always appended; no existing serialized message is rewritten. */
export function serializeMessageEvents(db: Database, events: MessageEvent[], opts: SerializeOptions): string {
	return serializeMessageEventSegments(db, events, opts)
		.map((segment) => segment.text)
		.filter(Boolean)
		.join("\n");
}
