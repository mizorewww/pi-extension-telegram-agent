import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { MessageRow } from "../agent/serialize.ts";

export type MessageEventKind = "message" | "edit" | "metadata" | "media_update" | "note";

/**
 * A non-Telegram input for one bot: a task update or a system notice. `message_id` of the event
 * is the message it concerns (a task's origin), or 0.
 */
export interface NotePayload {
	bot_id: string;
	source: "task" | "job" | "system";
	task_id?: string;
	phase?: "progress" | "need_input" | "done" | "failed" | "cancelled" | "interrupted";
	text: string;
	files?: string[];
}

export interface MediaUpdatePayload {
	file_unique_id: string;
	media_kind: string;
	text: string;
}

export interface MessageEvent {
	ingestSeq: number;
	chatId: number;
	messageId: number;
	revision: number;
	kind: MessageEventKind;
	eventDate: number;
	payload: MessageRow | MediaUpdatePayload | NotePayload;
}

interface MessageEventDbRow {
	ingestSeq: number;
	chatId: number;
	messageId: number;
	revision: number;
	kind: MessageEventKind;
	eventDate: number;
	payloadJson: string;
}

function decodeEvent(row: MessageEventDbRow): MessageEvent {
	return {
		ingestSeq: row.ingestSeq,
		chatId: row.chatId,
		messageId: row.messageId,
		revision: row.revision,
		kind: row.kind,
		eventDate: row.eventDate,
		payload: JSON.parse(row.payloadJson) as MessageRow | MediaUpdatePayload | NotePayload,
	};
}

const EVENT_SELECT = `
	SELECT e.ingest_seq AS ingestSeq,
	       e.chat_id AS chatId,
	       e.message_id AS messageId,
	       e.revision,
	       e.kind,
	       e.event_date AS eventDate,
	       e.payload_json AS payloadJson
	  FROM message_events e`;

export function messageEventHighWater(db: Database, chatId: number): number {
	const row = db
		.query("SELECT COALESCE(MAX(ingest_seq), 0) AS seq FROM message_events WHERE chat_id = ?")
		.get(chatId) as { seq: number };
	return row.seq;
}

/**
 * Read only the newest bounded window. The caller may advance to `throughSeq` after a successful
 * submit, so an arbitrarily large normal backlog never turns into an O(database lifetime) scan.
 */
export function listRecentMessageEvents(
	db: Database,
	chatId: number,
	afterSeq: number,
	throughSeq: number,
	limit: number,
): MessageEvent[] {
	if (throughSeq <= afterSeq || limit <= 0) return [];
	const rows = db
		.query(`${EVENT_SELECT}
			WHERE chat_id = ? AND ingest_seq > ? AND ingest_seq <= ?
			ORDER BY ingest_seq DESC
			LIMIT ?`)
		.all(chatId, afterSeq, throughSeq, limit) as MessageEventDbRow[];
	return rows.reverse().map(decodeEvent);
}

/** Obligations remain addressable even after the ordinary cursor advanced past their event. */
export function listReplyObligationEvents(db: Database, botId: string, chatId: number, limit = 64): MessageEvent[] {
	const rows = db
		.query(`${EVENT_SELECT}
			JOIN reply_obligations o
			  ON o.chat_id = e.chat_id AND o.message_id = e.message_id
			WHERE o.bot_id = ? AND o.chat_id = ? AND e.kind = 'message'
			ORDER BY e.ingest_seq
			LIMIT ?`)
		.all(botId, chatId, Math.max(1, Math.floor(limit))) as MessageEventDbRow[];
	return rows.map(decodeEvent);
}

export function getConsumedSeq(db: Database, botId: string, chatId: number): number {
	const row = db
		.query("SELECT consumed_seq AS consumedSeq FROM bot_cursors WHERE bot_id = ? AND chat_id = ?")
		.get(botId, chatId) as { consumedSeq: number } | null;
	return row?.consumedSeq ?? 0;
}

export function setConsumedSeq(db: Database, botId: string, chatId: number, consumedSeq: number): void {
	const current = getConsumedSeq(db, botId, chatId);
	if (consumedSeq < current) throw new Error(`consumed cursor cannot move backwards (${consumedSeq} < ${current})`);
	db.query(`
		INSERT INTO bot_cursors (bot_id, chat_id, consumed_seq, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(bot_id, chat_id) DO UPDATE SET
			consumed_seq = MAX(bot_cursors.consumed_seq, excluded.consumed_seq),
			updated_at = excluded.updated_at
	`).run(botId, chatId, consumedSeq, Date.now());
}

export function listVisibleMessageIds(db: Database, botId: string, chatId: number, epoch: number): number[] {
	return (
		db
			.query(`
			SELECT message_id AS messageId
			  FROM bot_visible_messages
			 WHERE bot_id = ? AND chat_id = ? AND context_epoch = ?
			 ORDER BY message_id
		`)
			.all(botId, chatId, epoch) as { messageId: number }[]
	).map((row) => row.messageId);
}

export function replaceVisibleMessageIds(
	db: Database,
	botId: string,
	chatId: number,
	epoch: number,
	messageIds: readonly number[],
): void {
	const replace = db.transaction(() => {
		db.query("DELETE FROM bot_visible_messages WHERE bot_id = ? AND chat_id = ?").run(botId, chatId);
		const insert = db.query(`
			INSERT OR IGNORE INTO bot_visible_messages
				(bot_id, chat_id, message_id, context_epoch)
			VALUES (?, ?, ?, ?)
		`);
		for (const messageId of new Set(messageIds)) insert.run(botId, chatId, messageId, epoch);
	});
	replace();
}

export function addVisibleMessageIds(
	db: Database,
	botId: string,
	chatId: number,
	epoch: number,
	messageIds: readonly number[],
): void {
	if (messageIds.length === 0) return;
	const insert = db.query(`
		INSERT OR IGNORE INTO bot_visible_messages
			(bot_id, chat_id, message_id, context_epoch)
		VALUES (?, ?, ?, ?)
	`);
	const transaction = db.transaction(() => {
		for (const messageId of new Set(messageIds)) insert.run(botId, chatId, messageId, epoch);
	});
	transaction();
}

/** SQLite half of the Pi-session/custom-message commit; startup reconciliation closes the crash gap. */
export function commitConsumedContext(
	db: Database,
	input: {
		botId: string;
		chatId: number;
		consumedSeq: number;
		epoch: number;
		visibleMessageIds: readonly number[];
		deliveredObligationIds: readonly number[];
	},
): void {
	const transaction = db.transaction(() => {
		setConsumedSeq(db, input.botId, input.chatId, input.consumedSeq);
		replaceVisibleMessageIds(db, input.botId, input.chatId, input.epoch, input.visibleMessageIds);
		const removeObligation = db.query(`
			DELETE FROM reply_obligations
			 WHERE bot_id = ? AND chat_id = ? AND message_id = ?
		`);
		for (const messageId of new Set(input.deliveredObligationIds)) {
			removeObligation.run(input.botId, input.chatId, messageId);
		}
	});
	transaction();
}

/** Append immutable provider deltas for every canonical message that references this media. */
export function appendMediaUpdateEvents(db: Database, fileUniqueId: string, text: string): number {
	const normalized = text.trim();
	if (!normalized) return 0;
	const rows = db
		.query(`
			SELECT chat_id AS chatId, message_id AS messageId, date,
			       COALESCE(json_extract(media, '$.kind'), 'media') AS mediaKind
			  FROM messages
			 WHERE json_extract(media, '$.file_unique_id') = ?
		`)
		.all(fileUniqueId) as { chatId: number; messageId: number; date: number; mediaKind: string }[];
	const revisionHex = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
	const revision = Number.parseInt(revisionHex, 16);
	const insert = db.query(`
		INSERT OR IGNORE INTO message_events
			(event_key, chat_id, message_id, revision, kind, event_date, payload_json)
		VALUES (?, ?, ?, ?, 'media_update', ?, ?)
	`);
	let changes = 0;
	const transaction = db.transaction(() => {
		for (const row of rows) {
			const result = insert.run(
				`media:${row.chatId}:${row.messageId}:${revisionHex}`,
				row.chatId,
				row.messageId,
				revision,
				Math.max(row.date, Math.floor(Date.now() / 1000)),
				JSON.stringify({ file_unique_id: fileUniqueId, media_kind: row.mediaKind, text: normalized }),
			);
			changes += result.changes;
		}
	});
	transaction();
	return changes;
}

/** One real message of the group; control commands and their replies do not count. */
export function groupMessage(db: Database, chatId: number, messageId: number): MessageRow | null {
	return db
		.query(
			`SELECT m.* FROM messages m
			  WHERE m.chat_id = ? AND m.message_id = ?
			    AND NOT EXISTS (SELECT 1 FROM telegram_control_messages c
			                     WHERE c.chat_id = m.chat_id AND c.message_id = m.message_id)`,
		)
		.get(chatId, messageId) as MessageRow | null;
}

/** Notes belong to one bot; every other bot's cursor just passes over them. */
export function eventsForBot(events: readonly MessageEvent[], botId: string): MessageEvent[] {
	return events.filter((event) => event.kind !== "note" || (event.payload as NotePayload).bot_id === botId);
}

/** Append one note event; `key` makes the append idempotent. Returns its ingest_seq, or null. */
export function appendNoteEvent(
	db: Database,
	chatId: number,
	messageId: number,
	key: string,
	payload: NotePayload,
): number | null {
	const result = db
		.query(`
			INSERT OR IGNORE INTO message_events
				(event_key, chat_id, message_id, revision, kind, event_date, payload_json)
			VALUES (?, ?, ?, 0, 'note', ?, ?)
		`)
		.run(`note:${key}`, chatId, messageId, Math.floor(Date.now() / 1000), JSON.stringify(payload));
	return result.changes > 0 ? Number(result.lastInsertRowid) : null;
}

export interface SessionManifest {
	botId: string;
	sessionId: string;
	sessionFile: string;
	contextFingerprint: string;
	createdAt: number;
}

export function getSessionManifest(db: Database, botId: string): SessionManifest | null {
	return db
		.query(`
		SELECT bot_id AS botId,
		       session_id AS sessionId,
		       session_file AS sessionFile,
		       context_fingerprint AS contextFingerprint,
		       created_at AS createdAt
		  FROM bot_session_manifest
		 WHERE bot_id = ?
	`)
		.get(botId) as SessionManifest | null;
}

export function setSessionManifest(db: Database, manifest: SessionManifest): void {
	db.query(`
		INSERT INTO bot_session_manifest
			(bot_id, session_id, session_file, context_fingerprint, created_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(bot_id) DO UPDATE SET
			session_id = excluded.session_id,
			session_file = excluded.session_file,
			context_fingerprint = excluded.context_fingerprint,
			created_at = excluded.created_at
	`).run(manifest.botId, manifest.sessionId, manifest.sessionFile, manifest.contextFingerprint, manifest.createdAt);
}
