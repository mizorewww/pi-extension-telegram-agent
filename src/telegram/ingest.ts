// Ingestion: raw update -> raw_updates -> canonical messages. Idempotent.
// See docs/data-model.md for dedupe rules.

import type { Database } from "bun:sqlite";
import { log } from "../observability/log.ts";
import { appendMediaUpdateEvents } from "../db/message-events.ts";
import { extractUpdateMessage, isTargetChat, normalizeMessage, type CanonicalMessage } from "../telegram/normalize.ts";

export interface IngestResult {
	kind: "inserted" | "edited" | "enriched" | "duplicate" | "ignored";
	chatId?: number;
	messageId?: number;
	/** Immutable routing generation: initial=1, reply metadata enrichment=2, edits=Telegram edit time. */
	routeVersion?: number;
}

// first_seen_by for edits that arrive before the original message (started mid-history)
export const EDIT_UNKNOWN_BOT_ID = "edit-unknown";

export function ingestUpdate(
	db: Database,
	botId: string,
	update: any,
	groupPeerId: number,
	/** Vision mode replays persisted descriptions as media_update events; context mode never emits them. */
	emitMediaUpdates = true,
): IngestResult {
	return db.transaction(() => ingestUpdateTransaction(db, botId, update, groupPeerId, emitMediaUpdates))();
}

function ingestUpdateTransaction(
	db: Database,
	botId: string,
	update: any,
	groupPeerId: number,
	emitMediaUpdates = true,
): IngestResult {
	const updateId = update.update_id as number;

	// 1. store raw update (bot_id + update_id dedupe)
	const raw = db
		.query("INSERT OR IGNORE INTO raw_updates (bot_id, update_id, received_at, json) VALUES (?, ?, ?, ?)")
		.run(botId, updateId, Math.floor(Date.now() / 1000), JSON.stringify(update));
	if (raw.changes === 0) return { kind: "duplicate" };

	// 2. extract message; ignore non-message updates
	const payload = extractUpdateMessage(update);
	if (!payload) return { kind: "ignored" };
	const msg = payload.message;
	if (!isTargetChat(msg.chat.id, groupPeerId)) return { kind: "ignored" };

	const canonical = normalizeMessage(msg, payload.edited ? (msg.edit_date ?? Math.floor(Date.now() / 1000)) : null);
	recordMedia(db, botId, canonical); // media identity/file_id tracked even for duplicate messages

	const result = payload.edited
		? editMessage(db, canonical, emitMediaUpdates)
		: insertMessage(db, botId, canonical, emitMediaUpdates);
	if (canonical.rich_truncated && (result.kind === "inserted" || result.kind === "edited")) {
		log.warn("telegram_ingest", "rich_parse_truncated", { bot_id: botId, message_id: canonical.message_id });
	}
	return result;
}

/** Persist media identity (shared file_unique_id) and this bot's file_id mapping. */
function recordMedia(db: Database, botId: string, m: CanonicalMessage): void {
	if (!m.media) return;
	const media = m.media;
	db.query(
		`INSERT INTO media (file_unique_id, kind, mime, width, height, sticker_set, sticker_emoji)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(file_unique_id) DO UPDATE SET
		   mime = COALESCE(excluded.mime, media.mime),
		   width = COALESCE(excluded.width, media.width),
		   height = COALESCE(excluded.height, media.height),
		   sticker_set = COALESCE(excluded.sticker_set, media.sticker_set),
		   sticker_emoji = COALESCE(excluded.sticker_emoji, media.sticker_emoji)`,
	).run(
		media.file_unique_id,
		media.kind,
		media.mime ?? null,
		media.width ?? null,
		media.height ?? null,
		media.sticker_set ?? null,
		media.sticker_emoji ?? null,
	);
	db.query("INSERT OR IGNORE INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES (?, ?, ?)").run(
		botId,
		media.file_id,
		media.file_unique_id,
	);
	if (media.kind === "sticker") {
		const row = db.query("SELECT rowid FROM media WHERE file_unique_id = ?").get(media.file_unique_id) as {
			rowid: number;
		} | null;
		if (row) {
			db.query("UPDATE media SET short_id = ? WHERE file_unique_id = ? AND short_id IS NULL").run(
				`s${row.rowid}`,
				media.file_unique_id,
			);
		}
	}
}

function insertMessage(db: Database, botId: string, m: CanonicalMessage, emitMediaUpdates = true): IngestResult {
	const res = db
		.query(
			`INSERT OR IGNORE INTO messages (
				chat_id, message_id, date, thread_id, sender_id, display_name, username,
				sender_tag, sender_chat, is_bot, text, caption, entities, rich_message,
				reply_to_message_id, reply_to_sender_id, quote, forward_origin, edit_date, media, first_seen_by
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
			m.quote ? JSON.stringify(m.quote) : null,
			m.forward_origin ? JSON.stringify(m.forward_origin) : null,
			m.edit_date,
			m.media ? JSON.stringify(m.media) : null,
			botId,
		);
	if (res.changes === 0) {
		// A second bot's copy may carry the embedded reply sender snapshot that the first
		// update omitted. Enrich once so the direct reply can still be routed durably.
		if (m.reply_to_sender_id != null) {
			const enriched = db
				.query(
					"UPDATE messages SET reply_to_sender_id = ? WHERE chat_id = ? AND message_id = ? AND reply_to_sender_id IS NULL",
				)
				.run(m.reply_to_sender_id, m.chat_id, m.message_id);
			if (enriched.changes > 0)
				return { kind: "enriched", chatId: m.chat_id, messageId: m.message_id, routeVersion: 2 };
		}
		return { kind: "duplicate", chatId: m.chat_id, messageId: m.message_id };
	}
	if (m.media && emitMediaUpdates) {
		// Vision-mode replay: a description persisted for this shared media identity joins the
		// new message as a media_update delta. Context mode attaches image blocks instead and
		// must never inject description text, so the caller disables this path.
		const cached = db
			.query("SELECT json_extract(vision, '$.text') AS text FROM media WHERE file_unique_id = ?")
			.get(m.media.file_unique_id) as { text: string | null } | null;
		if (cached?.text) appendMediaUpdateEvents(db, m.media.file_unique_id, cached.text);
	}
	return { kind: "inserted", chatId: m.chat_id, messageId: m.message_id, routeVersion: 1 };
}

function editMessage(db: Database, m: CanonicalMessage, emitMediaUpdates = true): IngestResult {
	const existing = db
		.query(
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
		return insertMessage(db, EDIT_UNKNOWN_BOT_ID, m, emitMediaUpdates);
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
	db.query(
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
	db.query(
		"UPDATE messages SET text = ?, caption = ?, entities = ?, rich_message = ?, reply_to_sender_id = COALESCE(?, reply_to_sender_id), edit_date = ? WHERE chat_id = ? AND message_id = ?",
	).run(
		m.text,
		m.caption,
		m.entities ? JSON.stringify(m.entities) : null,
		m.rich_message,
		m.reply_to_sender_id,
		m.edit_date,
		m.chat_id,
		m.message_id,
	);
	return {
		kind: "edited",
		chatId: m.chat_id,
		messageId: m.message_id,
		routeVersion: m.edit_date ?? Math.max(3, m.date),
	};
}

/** Insert a message we just sent via Bot API (send tool). Dedupes against the later poller echo. */
export function insertSentMessage(
	db: Database,
	botId: string,
	rawMsg: unknown,
	emitMediaUpdates = true,
): CanonicalMessage {
	const canonical = normalizeMessage(rawMsg);
	recordMedia(db, botId, canonical); // don't rely on the poller echo to fill file_id mappings
	insertMessage(db, botId, canonical, emitMediaUpdates);
	if (canonical.rich_truncated) {
		log.warn("telegram_ingest", "rich_parse_truncated", { bot_id: botId, message_id: canonical.message_id });
	}
	return canonical;
}
