// Telegram-specific sticker identities; Pi receives a fixed catalog plus append-only notes.
import { contentText, type Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { transaction, type Database } from "../db/db.ts";
import { SYSTEM_NOTE_LABEL } from "../agent/prompt.ts";
import { errorCategory, log } from "../observability/log.ts";
import type { BotApi } from "../telegram/api.ts";

export const STICKER_CATALOG_MAX = 120;
export const CONTEXT_STICKER_CANDIDATE_MAX = 8;
export type StickerMime = "image/webp" | "application/x-tgsticker" | "video/webm";
interface TelegramSticker {
	file_id: string;
	file_unique_id: string;
	emoji?: string;
	is_animated?: boolean;
	is_video?: boolean;
}
interface CatalogRow {
	short_id: string;
	sticker_emoji: string | null;
	vision: string | null;
}
export function stickerMime(sticker: { is_animated?: boolean; is_video?: boolean }): StickerMime {
	return sticker.is_video ? "video/webm" : sticker.is_animated ? "application/x-tgsticker" : "image/webp";
}
export function assignStickerShortId(db: Database, fileUniqueId: string): void {
	db.prepare("UPDATE media SET short_id = 's' || rowid WHERE file_unique_id = ? AND short_id IS NULL").run(
		fileUniqueId,
	);
}
export async function ensureStickerCatalog(db: Database, api: BotApi, sets: string[]): Promise<void> {
	let total = 0;
	for (const setName of sets) {
		if (total >= STICKER_CATALOG_MAX) break;
		let stickers: TelegramSticker[];
		try {
			stickers = (await api.call<{ stickers: TelegramSticker[] }>("getStickerSet", { name: setName })).stickers;
		} catch (error) {
			log.warn("sticker_catalog", "set_fetch_failed", { category: errorCategory(error) });
			continue;
		}
		transaction(db, () => {
			for (const sticker of stickers.slice(0, STICKER_CATALOG_MAX - total)) {
				db.prepare(`INSERT INTO media (file_unique_id, kind, mime, sticker_set, sticker_emoji) VALUES (?, 'sticker', ?, ?, ?)
					ON CONFLICT(file_unique_id) DO UPDATE SET mime = excluded.mime, sticker_set = excluded.sticker_set, sticker_emoji = COALESCE(excluded.sticker_emoji, media.sticker_emoji)`).run(
					sticker.file_unique_id,
					stickerMime(sticker),
					setName,
					sticker.emoji ?? null,
				);
				db.prepare("INSERT OR IGNORE INTO media_file_ids (file_id, file_unique_id) VALUES (?, ?)").run(
					sticker.file_id,
					sticker.file_unique_id,
				);
				assignStickerShortId(db, sticker.file_unique_id);
				total++;
			}
		});
	}
	log.info("sticker_catalog", "catalog_ready", { fetched: total });
}
function catalogRows(db: Database, sets: readonly string[]): CatalogRow[] {
	return db
		.prepare(`SELECT sticker_emoji, vision, short_id FROM media m
		WHERE kind = 'sticker' AND short_id IS NOT NULL AND sticker_set IN (SELECT value FROM json_each(?))
		AND EXISTS (SELECT 1 FROM media_file_ids f WHERE f.file_unique_id = m.file_unique_id)
		ORDER BY sticker_set, rowid`)
		.all(JSON.stringify(sets)) as unknown as CatalogRow[];
}
function stickerDescription(vision: string | null): string {
	const text = vision ? (JSON.parse(vision) as { text?: string | null }).text : null;
	return text?.replace(/\s+/g, " ").trim().slice(0, 60) ?? "";
}
function stickerLine(row: CatalogRow): string {
	const description = [row.sticker_emoji, stickerDescription(row.vision)].filter(Boolean).join(" ");
	return `${row.short_id}${description ? `: ${description}` : ""}`;
}
// A type alias, not an interface: Pi docs require JSON-compatible index signatures.
export type StickerCatalogSnapshot = { ids: string; block: string };
/** `ids` identifies the catalog; descriptions inside `block` are backfilled asynchronously. */
export function stickerCatalogSnapshot(db: Database, sets: readonly string[]): StickerCatalogSnapshot {
	const rows = catalogRows(db, sets);
	return {
		ids: rows.map((row) => row.short_id).join(","),
		block: rows.length ? `# Sticker 目录\n\n${rows.map(stickerLine).join("\n")}` : "",
	};
}
/** A batch's note is rendered once and stays at that position for the life of the context. */
export function batchStickerCandidates(
	db: Database,
	chatId: number,
	messageIds: readonly number[],
	catalogSets: readonly string[],
): string {
	if (!messageIds.length) return "";
	const rows = db
		.prepare(`SELECT media.rowid, media.file_unique_id, media.short_id, media.sticker_emoji, media.vision
		FROM json_each(?2) batch JOIN messages message ON message.chat_id = ?1 AND message.message_id = CAST(batch.value AS INTEGER)
		JOIN media ON media.file_unique_id = json_extract(message.media, '$.file_unique_id')
		WHERE message.is_bot = 0 AND json_extract(message.media, '$.kind') = 'sticker'
		AND COALESCE(media.sticker_set, '') NOT IN (SELECT value FROM json_each(?3))
		AND EXISTS (SELECT 1 FROM media_file_ids mapping WHERE mapping.file_unique_id = media.file_unique_id)
		ORDER BY message.date, message.message_id`)
		.all(chatId, JSON.stringify([...new Set(messageIds)]), JSON.stringify(catalogSets)) as unknown as (CatalogRow & {
		rowid: number;
		file_unique_id: string;
	})[];
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const row of rows) {
		if (seen.has(row.file_unique_id) || lines.length >= CONTEXT_STICKER_CANDIDATE_MAX) continue;
		seen.add(row.file_unique_id);
		if (!row.short_id) {
			assignStickerShortId(db, row.file_unique_id);
			row.short_id = `s${row.rowid}`;
		}
		lines.push(stickerLine(row));
	}
	return lines.length ? `${SYSTEM_NOTE_LABEL}这批消息里出现了你也能发送的 sticker：\n${lines.join("\n")}` : "";
}
/** Immutable metadata becomes a positional request-only note; native compaction never sees it. */
export function projectStickerNotes(messages: readonly Message[], entries: readonly EntryRecord[]): Message[] {
	const notes = new Map<string, string[]>();
	const key = (message: Message) => `${message.timestamp}\0${contentText(message.content)}`;
	for (const entry of entries) {
		const note =
			entry.kind === "telegram.input" ? ((entry.data as { stickerNote?: string } | undefined)?.stickerNote ?? "") : "";
		for (const message of entry.model ?? []) {
			if (message.role !== "user") continue;
			const id = key(message);
			const queue = notes.get(id) ?? [];
			queue.push(note);
			notes.set(id, queue);
		}
	}
	return messages.flatMap((message) => {
		const note = message.role === "user" ? notes.get(key(message))?.shift() : undefined;
		return note ? [message, { role: "user", content: note, timestamp: message.timestamp }] : [message];
	});
}
