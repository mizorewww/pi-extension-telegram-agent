// Fixed sticker catalog per bot (REQ-STICKER-0001).
// Each bot can configure Telegram sticker set names; at startup the sets are fetched, media
// identity + per-bot file_id persisted, and short_ids assigned from rowids. Catalog and recent
// candidates share one line grammar — `s12: 😺 描述`, degrading to `s12: 😺` then `s12` — where
// the description is the persisted vision text (media.vision JSON `text`, whitespace-collapsed,
// ≤60 chars). Set names never appear in model-visible text (cache schema v17). The catalog block
// sits in the stable system prompt, so the prefix is determined by config + DB catalog, and the
// snapshot hash covers description text so a landing description starts a new epoch. Recent
// visible user stickers are a separate bounded dynamic tail (cache schema v11).

import type { Database } from "bun:sqlite";
import { errorCategory, log } from "../observability/log.ts";
import { createHash } from "node:crypto";
import type { BotApi } from "../telegram/api.ts";

export const STICKER_CATALOG_MAX = 120; // bounded local inventory and startup work
export const CONTEXT_STICKER_CANDIDATE_MAX = 8;
const CONTEXT_STICKER_SCAN_MAX = 64;

export interface CatalogSticker {
	file_unique_id: string;
	file_id: string;
	emoji: string | null;
	width?: number;
	height?: number;
	mime: StickerMime;
}

export type StickerMime = "image/webp" | "application/x-tgsticker" | "video/webm";

function stickerMime(sticker: { is_animated?: boolean; is_video?: boolean }): StickerMime {
	if (sticker.is_video) return "video/webm";
	if (sticker.is_animated) return "application/x-tgsticker";
	return "image/webp";
}

/** Fetch one Telegram sticker set (public sets work for any bot token). */
export async function fetchStickerSet(api: BotApi, setName: string): Promise<CatalogSticker[]> {
	const result = await api.call<{
		name: string;
		title: string;
		stickers: {
			file_id: string;
			file_unique_id: string;
			emoji?: string;
			width?: number;
			height?: number;
			is_animated?: boolean;
			is_video?: boolean;
		}[];
	}>("getStickerSet", { name: setName });
	return result.stickers.map((s) => ({
		file_unique_id: s.file_unique_id,
		file_id: s.file_id,
		emoji: s.emoji ?? null,
		width: s.width,
		height: s.height,
		mime: stickerMime(s),
	}));
}

/**
 * Load the catalog for one bot: persist media identity + per-bot file_id, assign short_ids.
 * A failed set (bad name / network) logs and is skipped — startup must not be blocked.
 */
export async function ensureStickerCatalog(
	db: Database,
	api: BotApi,
	botId: string,
	sets: string[],
): Promise<{ total: number; sendable: number; missingMapping: number; truncated: boolean }> {
	let total = 0;
	let truncated = false;
	for (const setName of sets) {
		if (total >= STICKER_CATALOG_MAX) {
			truncated = true;
			break;
		}
		let stickers: CatalogSticker[];
		try {
			stickers = await fetchStickerSet(api, setName);
		} catch (err) {
			log.error("sticker_catalog", "set_fetch_failed", {
				bot_id: botId,
				set_name: setName,
				category: errorCategory(err),
			});
			continue;
		}
		for (const s of stickers) {
			if (total >= STICKER_CATALOG_MAX) {
				truncated = true;
				break;
			}
			db.query(
				`INSERT INTO media (file_unique_id, kind, mime, sticker_set, sticker_emoji, width, height)
				 VALUES (?, 'sticker', ?, ?, ?, ?, ?)
				 ON CONFLICT(file_unique_id) DO UPDATE SET
				   mime = excluded.mime,
				   sticker_set = COALESCE(excluded.sticker_set, media.sticker_set),
				   sticker_emoji = COALESCE(excluded.sticker_emoji, media.sticker_emoji),
				   width = COALESCE(excluded.width, media.width),
				   height = COALESCE(excluded.height, media.height)`,
			).run(s.file_unique_id, s.mime, setName, s.emoji, s.width ?? null, s.height ?? null);
			db.query("INSERT OR IGNORE INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES (?, ?, ?)").run(
				botId,
				s.file_id,
				s.file_unique_id,
			);
			// short_id from rowid: stable, unique, race-free
			const row = db.query("SELECT rowid FROM media WHERE file_unique_id = ?").get(s.file_unique_id) as {
				rowid: number;
			} | null;
			if (row) {
				db.query("UPDATE media SET short_id = ? WHERE file_unique_id = ? AND short_id IS NULL").run(
					`s${row.rowid}`,
					s.file_unique_id,
				);
			}
			total++;
		}
	}
	if (truncated) {
		log.warn("sticker_catalog", "catalog_truncated", { bot_id: botId, limit: STICKER_CATALOG_MAX });
	}
	const counts = db
		.query(
			`SELECT
			   COUNT(*) AS catalog_rows,
			   SUM(CASE WHEN EXISTS (
			     SELECT 1 FROM media_file_ids f
			      WHERE f.bot_id = ? AND f.file_unique_id = media.file_unique_id
			   ) THEN 1 ELSE 0 END) AS sendable
			 FROM media
			 WHERE kind = 'sticker' AND sticker_set IN (SELECT value FROM json_each(?))`,
		)
		.get(botId, JSON.stringify(sets)) as { catalog_rows: number; sendable: number | null };
	const sendable = counts.sendable ?? 0;
	const missingMapping = counts.catalog_rows - sendable;
	log.info("sticker_catalog", "catalog_ready", {
		bot_id: botId,
		fetched: total,
		catalog: counts.catalog_rows,
		sendable,
		missing_file_id: missingMapping,
	});
	if (missingMapping > 0) {
		log.warn("sticker_catalog", "mapping_incomplete", {
			bot_id: botId,
			catalog: counts.catalog_rows,
			sendable,
			missing_file_id: missingMapping,
		});
	}
	return { total, sendable, missingMapping, truncated };
}

interface CatalogRow {
	sticker_emoji: string | null;
	vision: string | null;
	short_id: string;
}

/** Sendable catalog stickers for this bot in its configured sets, deterministically ordered. */
function catalogRows(db: Database, botId: string, sets: readonly string[]): CatalogRow[] {
	return db
		.query(`
		SELECT sticker_emoji, vision, short_id
		  FROM media m
		 WHERE kind = 'sticker' AND short_id IS NOT NULL
		   AND sticker_set IN (SELECT value FROM json_each(?))
		   AND EXISTS (
		     SELECT 1 FROM media_file_ids f
		      WHERE f.bot_id = ? AND f.file_unique_id = m.file_unique_id
		   )
		 ORDER BY sticker_set, rowid
	`)
		.all(JSON.stringify([...sets]), botId) as CatalogRow[];
}

/**
 * Catalog block for the stable system prompt: one `s<id>: <emoji> <描述>` line per sticker
 * (shared line grammar with the recent-candidate tail). Deterministic for a given config + DB
 * catalog, so the prefix stays stable across restarts; a newly persisted description changes the
 * snapshot hash and starts a new epoch. Empty string when the bot has no sendable catalog
 * stickers. Sending rules live in the send tool description, not here.
 */
export function stickerCatalogPromptBlock(db: Database, botId: string, sets: readonly string[]): string {
	const rows = catalogRows(db, botId, sets);
	if (rows.length === 0) return "";
	const lines = rows.map((row) => stickerLine(row.short_id, row.sticker_emoji, stickerDescription(row.vision)));
	return `# Sticker 目录\n\n${lines.join("\n")}`;
}

interface ContextStickerRow {
	rowid: number;
	file_unique_id: string;
	short_id: string | null;
	sticker_emoji: string | null;
	vision: string | null;
}

/** Persisted vision description, whitespace-collapsed and bounded; empty when none exists. */
function stickerDescription(vision: string | null): string {
	if (vision) {
		try {
			const text = (JSON.parse(vision) as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) return text.replace(/\s+/g, " ").trim().slice(0, 60);
		} catch {
			// A malformed historical vision cache does not hide an otherwise sendable sticker.
		}
	}
	return "";
}

/** Shared line grammar: `s12: 😺 描述`, degrading to `s12: 😺` (no description) then `s12`. */
function stickerLine(shortId: string, emoji: string | null, description: string): string {
	const parts = [emoji, description].filter((part) => part);
	return parts.length > 0 ? `${shortId}: ${parts.join(" ")}` : shortId;
}

/**
 * The newest distinct user stickers genuinely present in this bot's current context generation.
 * Candidates are bot-sendable, bounded, and assigned the global s<media.rowid> identity lazily
 * for historical rows created before ingest assigned sticker short ids.
 */
export function recentContextStickerCandidates(
	db: Database,
	botId: string,
	chatId: number,
	epoch: number,
	newlyVisibleMessageIds: readonly number[],
	limit = CONTEXT_STICKER_CANDIDATE_MAX,
): string {
	const boundedLimit = Math.min(CONTEXT_STICKER_CANDIDATE_MAX, Math.max(0, Math.floor(limit)));
	if (boundedLimit === 0) return "";
	const rows = db
		.query(`
			WITH visible(message_id) AS (
				SELECT message_id
				  FROM bot_visible_messages
				 WHERE bot_id = ?1 AND chat_id = ?2 AND context_epoch = ?3
				UNION
				SELECT CAST(value AS INTEGER) FROM json_each(?4)
			)
			SELECT media.rowid, media.file_unique_id, media.short_id,
			       media.sticker_emoji, media.vision
			  FROM visible
			  JOIN messages message
			    ON message.chat_id = ?2 AND message.message_id = visible.message_id
			  JOIN media
			    ON media.file_unique_id = json_extract(message.media, '$.file_unique_id')
			 WHERE message.is_bot = 0
			   AND json_extract(message.media, '$.kind') = 'sticker'
			   AND EXISTS (
			     SELECT 1 FROM media_file_ids mapping
			      WHERE mapping.bot_id = ?1 AND mapping.file_unique_id = media.file_unique_id
			   )
			 ORDER BY message.date DESC, message.message_id DESC
			 LIMIT ?5
		`)
		.all(
			botId,
			chatId,
			epoch,
			JSON.stringify([...new Set(newlyVisibleMessageIds)]),
			CONTEXT_STICKER_SCAN_MAX,
		) as ContextStickerRow[];
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const row of rows) {
		if (seen.has(row.file_unique_id)) continue;
		seen.add(row.file_unique_id);
		const shortId = row.short_id ?? `s${row.rowid}`;
		if (!row.short_id) {
			db.query("UPDATE media SET short_id = ? WHERE file_unique_id = ? AND short_id IS NULL").run(
				shortId,
				row.file_unique_id,
			);
		}
		lines.push(stickerLine(shortId, row.sticker_emoji, stickerDescription(row.vision)));
		if (lines.length >= boundedLimit) break;
	}
	return lines.length > 0 ? `可发 sticker（近期上下文）：\n${lines.join("\n")}` : "";
}

/** Keep dynamic candidates after every serialized message/delta so the preceding cache prefix is untouched. */
export function appendStickerCandidateSuffix(providerText: string, candidateBlock: string): string {
	const block = candidateBlock.trim();
	return block ? `${providerText}\n\n${block}` : providerText;
}

/** Fingerprint the exact state that shapes the prompt block: identity plus description text. */
export function stickerCatalogSnapshotHash(db: Database, botId: string, sets: readonly string[]): string {
	const rows = catalogRows(db, botId, sets).map((row) => ({
		short_id: row.short_id,
		emoji: row.sticker_emoji,
		description: stickerDescription(row.vision),
	}));
	return createHash("sha256")
		.update(JSON.stringify({ sets: [...sets], rows }))
		.digest("hex");
}
