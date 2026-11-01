// Weekly work-box reset: every box is wiped once after each Monday 05:00 (process local time,
// Asia/Singapore in production). The last reset time is durable, so a daemon that was down at
// the boundary resets on its next check and a restart never resets twice.

import type { Database } from "bun:sqlite";
import { getDaemonState, setDaemonState } from "../db/db.ts";
import { log } from "../observability/log.ts";

export const BOX_RESET_CHECK_MS = 10 * 60_000;
const RESET_WEEKDAY = 1; // Monday
const RESET_HOUR = 5;

/** The most recent Monday 05:00 local time at or before `now`. */
export function lastWeeklyBoundary(now: Date): Date {
	const boundary = new Date(now);
	boundary.setHours(RESET_HOUR, 0, 0, 0);
	const daysBack = (boundary.getDay() - RESET_WEEKDAY + 7) % 7;
	boundary.setDate(boundary.getDate() - daysBack);
	if (boundary > now) boundary.setDate(boundary.getDate() - 7);
	return boundary;
}

export interface ResettableBox {
	readonly botId: string;
	resetBox(reason: "weekly"): Promise<void>;
}

/** One check: reset each box whose last reset predates the latest boundary. */
export async function runWeeklyBoxReset(
	db: Database,
	boxes: readonly ResettableBox[],
	now = new Date(),
): Promise<void> {
	const boundary = lastWeeklyBoundary(now).getTime();
	for (const box of boxes) {
		const key = `box_reset_at:${box.botId}`;
		const last = Number(getDaemonState(db, key) ?? "NaN");
		if (!Number.isFinite(last)) {
			// First sight of this box: start the weekly clock now instead of wiping it.
			setDaemonState(db, key, String(now.getTime()));
			continue;
		}
		if (last >= boundary) continue;
		try {
			await box.resetBox("weekly");
			setDaemonState(db, key, String(now.getTime()));
		} catch {
			log.warn("sandbox", "weekly_reset_failed", { bot_id: box.botId });
		}
	}
}
