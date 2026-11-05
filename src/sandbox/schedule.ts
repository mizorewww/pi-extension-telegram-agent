// Weekly work-box reset: every box is wiped once after each Monday 05:00 (process local time,
// Asia/Singapore in production). The last reset time is durable, so a daemon that was down at
// the boundary resets on its next check and a restart never resets twice.

import type { Database } from "../db/db.ts";
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
	/** A box with running tasks waits for the next check. */
	busy?(): boolean | Promise<boolean>;
	resetBox(reason: "weekly"): Promise<void>;
}

const KEY = "box_reset_at";

/** One check: reset the box when its last reset predates the latest boundary. */
export async function runWeeklyBoxReset(db: Database, box: ResettableBox, now = new Date()): Promise<void> {
	const boundary = lastWeeklyBoundary(now).getTime();
	const last = Number(getDaemonState(db, KEY) ?? "NaN");
	if (!Number.isFinite(last)) {
		// First sight of this box: start the weekly clock now instead of wiping it.
		setDaemonState(db, KEY, String(now.getTime()));
		return;
	}
	if (last >= boundary || (await box.busy?.())) return;
	try {
		await box.resetBox("weekly");
		setDaemonState(db, KEY, String(now.getTime()));
	} catch {
		log.warn("sandbox", "weekly_reset_failed", { category: "local_failure" });
	}
}
