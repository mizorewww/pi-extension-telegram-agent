import type { DatabaseSync as Database } from "node:sqlite";

/** Retained, billed facts across sessions; Pi owns the current session's statistics. */
export function loadBotStats(db: Database, botId: string) {
	return db
		.prepare(`SELECT COUNT(*) runs, MIN(ts) since,
		COALESCE(SUM(context_tokens), 0) prompt,
		COALESCE(SUM(output_tokens), 0) output,
		COALESCE(SUM(COALESCE(cache_read_estimated, cache_read)), 0) cacheRead,
		COALESCE(SUM(cache_write), 0) cacheWrite,
		COUNT(cache_read_estimated) estimated,
		COALESCE(SUM(cost), 0) cost
		FROM llm_runs WHERE bot_id = ?`)
		.get(botId) as {
		runs: number;
		since: number | null;
		prompt: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		estimated: number;
		cost: number;
	};
}
