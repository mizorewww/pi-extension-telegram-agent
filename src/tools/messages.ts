// tg_messages: read-only search over the configured group's canonical message history, for
// codemode scripts. Returns a fixed DTO (never SQL or table rows) so the schema stays private and
// the model-facing contract is the declared output type. Control commands and their replies are
// excluded, like everywhere else the model sees the group. Pi validates the arguments against the
// tool schema (src/agent/tools.ts) before this runs; only semantic checks live here.

import type { Database } from "bun:sqlite";

/** The trigram index only matches needles of at least three characters. */
const INDEX_MIN_CHARS = 3;

import type { Static } from "typebox";
import type { CODEMODE_TOOL_DEFS } from "../agent/tools.ts";
export type MessageQuery = Static<(typeof CODEMODE_TOOL_DEFS)[0]["parameters"]>;

export interface MessageDto {
	id: number;
	date: string;
	ts: number;
	edited: boolean;
	sender: { id: number | null; name: string | null; username: string | null; alias: string | null; is_bot: boolean };
	text: string | null;
	reply_to: number | null;
	quote: string | null;
	forwarded: boolean;
	media: { kind: string; description: string | null; file_name: string | null; file_size: number | null } | null;
}

export interface MessageQueryResult {
	rows: MessageDto[];
	next_before_id: number | null;
	next_after_id: number | null;
}

export class MessageQueryError extends Error {}

const VIDEO_KINDS = ["video", "animation", "video_note"];

function parseTime(value: string, field: string): number {
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) throw new MessageQueryError(`${field}: expected an ISO date/time`);
	return Math.floor(ms / 1000);
}

function localDateTime(sec: number): string {
	const d = new Date(sec * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

interface Row {
	message_id: number;
	date: number;
	edit_date: number | null;
	sender_id: number | null;
	display_name: string | null;
	username: string | null;
	alias: string | null;
	is_bot: number;
	text: string | null;
	caption: string | null;
	reply_to_message_id: number | null;
	quote: string | null;
	forward_origin: string | null;
	media_kind: string | null;
	media_file_name: string | null;
	media_file_size: number | null;
	vision: string | null;
}

export function queryMessages(db: Database, chatId: number, query: MessageQuery): MessageQueryResult {
	const where = ["m.chat_id = ?", "c.message_id IS NULL"];
	const args: (string | number)[] = [chatId];
	if (query.ids !== undefined) {
		where.push(`m.message_id IN (${query.ids.map(() => "?").join(",")})`);
		args.push(...query.ids);
	}
	if (query.since !== undefined) {
		where.push("m.date >= ?");
		args.push(parseTime(query.since, "since"));
	}
	if (query.until !== undefined) {
		where.push("m.date < ?");
		args.push(parseTime(query.until, "until"));
	}
	for (const [field, op] of [
		["before_id", "<"],
		["after_id", ">"],
		["reply_to", "="],
	] as const) {
		const value = query[field];
		if (value === undefined) continue;
		where.push(`m.${field === "reply_to" ? "reply_to_message_id" : "message_id"} ${op} ?`);
		args.push(value);
	}
	if (typeof query.sender === "number") {
		where.push("m.sender_id = ?");
		args.push(query.sender);
	} else if (query.sender !== undefined) {
		const name = query.sender.trim().replace(/^@/, "");
		if (!name) throw new MessageQueryError("sender: expected a user id, @username or u<N> alias");
		where.push("(lower(m.username) = lower(?) OR a.alias = ?)");
		args.push(name, name);
	}
	const kind = query.has_media;
	if (kind === "any") where.push("m.media IS NOT NULL");
	else if (kind === "video") {
		where.push(`json_extract(m.media, '$.kind') IN (${VIDEO_KINDS.map(() => "?").join(",")})`);
		args.push(...VIDEO_KINDS);
	} else if (kind !== undefined) {
		where.push("json_extract(m.media, '$.kind') = ?");
		args.push(kind);
	}
	let indexed: string | null = null;
	const needle = query.text_contains;
	if (needle) {
		if (Array.from(needle).length >= INDEX_MIN_CHARS) {
			// A quoted FTS5 phrase is a plain substring under the trigram tokenizer.
			indexed = `"${needle.replaceAll('"', '""')}"`;
		} else {
			const pattern = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
			where.push("(m.text LIKE ? ESCAPE '\\' OR m.caption LIKE ? ESCAPE '\\')");
			args.push(pattern, pattern);
		}
	}
	const order = query.order ?? "desc";
	if (order === "relevance" && indexed == null)
		throw new MessageQueryError("order relevance needs text_contains of at least 3 characters");
	const limit = query.limit ?? 100;

	const rows = db
		.query(
			`SELECT m.message_id, m.date, m.edit_date, m.sender_id, m.display_name, m.username, a.alias, m.is_bot,
			        m.text, m.caption, m.reply_to_message_id, m.quote, m.forward_origin,
			        json_extract(m.media, '$.kind') AS media_kind, json_extract(m.media, '$.file_name') AS media_file_name,
			        json_extract(m.media, '$.file_size') AS media_file_size, md.vision
			 FROM messages m
			 ${indexed ? "JOIN messages_fts f ON f.rowid = m.rowid AND messages_fts MATCH ?" : ""}
			 LEFT JOIN telegram_control_messages c ON c.chat_id = m.chat_id AND c.message_id = m.message_id
			 LEFT JOIN aliases a ON a.chat_id = m.chat_id AND a.user_id = m.sender_id
			 LEFT JOIN media md ON m.media IS NOT NULL
			      AND md.file_unique_id = CAST(json_extract(m.media, '$.file_unique_id') AS TEXT)
			 WHERE ${where.join(" AND ")}
			 ORDER BY ${order === "relevance" ? "f.rank" : `m.message_id ${order === "desc" ? "DESC" : "ASC"}`}
			 LIMIT ?`,
		)
		.all(...(indexed ? [indexed] : []), ...args, limit + 1) as Row[];
	const more = rows.length > limit;
	const page = rows.slice(0, limit);
	const last = page.at(-1)?.message_id ?? null;
	return {
		rows: page.map(toDto),
		// Relevance order has no id cursor: raise limit or narrow the filters instead.
		next_before_id: more && order === "desc" ? last : null,
		next_after_id: more && order === "asc" ? last : null,
	};
}

function toDto(row: Row): MessageDto {
	let quote: string | null = null;
	if (row.quote) {
		const parsed = JSON.parse(row.quote) as { text?: unknown };
		quote = typeof parsed.text === "string" ? parsed.text : null;
	}
	let description: string | null = null;
	if (row.vision) {
		const parsed = JSON.parse(row.vision) as { text?: unknown };
		description = typeof parsed.text === "string" ? parsed.text : null;
	}
	return {
		id: row.message_id,
		date: localDateTime(row.date),
		ts: row.date,
		edited: row.edit_date != null,
		sender: {
			id: row.sender_id,
			name: row.display_name,
			username: row.username,
			alias: row.username ? null : row.alias,
			is_bot: row.is_bot === 1,
		},
		text: row.text ?? row.caption,
		reply_to: row.reply_to_message_id,
		quote,
		forwarded: row.forward_origin != null,
		media: row.media_kind
			? { kind: row.media_kind, description, file_name: row.media_file_name, file_size: row.media_file_size }
			: null,
	};
}
