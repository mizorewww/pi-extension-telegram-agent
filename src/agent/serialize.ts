// Serialize immutable Telegram events into the fixed LLM grammar (schema v8).
// Grammar stability is a cache invariant: never change existing output shape.
//
// Media renders as a text placeholder (`[图片]` / `[sticker 😄]` / `[video]` ...); set names never
// appear (serializer v4). Written bytes never change retroactively: a later vision description
// arrives as a media_update delta.

import type { DatabaseSync as Database } from "node:sqlite";
import type { MediaUpdatePayload, MessageEvent, NotePayload } from "../db/message-events.ts";
import type { ReplySnapshot } from "../telegram/normalize.ts";

export const TELEGRAM_SERIALIZER_VERSION = 8;

export const TRUNCATED = "\n[truncated]";
export function boundedText(text: string, limit: number): string {
	if (limit <= 0) return "";
	if (text.length <= limit) return text;
	if (limit <= TRUNCATED.length) return text.slice(0, limit);
	return `${text.slice(0, limit - TRUNCATED.length)}${TRUNCATED}`;
}
const bounded = boundedText;

const TASK_PHASE_LABEL: Record<NonNullable<NotePayload["phase"]>, string> = {
	progress: "进展",
	need_input: "需要输入",
	done: "完成",
	failed: "失败",
	cancelled: "已取消",
	interrupted: "中断",
};

/** `[task t3 完成 ↪ #18452] text（文件：/work/...）` or `[系统] text`. */
export function renderNote(messageId: number, note: NotePayload): string {
	const files = note.files?.length ? `（文件：${note.files.join("、")}）` : "";
	if (note.source === "system") return `[系统] ${note.text}${files}`;
	const label = TASK_PHASE_LABEL[note.phase ?? "progress"];
	const origin = messageId > 0 && note.phase !== "progress" ? ` ↪ #${messageId}` : "";
	return `[${note.source} ${note.task_id} ${label}${origin}] ${note.text}${files}`;
}

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
	const existing = db.prepare("SELECT alias FROM aliases WHERE chat_id = ? AND user_id = ?").get(chatId, userId) as {
		alias: string;
	} | null;
	if (existing) return existing.alias;
	// alias from rowid: stable, unique, race-free (same pattern as sticker short_id).
	const { lastInsertRowid } = db
		.prepare("INSERT INTO aliases (chat_id, user_id, alias) VALUES (?, ?, '')")
		.run(chatId, userId);
	const alias = `u${lastInsertRowid}`;
	db.prepare("UPDATE aliases SET alias = ? WHERE rowid = ?").run(alias, lastInsertRowid);
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
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function mediaPlaceholder(mediaJson: string): string {
	const media = JSON.parse(mediaJson) as {
		kind: string;
		sticker_emoji?: string;
		file_name?: string;
		file_size?: number;
		duration?: number;
	};
	if (media.kind === "sticker") return `[sticker${media.sticker_emoji ? " " + media.sticker_emoji : ""}]`;
	if (media.kind === "photo") return "[图片]";
	// Name, size and length tell the bot whether an attachment is worth downloading.
	const details = [
		media.file_name ? `"${media.file_name.replaceAll('"', "'")}"` : "",
		media.file_size ? formatBytes(media.file_size) : "",
		media.duration ? `${media.duration}s` : "",
	].filter(Boolean);
	return `[${[media.kind, ...details].join(" ")}]`;
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
		.prepare(
			"SELECT text, caption, media, display_name, username, sender_id FROM messages WHERE chat_id = ? AND message_id = ?",
		)
		.get(row.chat_id, row.reply_to_message_id) as unknown as MessageRow | null;
	if (!parent) return null;
	return {
		display_name: parent.display_name,
		username: parent.username,
		text: parent.text ?? parent.caption,
		media: parent.media ? JSON.parse(parent.media) : null,
	};
}

/** `visible`: ids already rendered earlier in the same batch; their replies omit the parent body. */
function renderReply(db: Database, m: MessageRow, visible: ReadonlySet<number>, limit = Infinity): string {
	const anchor = m.reply_to_message_id == null ? "" : ` ↪ #${m.reply_to_message_id}`;
	let line = anchor;
	if (m.reply_to_message_id != null) {
		if (!visible.has(m.reply_to_message_id)) {
			const parent = replySnapshot(db, m);
			if (parent) {
				line += ` ${parent.username ? `@${parent.username}` : (parent.display_name ?? "?")}`;
				if (parent.text)
					line += ` "${bounded(parent.text.replace(/\s+/g, " ").trim(), Math.max(0, limit - line.length - 3))}"`;
				else if (parent.media) line += ` ${mediaPlaceholder(JSON.stringify(parent.media))}`;
			} else line += ` (原消息不可见)`;
		}
	}
	if (m.quote) {
		const q = JSON.parse(m.quote) as { text?: string };
		if (q.text) line += ` quote="${bounded(q.text.replace(/\s+/g, " "), Math.max(0, limit - line.length - 9))}"`;
	}
	return anchor + bounded(line.slice(anchor.length), Math.max(0, limit - anchor.length));
}

/** Render one message row (no date separator). */
export function renderMessageLine(
	db: Database,
	m: MessageRow,
	visible: ReadonlySet<number> = new Set(),
	limit = Infinity,
): string {
	const header = `[${fmtTime(m.date)}] #${m.message_id} ${senderLabel(db, m)}`;
	let body = m.text ?? m.caption ?? (m.media ? mediaPlaceholder(m.media) : "");
	if (m.media && (m.text || m.caption)) body += ` ${mediaPlaceholder(m.media)}`;
	if (m.edit_date) body += `${body ? " " : ""}(edited)`;
	const anchor = m.reply_to_message_id == null ? "" : ` ↪ #${m.reply_to_message_id}`;
	// A long quoted parent must never displace the question that actually triggered this turn.
	body = bounded(body, Math.max(0, limit - header.length - anchor.length - 2));
	const reply = renderReply(db, m, visible, Math.max(0, limit - header.length - body.length - 2));
	return `${header}${reply}:${body ? ` ${body}` : ""}`;
}

/**
 * One rendered line per event; the date separator only appears when the day changes. A vision
 * description that arrives later is appended as its own media_update line, never rewritten into
 * a message.
 */
export function serializeMessageSegments(
	db: Database,
	events: MessageEvent[],
	maxMessageChars = Infinity,
): { event: MessageEvent; text: string }[] {
	const segments: { event: MessageEvent; text: string }[] = [];
	const visible = new Set<number>();
	let lastDate: string | null = null;
	for (const event of events) {
		if (event.kind === "message") {
			const row = event.payload as unknown as MessageRow;
			const day = fmtDate(row.date);
			const separator = day !== lastDate ? `--- ${day} ---\n` : "";
			lastDate = day;
			segments.push({ event, text: `${separator}${renderMessageLine(db, row, visible, maxMessageChars)}` });
			visible.add(row.message_id);
			continue;
		}
		if (event.kind === "note") {
			segments.push({
				event,
				text: bounded(renderNote(event.messageId, event.payload as NotePayload), maxMessageChars),
			});
			continue;
		}
		if (event.kind === "media_update") {
			const payload = event.payload as MediaUpdatePayload;
			const label =
				payload.media_kind === "photo" ? "图片" : payload.media_kind === "sticker" ? "sticker" : payload.media_kind;
			segments.push({
				event,
				text: bounded(`[media_update #${event.messageId}] [${label}: ${payload.text}]`, maxMessageChars),
			});
			continue;
		}
		const row = event.payload as unknown as MessageRow;
		if (event.kind === "edit") {
			const header = `[message_edit #${event.messageId}]`;
			const anchor = row.reply_to_message_id == null ? "" : ` ↪ #${row.reply_to_message_id}`;
			const body = bounded(
				row.text ?? row.caption ?? "",
				Math.max(0, maxMessageChars - header.length - anchor.length - 3),
			);
			const reply = renderReply(db, row, visible, Math.max(0, maxMessageChars - header.length - body.length - 3));
			segments.push({
				event,
				text: `[message_edit #${event.messageId}]${reply ? `${reply}:` : ""}${body ? ` ${body}` : " [empty]"}`,
			});
		} else {
			const reply = renderReply(db, row, visible).trim() || "reply metadata updated";
			segments.push({ event, text: bounded(`[message_metadata #${event.messageId}] ${reply}`, maxMessageChars) });
		}
	}
	return segments;
}

/** Delta events are always appended; no existing serialized message is rewritten. */
export function serializeMessageEvents(db: Database, events: MessageEvent[], maxMessageChars = Infinity): string {
	return serializeMessageSegments(db, events, maxMessageChars)
		.map((segment) => segment.text)
		.filter(Boolean)
		.join("\n");
}
