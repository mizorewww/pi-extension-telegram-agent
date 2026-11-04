import type { DatabaseSync as Database } from "node:sqlite";
import type { LogRecord } from "./log.ts";
import { getConsumedSeq, messageEventHighWater } from "../db/message-events.ts";
import { replyObligationCount } from "../db/reply-obligations.ts";
import { loadBotStats } from "../db/usage.ts";

/** Bounded facts, without provider reconstruction or heuristic diagnoses. */
export function buildDebugReport(
	db: Database,
	input: {
		botIds: readonly string[];
		chatId: number;
		sinceMs: number;
		now?: number;
		logs?: readonly LogRecord[];
		daemon?: { pid: number | null; alive: boolean };
	},
) {
	const now = input.now ?? Date.now();
	const since = now - input.sinceMs;
	return {
		schema: 2,
		generated_at: new Date(now).toISOString(),
		window_ms: input.sinceMs,
		daemon: input.daemon ?? null,
		bots: input.botIds.map((botId) => ({
			bot_id: botId,
			context: {
				consumed_seq: getConsumedSeq(db, botId, input.chatId),
				high_water: messageEventHighWater(db, input.chatId),
				pending_reply_obligations: replyObligationCount(db, botId, input.chatId),
			},
			pending_dispatch: db
				.prepare("SELECT update_id, message_id, kind FROM pending_telegram_dispatch WHERE bot_id = ?")
				.get(botId),
			usage: loadBotStats(db, botId),
			claims: db
				.prepare(`SELECT message_id, reason, status, updated_at FROM routing_claims
				WHERE bot_id = ? AND chat_id = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT 20`)
				.all(botId, input.chatId, since),
			runs: db
				.prepare(`SELECT ts, model, epoch, compaction, context_tokens, output_tokens,
				cache_read, cache_write, cache_read_estimated, cost FROM llm_runs
				WHERE bot_id = ? AND ts >= ? ORDER BY id DESC LIMIT 20`)
				.all(botId, since),
			events: db
				.prepare(`SELECT ts, kind FROM agent_events WHERE bot_id = ? AND ts >= ? ORDER BY id DESC LIMIT 50`)
				.all(botId, since),
			logs: (input.logs ?? [])
				.filter(
					(record) =>
						Date.parse(record.ts) >= since && (record.fields?.bot_id == null || record.fields.bot_id === botId),
				)
				.slice(-100),
		})),
	};
}

export function parseDebugDuration(input: string): number | null {
	const match = /^(\d+)(s|m|h|d)$/.exec(input.trim().toLowerCase());
	if (!match) return null;
	const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
	const value = Number(match[1]) * unit;
	return Number.isSafeInteger(value) && value >= 1_000 && value <= 7 * 86_400_000 ? value : null;
}
