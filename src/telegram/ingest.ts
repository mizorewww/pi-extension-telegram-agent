import { transaction as atomic } from "../db/db.ts";
// Ingestion: raw update -> raw_updates -> canonical messages. Idempotent.

import type { DatabaseSync as Database } from "node:sqlite";
import { log } from "../observability/log.ts";
import { appendMediaUpdateEvents } from "../db/message-events.ts";
import { extractUpdateMessage, normalizeMessage, type CanonicalMessage } from "../telegram/normalize.ts";
import { assignStickerShortId } from "../media/sticker-catalog.ts";

export interface IngestResult {
	kind: "inserted" | "edited" | "duplicate" | "ignored";
	chatId?: number;
	messageId?: number;
}

/**
 * Persist one raw update and its canonical projection. Must run inside the caller's SQLite
 * transaction (the poller commits it together with the dispatch handoff and the offset).
 */
export function ingestUpdate(db: Database, update: any, groupChatId: number): IngestResult {
	const updateId = update.update_id as number;

	// 1. store raw update (update_id dedupe)
	const raw = db
		.prepare("INSERT OR IGNORE INTO raw_updates (update_id, received_at, json) VALUES (?, ?, ?)")
		.run(updateId, Math.floor(Date.now() / 1000), JSON.stringify(update));
	if (raw.changes === 0) return { kind: "duplicate" };

	// 2. extract message; ignore non-message updates
	const payload = extractUpdateMessage(update);
	if (!payload) return { kind: "ignored" };
	const msg = payload.message;
	if (msg.chat.id !== groupChatId) return { kind: "ignored" };

	const canonical = normalizeMessage(msg, payload.edited ? msg.edit_date : null);
	recordMedia(db, canonical); // media identity/file_id tracked even for duplicate messages

	const result = payload.edited ? editMessage(db, canonical) : insertMessage(db, canonical);
	if (canonical.rich_truncated && (result.kind === "inserted" || result.kind === "edited")) {
		log.warn("telegram_ingest", "rich_parse_truncated", { message_id: canonical.message_id });
	}
	return result;
}

/** Persist media identity (shared file_unique_id) and the bot's file_id mapping. */
function recordMedia(db: Database, m: CanonicalMessage): void {
	if (!m.media) return;
	const media = m.media;
	db.prepare(
		`INSERT INTO media (file_unique_id, kind, mime, sticker_set, sticker_emoji)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(file_unique_id) DO UPDATE SET
		   mime = COALESCE(excluded.mime, media.mime),
		   sticker_set = COALESCE(excluded.sticker_set, media.sticker_set),
		   sticker_emoji = COALESCE(excluded.sticker_emoji, media.sticker_emoji)`,
	).run(media.file_unique_id, media.kind, media.mime ?? null, media.sticker_set ?? null, media.sticker_emoji ?? null);
	db.prepare("INSERT OR IGNORE INTO media_file_ids (file_id, file_unique_id) VALUES (?, ?)").run(
		media.file_id,
		media.file_unique_id,
	);
	if (media.kind === "sticker") assignStickerShortId(db, media.file_unique_id);
}

function insertMessage(db: Database, m: CanonicalMessage): IngestResult {
	const res = db
		.prepare(
			`INSERT OR IGNORE INTO messages (
				chat_id, message_id, date, thread_id, sender_id, display_name, username,
				sender_tag, sender_chat, is_bot, text, caption, entities, rich_message,
				reply_to_message_id, reply_to_sender_id, reply_snapshot, quote, forward_origin, edit_date, media
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			m.chat_id,
			m.message_id,
			m.date,
			m.thread_id,
			m.sender_id,
			m.display_name,
			m.username,
			m.sender_tag,
			m.sender_chat,
			m.is_bot ? 1 : 0,
			m.text,
			m.caption,
			m.entities ? JSON.stringify(m.entities) : null,
			m.rich_message,
			m.reply_to_message_id,
			m.reply_to_sender_id,
			m.reply_snapshot ? JSON.stringify(m.reply_snapshot) : null,
			m.quote ? JSON.stringify(m.quote) : null,
			m.forward_origin ? JSON.stringify(m.forward_origin) : null,
			m.edit_date,
			m.media ? JSON.stringify(m.media) : null,
		);
	if (res.changes === 0) {
		// Content enrichment appends a metadata delta, but cannot trigger another reply.
		if (m.reply_snapshot) {
			db.prepare(
				"UPDATE messages SET reply_snapshot = ? WHERE chat_id = ? AND message_id = ? AND reply_snapshot IS NULL",
			).run(JSON.stringify(m.reply_snapshot), m.chat_id, m.message_id);
		}
		return { kind: "duplicate", chatId: m.chat_id, messageId: m.message_id };
	}
	if (m.media) {
		// A description persisted for this shared media identity joins the new message as a
		// media_update delta.
		const cached = db
			.prepare("SELECT json_extract(vision, '$.text') AS text FROM media WHERE file_unique_id = ?")
			.get(m.media.file_unique_id) as { text: string | null } | null;
		if (cached?.text) appendMediaUpdateEvents(db, m.media.file_unique_id, cached.text);
	}
	return { kind: "inserted", chatId: m.chat_id, messageId: m.message_id };
}

function editMessage(db: Database, m: CanonicalMessage): IngestResult {
	const existing = db
		.prepare(
			"SELECT text, caption, entities, rich_message, date, edit_date FROM messages WHERE chat_id = ? AND message_id = ?",
		)
		.get(m.chat_id, m.message_id) as {
		text: string | null;
		caption: string | null;
		entities: string | null;
		rich_message: string | null;
		date: number;
		edit_date: number | null;
	} | null;
	if (!existing) {
		// edit arrived for a message we never saw (started mid-history): store as new
		return insertMessage(db, m);
	}
	if (existing.edit_date != null && m.edit_date != null && m.edit_date <= existing.edit_date) {
		return { kind: "duplicate", chatId: m.chat_id, messageId: m.message_id };
	}
	// revision history: keep the superseded version, keyed by *its own* time — the original
	// version uses the message date, an edited version its edit_date. Keying by the incoming
	// edit's time would collide with the previous revision on the second edit and silently
	// drop it (INSERT OR IGNORE).
	// NOTE: the media column is not updated on edit (editMessageMedia is not handled);
	// media identity/file_id mappings from edits are still tracked via recordMedia in ingestUpdate.
	db.prepare(
		"INSERT OR IGNORE INTO message_revisions (chat_id, message_id, edit_date, text, caption, entities, rich_message) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(
		m.chat_id,
		m.message_id,
		existing.edit_date ?? existing.date,
		existing.text,
		existing.caption,
		existing.entities,
		existing.rich_message,
	);
	db.prepare(
		"UPDATE messages SET text = ?, caption = ?, entities = ?, rich_message = ?, reply_to_sender_id = COALESCE(?, reply_to_sender_id), reply_snapshot = COALESCE(reply_snapshot, ?), edit_date = ? WHERE chat_id = ? AND message_id = ?",
	).run(
		m.text,
		m.caption,
		m.entities ? JSON.stringify(m.entities) : null,
		m.rich_message,
		m.reply_to_sender_id,
		m.reply_snapshot ? JSON.stringify(m.reply_snapshot) : null,
		m.edit_date,
		m.chat_id,
		m.message_id,
	);
	return { kind: "edited", chatId: m.chat_id, messageId: m.message_id };
}

/** Persist a known control-menu edit through the same canonical/revision path as Telegram edits. */
export function persistEditedControlMessage(db: Database, raw: Record<string, unknown>): void {
	const canonical = normalizeMessage(raw, typeof raw.edit_date === "number" ? raw.edit_date : null);
	atomic(db, () => editMessage(db, canonical));
}

/** Insert a message we just sent via Bot API (send tool). Dedupes against the later poller echo. */
export function insertSentMessage(db: Database, rawMsg: unknown): CanonicalMessage {
	const canonical = normalizeMessage(rawMsg);
	recordMedia(db, canonical); // don't rely on the poller echo to fill file_id mappings
	insertMessage(db, canonical);
	if (canonical.rich_truncated) {
		log.warn("telegram_ingest", "rich_parse_truncated", { message_id: canonical.message_id });
	}
	return canonical;
}
