import { type Database, getDaemonState } from "../db/db.ts";
import { messageEventHighWater } from "../db/message-events.ts";
import type { LogRecord } from "./log.ts";

/** Read-only archive/routing facts. Pi runtime status is queried through the live /status command. */
export function buildDebugReport(
	db: Database,
	input: {
		chatId: number;
		sinceMs: number;
		now?: number;
		logs?: readonly LogRecord[];
	},
) {
	const now = input.now ?? Date.now();
	const since = now - input.sinceMs;
	return {
		schema: 4,
		generated_at: new Date(now).toISOString(),
		window_ms: input.sinceMs,
		archive: { chat_id: input.chatId, high_water: messageEventHighWater(db, input.chatId) },
		poll_offset: Number(getDaemonState(db, "update_offset") ?? "0"),
		pending_dispatch: db.prepare("SELECT update_id, message_id, kind FROM pending_telegram_dispatch").get() ?? null,
		logs: (input.logs ?? []).filter((record) => Date.parse(record.ts) >= since).slice(-100),
	};
}

export function parseDebugDuration(input: string): number | null {
	const match = /^(\d+)(s|m|h|d)$/.exec(input.trim().toLowerCase());
	if (!match) return null;
	const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
	const value = Number(match[1]) * unit;
	return Number.isSafeInteger(value) && value >= 1_000 && value <= 7 * 86_400_000 ? value : null;
}
