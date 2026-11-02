import type { Database } from "bun:sqlite";
import type { BotStats, UsageRun } from "../observability/usage.ts";

interface LastRunRow extends Omit<UsageRun, "cacheEstimated"> {
	cacheEstimated: number;
	systemTokens: number;
	toolsTokens: number;
	compactedHistoryTokens: number;
	messageTokens: number;
}

/** One bot's retention-window totals plus its latest main-conversation provider response. */
export function loadBotStats(db: Database, botId: string): BotStats {
	const aggregate = db
		.query(
			`SELECT COUNT(*) runs,
			        COALESCE(SUM(context_tokens), 0) contextTokens,
			        COALESCE(SUM(COALESCE(cache_read_estimated, cache_read)), 0) cacheRead,
			        COALESCE(SUM(cache_write), 0) cacheWrite,
			        COALESCE(SUM(CASE WHEN cache_read_estimated IS NOT NULL
			                          THEN context_tokens - cache_read_estimated - cache_write
			                          ELSE cache_miss END), 0) cacheMiss,
			        COUNT(cache_read_estimated) estimatedCacheRuns,
			        COALESCE(SUM(output_tokens), 0) outputTokens,
			        COALESCE(SUM(CASE WHEN compaction = 0 THEN output_tokens ELSE 0 END), 0) speedOutputTokens,
			        COALESCE(SUM(reasoning_tokens), 0) reasoningTokens,
			        COALESCE(SUM(latency_ms), 0) totalLatencyMs,
			        COUNT(latency_ms) latencySamples,
			        COALESCE(SUM(CASE WHEN compaction = 0 THEN thinking_ms ELSE 0 END), 0) totalThinkingMs,
			        COALESCE(SUM(CASE WHEN compaction = 0 THEN 1 ELSE 0 END), 0) thinkingSamples,
			        COALESCE(SUM(send_ms), 0) totalSendMs,
			        COALESCE(SUM(send_samples), 0) sendSamples,
			        MIN(ts) firstRunTs,
			        COALESCE(SUM(cost), 0) cost,
			        COALESCE(MAX(epoch), 0) epoch,
			        COALESCE(MAX(id), 0) lastRunId
			   FROM llm_runs WHERE bot_id = ?`,
		)
		.get(botId) as Omit<BotStats, "last">;
	const lastRow = db
		.query(
			`SELECT id, bot_id botId, ts, model, epoch, context_tokens contextTokens,
			        COALESCE(cache_read_estimated, cache_read) cacheRead, cache_write cacheWrite,
			        CASE WHEN cache_read_estimated IS NOT NULL
			             THEN context_tokens - cache_read_estimated - cache_write
			             ELSE cache_miss END cacheMiss,
			        cache_read_estimated IS NOT NULL cacheEstimated,
			        output_tokens outputTokens, reasoning_tokens reasoningTokens,
			        latency_ms latencyMs, thinking_ms thinkingMs, send_ms sendMs, send_samples sendSamples,
			        system_tokens systemTokens, tools_tokens toolsTokens,
			        compacted_history_tokens compactedHistoryTokens, message_tokens messageTokens, cost
			   FROM llm_runs
			  WHERE bot_id = ? AND compaction = 0
			  ORDER BY ts DESC, id DESC LIMIT 1`,
		)
		.get(botId) as LastRunRow | null;
	const breakdown = lastRow
		? {
				system: lastRow.systemTokens,
				tools: lastRow.toolsTokens,
				compactedHistory: lastRow.compactedHistoryTokens,
				messages: lastRow.messageTokens,
			}
		: null;
	const last = lastRow
		? {
				...lastRow,
				cacheEstimated: lastRow.cacheEstimated === 1,
				...(breakdown && Object.values(breakdown).some((value) => value > 0) ? { contextBreakdown: breakdown } : {}),
			}
		: null;
	return { ...aggregate, last };
}
