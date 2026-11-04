import { createHash } from "node:crypto";
import type { MessageRow } from "../agent/serialize.ts";
import type { Database } from "./db.ts";

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

interface MessageEventDbRow extends Omit<MessageEvent, "payload"> {
	payloadJson: string;
}

function decodeEvent({ payloadJson, ...event }: MessageEventDbRow): MessageEvent {
	return { ...event, payload: JSON.parse(payloadJson) as MessageEvent["payload"] };
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
		.prepare("SELECT COALESCE(MAX(ingest_seq), 0) AS seq FROM message_events WHERE chat_id = ?")
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
		.prepare(`${EVENT_SELECT}
			WHERE chat_id = ? AND ingest_seq > ? AND ingest_seq <= ?
			ORDER BY ingest_seq DESC
			LIMIT ?`)
		.all(chatId, afterSeq, throughSeq, limit) as unknown as MessageEventDbRow[];
	return rows.reverse().map(decodeEvent);
}

/** Append immutable provider deltas for every canonical message that references this media. */
export function appendMediaUpdateEvents(db: Database, fileUniqueId: string, text: string): number {
	const normalized = text.trim();
	if (!normalized) return 0;
	const revisionHex = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
	const result = db
		.prepare(`
		INSERT OR IGNORE INTO message_events
			(event_key, chat_id, message_id, revision, kind, event_date, payload_json)
		SELECT 'media:' || chat_id || ':' || message_id || ':' || ?,
			chat_id, message_id, ?, 'media_update', MAX(date, ?),
			json_object('file_unique_id', ?, 'media_kind', COALESCE(json_extract(media, '$.kind'), 'media'), 'text', ?)
		FROM messages
		WHERE media IS NOT NULL AND CAST(json_extract(media, '$.file_unique_id') AS TEXT) = ?
	`)
		.run(
			revisionHex,
			Number.parseInt(revisionHex, 16),
			Math.floor(Date.now() / 1000),
			fileUniqueId,
			normalized,
			fileUniqueId,
		);
	return Number(result.changes);
}

/** One real message of the group; control commands and their replies do not count. */
export function groupMessage(db: Database, chatId: number, messageId: number): MessageRow | null {
	const row = db
		.prepare(
			`SELECT m.* FROM messages m
			  WHERE m.chat_id = ? AND m.message_id = ?
			    AND NOT EXISTS (SELECT 1 FROM telegram_control_messages c
			                     WHERE c.chat_id = m.chat_id AND c.message_id = m.message_id)`,
		)
		.get(chatId, messageId) as unknown as MessageRow | undefined;
	return row ?? null;
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
		.prepare(`
			INSERT OR IGNORE INTO message_events
				(event_key, chat_id, message_id, revision, kind, event_date, payload_json)
			VALUES (?, ?, ?, 0, 'note', ?, ?)
		`)
		.run(`note:${key}`, chatId, messageId, Math.floor(Date.now() / 1000), JSON.stringify(payload));
	return result.changes > 0 ? Number(result.lastInsertRowid) : null;
}
