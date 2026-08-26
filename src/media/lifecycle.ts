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
	 WHERE json_extract(message.media, '$.file_unique_id') = media.file_unique_id
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
	            CAST((
	              SELECT state.value
	                FROM daemon_state state
	               WHERE state.key = 'message_events_backfill_max_seq'
	            ) AS INTEGER),
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
 * Derived context images (media.context_files) are removed together with their source file.
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
		const derived = parseContextFileNames(row.contextFiles);
		const path = row.localPath ? resolveMediaSourcePath(mediaDir, row.localPath) : null;
		if (row.localPath && !path) {
			// Clear the DB refs only after every derived file is actually gone; otherwise keep
			// context_files so a later compaction retries the removal instead of orphaning files.
			if (removeDerived(mediaDir, derived, remove, result)) clear.run(row.fileUniqueId, row.localPath);
			result.stale++;
			continue;
		}
		try {
			if (path) {
				const outcome = remove(path);
				if (outcome === "deleted") result.deleted++;
				else result.stale++;
			}
			if (removeDerived(mediaDir, derived, remove, result)) clear.run(row.fileUniqueId, row.localPath);
		} catch {
			result.failed++;
		}
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

/** Returns true only when every derived file is gone (missing files count as gone). */
function removeDerived(
	mediaDir: string,
	names: readonly string[],
	remove: NonNullable<MediaPruneOptions["remove"]>,
	result: MediaPruneResult,
): boolean {
	let allGone = true;
	for (const name of names) {
		try {
			remove(join(mediaDir, name));
		} catch {
			result.failed++;
			allGone = false;
		}
	}
	return allGone;
}
