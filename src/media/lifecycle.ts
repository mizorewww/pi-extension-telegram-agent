import type { Database } from "../db/db.ts";
import { unlinkSync } from "node:fs";
import { resolveMediaSourcePath } from "./local-cache.ts";

export const MEDIA_PRUNE_BATCH_LIMIT = 256;
export interface MediaPruneResult {
	scanned: number;
	deleted: number;
	stale: number;
	failed: number;
}
/** Pi stores image bytes. Source files are disposable after seven days without a new message. */
export function pruneMediaCache(db: Database, mediaDir: string, now = Date.now()): MediaPruneResult {
	const rows = db
		.prepare(`SELECT file_unique_id AS id, local_path AS path FROM media
		WHERE local_path IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM messages WHERE CAST(json_extract(messages.media, '$.file_unique_id') AS TEXT) = media.file_unique_id AND date > ?
		) ORDER BY rowid LIMIT ?`)
		.all(Math.floor(now / 1000) - 7 * 86400, MEDIA_PRUNE_BATCH_LIMIT) as { id: string; path: string }[];
	const result: MediaPruneResult = { scanned: rows.length, deleted: 0, stale: 0, failed: 0 };
	for (const row of rows) {
		const path = resolveMediaSourcePath(mediaDir, row.path);
		try {
			if (path) {
				unlinkSync(path);
				result.deleted++;
			} else result.stale++;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") result.stale++;
			else result.failed++;
		}
		db.prepare("UPDATE media SET local_path = NULL WHERE file_unique_id = ? AND local_path = ?").run(row.id, row.path);
	}
	return result;
}
