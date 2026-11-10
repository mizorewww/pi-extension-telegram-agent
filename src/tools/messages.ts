// tg_messages: read-only search over the configured group's canonical message history, for
// direct tool calls and codemode scripts. Returns a fixed DTO (never SQL or table rows) so the schema stays private and
// the model-facing contract is the declared output type. Control commands and their replies are
// excluded, like everywhere else the model sees the group. Pi validates the arguments against the
// tool schema (src/agent/tools.ts) before this runs; only semantic checks live here.

import type { DatabaseSync as Database } from "node:sqlite";

/** The trigram index only matches needles of at least three characters. */
const INDEX_MIN_CHARS = 3;

import type { MessagesParams } from "../agent/tools.ts";
import type { SemanticIndex } from "./semantic.ts";
export type MessageQuery = MessagesParams;

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
	matches?: SemanticMatchDto[];
}

export interface SemanticMatchDto {
	first_id: number;
	last_id: number;
	score: number;
	/** False when the window did not fit in `limit`; fetch it with after_id/before_id. */
	in_rows: boolean;
}

/** Ranked windows reported per semantic call, whether or not their rows fit. */
const SEMANTIC_MATCHES = 10;

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

interface Filters {
	where: string[];
	args: (string | number)[];
	/** FTS5 phrase for text_contains of indexable length; bound before `args`. */
	indexed: string | null;
}

function filters(chatId: number, query: MessageQuery): Filters {
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
		const sender = query.sender.trim();
		if (!sender || sender === "@")
			throw new MessageQueryError("sender: expected a user id, @username, u<N> alias or display name");
		if (sender.startsWith("@")) {
			// Telegram usernames are ASCII; NOCASE is not Unicode nickname case folding.
			where.push("m.username = ? COLLATE NOCASE");
			args.push(sender.slice(1));
		} else if (/^u\d+$/.test(sender)) {
			where.push("a.alias = ?");
			args.push(sender);
		} else {
			// A historical name identifies every matching sender, including their other names.
			// The direct match also covers messages with no sender_id (e.g. anonymous senders).
			where.push(`(m.display_name = ? COLLATE NOCASE OR m.sender_id IN (
				SELECT sender_id FROM messages WHERE chat_id = ? AND display_name = ? COLLATE NOCASE
			))`);
			args.push(query.sender, chatId, query.sender);
		}
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
	return { where, args, indexed };
}

const SELECT_ROWS = `SELECT m.message_id, m.date, m.edit_date, m.sender_id, m.display_name, m.username, a.alias, m.is_bot,
	        m.text, m.caption, m.reply_to_message_id, m.quote, m.forward_origin,
	        json_extract(m.media, '$.kind') AS media_kind, json_extract(m.media, '$.file_name') AS media_file_name,
	        json_extract(m.media, '$.file_size') AS media_file_size, md.vision
	 FROM messages m`;
const JOIN_ROW_DETAILS = `LEFT JOIN telegram_control_messages c ON c.chat_id = m.chat_id AND c.message_id = m.message_id
	 LEFT JOIN aliases a ON a.chat_id = m.chat_id AND a.user_id = m.sender_id
	 LEFT JOIN media md ON m.media IS NOT NULL
	      AND md.file_unique_id = CAST(json_extract(m.media, '$.file_unique_id') AS TEXT)`;

export function queryMessages(db: Database, chatId: number, query: MessageQuery): MessageQueryResult {
	const { where, args, indexed } = filters(chatId, query);
	const order = query.order ?? "desc";
	if (order === "relevance" && indexed == null)
		throw new MessageQueryError("order relevance needs text_contains of at least 3 characters");
	const limit = query.limit ?? 100;

	const rows = db
		.prepare(
			`${SELECT_ROWS}
			 ${indexed ? "JOIN messages_fts f ON f.rowid = m.rowid AND messages_fts MATCH ?" : ""}
			 ${JOIN_ROW_DETAILS}
			 WHERE ${where.join(" AND ")}
			 ORDER BY ${order === "relevance" ? "f.rank" : `m.message_id ${order === "desc" ? "DESC" : "ASC"}`}
			 LIMIT ?`,
		)
		.all(...(indexed ? [indexed] : []), ...args, limit + 1) as unknown as Row[];
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

const SEMANTIC_ONLY = new Set(["semantic", "limit"]);

/**
 * Whole conversation windows ranked by meaning. Other filters keep only windows that contain at
 * least one matching message; rows are every non-control message of the kept windows.
 */
export async function semanticMessages(
	db: Database,
	chatId: number,
	index: SemanticIndex,
	query: MessageQuery & { semantic: string },
	signal?: AbortSignal,
): Promise<MessageQueryResult> {
	if (query.order !== undefined)
		throw new MessageQueryError("semantic: order is not supported; results are ranked by meaning");
	const limit = query.limit ?? 100;
	let candidate: ((firstId: number, lastId: number) => boolean) | null = null;
	if (Object.entries(query).some(([key, value]) => value !== undefined && !SEMANTIC_ONLY.has(key))) {
		const { where, args, indexed } = filters(chatId, query);
		const ids = (
			db
				.prepare(
					`SELECT m.message_id FROM messages m
					 ${indexed ? "JOIN messages_fts f ON f.rowid = m.rowid AND messages_fts MATCH ?" : ""}
					 ${JOIN_ROW_DETAILS}
					 WHERE ${where.join(" AND ")} ORDER BY m.message_id`,
				)
				.all(...(indexed ? [indexed] : []), ...args) as { message_id: number }[]
		).map(({ message_id }) => message_id);
		candidate = (first, last) => {
			// First matching id >= first; the window qualifies when it is also <= last.
			let lo = 0;
			let hi = ids.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (ids[mid]! < first) lo = mid + 1;
				else hi = mid;
			}
			return lo < ids.length && ids[lo]! <= last;
		};
	}
	const ranked = await index.search(query.semantic, SEMANTIC_MATCHES, candidate, signal);
	const select = db.prepare(
		`${SELECT_ROWS}
		 ${JOIN_ROW_DETAILS}
		 WHERE m.chat_id = ? AND c.message_id IS NULL AND m.message_id BETWEEN ? AND ?
		 ORDER BY m.message_id`,
	);
	const rows: MessageDto[] = [];
	const matches: SemanticMatchDto[] = [];
	for (const match of ranked) {
		let page = select.all(chatId, match.firstId, match.lastId) as unknown as Row[];
		// The best window is always returned (truncated if needed); later ones only when they fit whole.
		if (rows.length === 0) page = page.slice(0, limit);
		const fits = rows.length + page.length <= limit;
		if (fits) rows.push(...page.map(toDto));
		matches.push({
			first_id: match.firstId,
			last_id: match.lastId,
			score: Math.round(match.score * 1000) / 1000,
			in_rows: fits,
		});
	}
	return { rows, next_before_id: null, next_after_id: null, matches };
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
