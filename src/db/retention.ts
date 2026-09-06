import type { Database } from "bun:sqlite";
import type { RetentionConfig } from "../config.ts";

const DAY_MS = 86_400_000;

export interface RetentionResult {
	agentEvents: number;
	llmRuns: number;
	rawUpdates: number;
	messageEvents: number;
}

/**
 * Apply bounded local retention. Provider events are removed only after every known bot cursor
 * for the chat consumed them, and never while a direct-reply obligation still references them.
 */
export function applyRetention(db: Database, config: RetentionConfig, now = Date.now()): RetentionResult {
	const telemetryCutoffMs = now - config.telemetryDays * DAY_MS;
	const rawCutoffSec = Math.floor((now - config.rawUpdateDays * DAY_MS) / 1000);
	const eventCutoffSec = Math.floor((now - config.messageEventDays * DAY_MS) / 1000);
	const prune = db.transaction((): RetentionResult => {
		const agentEvents = db.query("DELETE FROM agent_events WHERE ts < ?").run(telemetryCutoffMs).changes;
		const llmRuns = db.query("DELETE FROM llm_runs WHERE ts < ?").run(telemetryCutoffMs).changes;
		const rawUpdates = db
			.query(
				"DELETE FROM raw_updates WHERE received_at < ? AND NOT EXISTS (SELECT 1 FROM pending_telegram_dispatch p WHERE p.bot_id = raw_updates.bot_id AND p.update_id = raw_updates.update_id)",
			)
			.run(rawCutoffSec).changes;
		const messageEvents = db
			.query(`
			DELETE FROM message_events
			 WHERE event_date < ?
			   AND EXISTS (
			     SELECT 1 FROM bot_cursors c
			      WHERE c.chat_id = message_events.chat_id
			   )
			   AND ingest_seq <= (
			     SELECT MIN(c.consumed_seq) FROM bot_cursors c
			      WHERE c.chat_id = message_events.chat_id
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM pending_telegram_dispatch p
			      WHERE p.chat_id = message_events.chat_id
			        AND p.message_id = message_events.message_id
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM reply_obligations o
			      WHERE o.chat_id = message_events.chat_id
			        AND o.message_id = message_events.message_id
			   )
		`)
			.run(eventCutoffSec).changes;
		return { agentEvents, llmRuns, rawUpdates, messageEvents };
	});
	return prune();
}
