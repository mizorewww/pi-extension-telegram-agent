import type { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveMediaSourcePath } from "./local-cache.ts";

export const MEDIA_PRUNE_BATCH_LIMIT = 256;

export interface MediaPruneResult {
	scanned: number;
	deleted: number;
	stale: number;
	failed: number;
}

export interface MediaPruneOptions {
	limit?: number;
	remove?: (path: string) => "deleted" | "missing";
}

const ACTIVE_MEDIA_REFERENCE_SQL = `EXISTS (
	SELECT 1
	  FROM messages message
	 WHERE message.media IS NOT NULL
       AND CAST(json_extract(message.media, '$.file_unique_id') AS TEXT) = media.file_unique_id
	   AND (
	     EXISTS (
	       SELECT 1
	         FROM bot_visible_messages visible
	         JOIN json_each(?1) configured ON configured.value = visible.bot_id
	        WHERE visible.chat_id = message.chat_id
	          AND visible.message_id = message.message_id
	     )
	     OR EXISTS (
	       SELECT 1
	         FROM reply_obligations obligation
	         JOIN json_each(?1) configured ON configured.value = obligation.bot_id
	        WHERE obligation.chat_id = message.chat_id
	          AND obligation.message_id = message.message_id
	     )
	     OR EXISTS (
	       SELECT 1
	         FROM message_events event
	         JOIN json_each(?1) configured ON TRUE
	        WHERE event.chat_id = message.chat_id
	          AND event.message_id = message.message_id
	          AND event.kind <> 'media_update'
	          AND event.ingest_seq > COALESCE(
	            (
	              SELECT cursor.consumed_seq
	                FROM bot_cursors cursor
	               WHERE cursor.bot_id = configured.value
	                 AND cursor.chat_id = event.chat_id
	            ),
	            0
	          )
	     )
	   )
)`;

function configuredBotIdsJson(configuredBotIds: readonly string[]): string | null {
	const botIds = [...new Set(configuredBotIds.filter(Boolean))];
	return botIds.length > 0 ? JSON.stringify(botIds) : null;
}

const defaultRemove: NonNullable<MediaPruneOptions["remove"]> = (path) => {
	try {
		unlinkSync(path);
		return "deleted";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw error;
	}
};

/** Return only missing static-display files that still have an active configured-bot reference. */
export function listReferencedMissingDisplayMediaIds(
	db: Database,
	configuredBotIds: readonly string[],
	limit: number,
): string[] {
	const botIdsJson = configuredBotIdsJson(configuredBotIds);
	if (!botIdsJson || limit <= 0) return [];
	return (
		db
			.query(`
				SELECT media.file_unique_id AS fileUniqueId
				  FROM media
				 WHERE media.local_path IS NULL
				   AND (
				     media.kind = 'photo'
				     OR (media.kind = 'sticker' AND COALESCE(media.mime, 'image/webp') = 'image/webp')
				   )
				   AND ${ACTIVE_MEDIA_REFERENCE_SQL}
				 ORDER BY media.rowid DESC
				 LIMIT ?2
			`)
			.all(botIdsJson, Math.max(1, Math.floor(limit))) as Array<{ fileUniqueId: string }>
	).map((row) => row.fileUniqueId);
}

/**
 * Delete a bounded batch of reproducible local media after compaction visibility is committed.
 * Derived context images (media.context_files) are removed together with their source file and
 * the DB refs are cleared for every scanned row (unlink failures are counted, never retried).
 * Canonical messages, file-id mappings, short ids and vision results remain untouched.
 */
export function pruneUnreferencedMediaCache(
	db: Database,
	mediaDir: string,
	configuredBotIds: readonly string[],
	options: MediaPruneOptions = {},
): MediaPruneResult {
	const botIdsJson = configuredBotIdsJson(configuredBotIds);
	if (!botIdsJson) return { scanned: 0, deleted: 0, stale: 0, failed: 0 };
	const limit = Math.min(MEDIA_PRUNE_BATCH_LIMIT, Math.max(1, Math.floor(options.limit ?? MEDIA_PRUNE_BATCH_LIMIT)));
	const rows = db
		.query(`
			SELECT media.file_unique_id AS fileUniqueId, media.local_path AS localPath,
			       media.context_files AS contextFiles
			  FROM media
			 WHERE (media.local_path IS NOT NULL OR media.context_files IS NOT NULL)
			   AND NOT ${ACTIVE_MEDIA_REFERENCE_SQL}
			 ORDER BY media.rowid
			 LIMIT ?2
		`)
		.all(botIdsJson, limit) as Array<{ fileUniqueId: string; localPath: string | null; contextFiles: string | null }>;
	const result: MediaPruneResult = { scanned: rows.length, deleted: 0, stale: 0, failed: 0 };
	const clear = db.query(
		"UPDATE media SET local_path = NULL, context_files = NULL WHERE file_unique_id = ? AND local_path IS ?",
	);
	const remove = options.remove ?? defaultRemove;
	for (const row of rows) {
		const path = row.localPath ? resolveMediaSourcePath(mediaDir, row.localPath) : null;
		if (path) {
			try {
				if (remove(path) === "deleted") result.deleted++;
				else result.stale++;
			} catch {
				result.failed++;
			}
		} else if (row.localPath) {
			result.stale++;
		}
		for (const name of parseContextFileNames(row.contextFiles)) {
			try {
				remove(join(mediaDir, name));
			} catch {
				result.failed++;
			}
		}
		// Refs are cleared even when an unlink failed: a file this process cannot delete would
		// otherwise sit at the head of the rowid-ordered batch on every compaction and starve the
		// rest. The leaked file is reported through `failed`; the identity stays re-downloadable.
		clear.run(row.fileUniqueId, row.localPath);
	}
	return result;
}

function parseContextFileNames(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((entry) => (entry && typeof entry === "object" ? (entry as { name?: unknown }).name : null))
			.filter((name): name is string => typeof name === "string" && name.length > 0 && !name.includes("/"));
	} catch {
		return [];
	}
}
