import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db/db.ts";
import { applyRetention } from "../src/db/retention.ts";
import { TelegramControlCommandService, consumedControlMessageIds } from "../src/telegram/control-command.ts";
let db: Database;
const chatId = -100123;
beforeEach(() => {
	db = openDb(":memory:");
});
afterEach(() => db.close());

test("telemetry retention cannot erase durable control exclusion", () => {
	new TelegramControlCommandService(db, [], "/unused", new Map(), []).consumeReply("A", chatId, 10);
	db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('A', 1, 'thinking', '{}')").run();
	applyRetention(db, { telemetryDays: 1, rawUpdateDays: 1, messageEventDays: 1 }, 10 * 86400000);
	expect(consumedControlMessageIds(db, chatId).has(10)).toBe(true);
	expect(db.query("SELECT COUNT(*) n FROM agent_events WHERE kind='thinking'").get()).toEqual({ n: 0 });
});
