import type { RetentionConfig } from "../config.ts";
import { type Database, transaction } from "./db.ts";

const DAY_MS = 86_400_000;
const BATCH_SIZE = 1024;

export type RetentionResult = {
	rawUpdates: number;
	messageEvents: number;
};

/** Pi owns admitted input. The caller supplies the minimum admitted sequence across configured bots. */
export function applyRetention(
	db: Database,
	config: RetentionConfig,
	admittedThrough: number,
	now = Date.now(),
): RetentionResult {
	const rawCutoffSec = Math.floor((now - config.rawUpdateDays * DAY_MS) / 1000);
	const eventCutoffSec = Math.floor((now - config.messageEventDays * DAY_MS) / 1000);
	return transaction(db, () => {
		const rawUpdates = db
			.prepare(`
			DELETE FROM raw_updates WHERE rowid IN (
				SELECT r.rowid FROM raw_updates r WHERE r.received_at < ?
				AND NOT EXISTS (SELECT 1 FROM pending_telegram_dispatch p
					WHERE p.bot_id = r.bot_id AND p.update_id = r.update_id)
				ORDER BY r.received_at LIMIT ?
			)
		`)
			.run(rawCutoffSec, BATCH_SIZE).changes;
		const messageEvents = db
			.prepare(`
			DELETE FROM message_events WHERE ingest_seq IN (
				SELECT e.ingest_seq FROM message_events e
				WHERE e.event_date < ? AND e.ingest_seq <= ?
				AND NOT EXISTS (SELECT 1 FROM pending_telegram_dispatch p
					WHERE p.chat_id = e.chat_id AND p.message_id = e.message_id)
				ORDER BY e.ingest_seq LIMIT ?
			)
		`)
			.run(eventCutoffSec, admittedThrough, BATCH_SIZE).changes;
		return { rawUpdates: Number(rawUpdates), messageEvents: Number(messageEvents) };
	});
}
