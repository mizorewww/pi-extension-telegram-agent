// Serialize immutable Telegram events into the fixed LLM grammar (docs/cache.md, schema v8).
// Grammar stability is a cache invariant: never change existing output shape.
//
// Media renders as a text placeholder (`[图片]` / `[sticker 😄]` / `[video]` ...), optionally
// carrying the persisted vision-mode description (`[图片: 描述]` / `[sticker 😄: 描述]`). Set
// names never appear in the placeholder (serializer v4). Event-log serialization pins
// resolveVision:false so written bytes never change retroactively; a later description arrives as
// a media_update delta. In context-media mode the actual image bytes additionally travel as
// interleaved image content blocks anchored to the event's text segment (token-packer.ts,
// extensions/context.ts).

import type { Database } from "bun:sqlite";
import type { MediaUpdatePayload, MessageEvent } from "../db/message-events.ts";

export const TELEGRAM_SERIALIZER_VERSION = 4;

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

/** Fixed text anchor for media; carries the persisted vision description when one exists. */
export function mediaPlaceholder(db: Database, mediaJson: string, resolveVision = true): string {
	const media = JSON.parse(mediaJson) as {
		kind: string;
		sticker_emoji?: string;
		file_unique_id?: string;
	};
	let vision: string | null = null;
	if (resolveVision && media.file_unique_id) {
		const row = db.query("SELECT vision FROM media WHERE file_unique_id = ?").get(media.file_unique_id) as {
			vision: string | null;
		} | null;
		if (row?.vision) vision = (JSON.parse(row.vision) as { text: string }).text;
	}
	if (media.kind === "sticker") {
		const emoji = media.sticker_emoji ?? "";
		if (vision) return `[sticker${emoji ? " " + emoji : ""}: ${vision}]`;
		return `[sticker${emoji ? " " + emoji : ""}]`;
	}
	if (media.kind === "photo") return vision ? `[图片: ${vision}]` : "[图片]";
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

function shortQuote(db: Database, chatId: number, messageId: number, resolveVision = true): string | null {
	const parent = db
		.query(
			"SELECT text, caption, media, display_name, username, sender_id FROM messages WHERE chat_id = ? AND message_id = ?",
		)
		.get(chatId, messageId) as MessageRow | null;
	if (!parent) return null;
	const body = (parent.text ?? parent.caption ?? "").replace(/\s+/g, " ").trim();
	const snippet = body.length > 40 ? `${body.slice(0, 40)}…` : body;
	const who = parent.username ? `@${parent.username}` : (parent.display_name ?? "?");
	if (snippet) return `${who} "${snippet}"`;
	// Pure-media parent: render the same placeholder as the body path so the model sees
	// the media kind instead of a bare sender name (RC2). Text+media parents keep quoting
	// only the text to bound tokens.
	if (parent.media) return `${who} ${mediaPlaceholder(db, parent.media, resolveVision)}`;
	return who;
}

export interface SerializeOptions {
	/** Message ids whose content is already visible in the model's current context. */
	visibleIds: Set<number>;
	/** Event-log serialization disables live lookups so prior bytes stay immutable. */
	resolveVision?: boolean;
}

/** Render one message row (no date separator). */
function renderMessageLine(db: Database, m: MessageRow, opts: SerializeOptions): string {
	let line = `[${fmtTime(m.date)}] #${m.message_id} ${senderLabel(db, m)}`;
	if (m.reply_to_message_id != null) {
		line += ` ↪ #${m.reply_to_message_id}`;
		if (!opts.visibleIds.has(m.reply_to_message_id)) {
			const ref = shortQuote(db, m.chat_id, m.reply_to_message_id, opts.resolveVision);
			if (ref) line += ` ${ref}`;
			else line += ` (原消息不可见)`;
		}
	}
	if (m.quote) {
		const q = JSON.parse(m.quote) as { text?: string };
		if (q.text) line += ` quote="${q.text.replace(/\s+/g, " ").slice(0, 60)}"`;
	}
	line += ":";
	const body = m.text ?? m.caption ?? (m.media ? mediaPlaceholder(db, m.media, opts.resolveVision) : "");
	if (body) line += ` ${body}`;
	if (m.media && (m.text || m.caption)) line += ` ${mediaPlaceholder(db, m.media, opts.resolveVision)}`;
	if (m.edit_date) line += " (edited)";
	return line;
}

/**
 * Serialize a batch of messages (must be same chat, ascending date order).
 * Inserts date separators when the local date changes between messages.
 */
export function serializeMessages(db: Database, rows: MessageRow[], opts: SerializeOptions): string {
	const lines: string[] = [];
	let lastDate: string | null = null;
	for (const m of rows) {
		const day = fmtDate(m.date);
		if (day !== lastDate) {
			lines.push(`--- ${day} ---`);
			lastDate = day;
		}
		lines.push(renderMessageLine(db, m, opts));
		opts.visibleIds.add(m.message_id);
	}
	return lines.join("\n");
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
 * spans segments; the old per-batch reset duplicated the line). Message segments pin
 * resolveVision:false: written bytes never change when a vision description arrives later — the
 * description is appended as its own media_update segment.
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
			segments.push({ event, text: `${separator}${renderMessageLine(db, row, { ...opts, resolveVision: false })}` });
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
			segments.push({ event, text: `[message_edit #${event.messageId}]${body ? ` ${body}` : " [empty]"}` });
		} else {
			const reply = row.reply_to_message_id == null ? "reply metadata updated" : `↪ #${row.reply_to_message_id}`;
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
