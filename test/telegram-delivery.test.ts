import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db/db.ts";
import { buildDebugReport } from "../src/observability/debug-report.ts";
import { applyRetention } from "../src/db/retention.ts";
import { routeMessageDecision } from "../src/agent/router.ts";
import type { MessageRow } from "../src/agent/serialize.ts";
import { ingestUpdate } from "../src/telegram/ingest.ts";
import { ManualSendService } from "../src/daemon/manual-send.ts";
import { TelegramControlCommandService, consumedControlMessageIds } from "../src/telegram/control-command.ts";

let db: Database;
const chatId = -100123;
const bots = [
	{ id: "A", userId: 10, username: "alpha_bot", name: "Alpha" },
	{ id: "B", userId: 20, username: "beta_bot", name: "Beta" },
];
const message = {
	chat: { id: chatId },
	message_id: 1,
	date: 100,
	from: { id: 42, first_name: "Human" },
	text: "original",
};
beforeEach(() => {
	db = openDb(":memory:");
});
afterEach(() => db.close());

test("all mentions outrank replies regardless of bot ordering, including captions", () => {
	for (const caption of [false, true]) {
		const addressed = {
			...message,
			text: caption ? undefined : "@beta_bot hello",
			caption: caption ? "@beta_bot hello" : undefined,
			[caption ? "caption_entities" : "entities"]: [{ type: "mention", offset: 0, length: 9 }],
			reply_to_message: { message_id: 99, from: { id: 10 } },
		};
		ingestUpdate(db, "A", { update_id: caption ? 2 : 1, message: { ...addressed, message_id: caption ? 2 : 1 } }, 123);
		const row = db.query("SELECT * FROM messages WHERE message_id = ?").get(caption ? 2 : 1) as MessageRow;
		for (const order of [bots, [...bots].reverse()]) {
			expect(routeMessageDecision(db, row, order, { secret: "test", probs: [0, 0] })).toMatchObject({
				target: "B",
				reason: "explicit",
			});
		}
	}
});

test("older edits from a delayed poller cannot roll canonical or event history backward", () => {
	ingestUpdate(db, "A", { update_id: 1, message }, 123);
	ingestUpdate(db, "A", { update_id: 2, edited_message: { ...message, text: "new", edit_date: 300 } }, 123);
	const before = db.query("SELECT COUNT(*) n FROM message_events").get();
	expect(
		ingestUpdate(db, "B", { update_id: 3, edited_message: { ...message, text: "old", edit_date: 200 } }, 123).kind,
	).toBe("duplicate");
	expect(db.query("SELECT text, edit_date FROM messages").get()).toEqual({ text: "new", edit_date: 300 });
	expect(db.query("SELECT COUNT(*) n FROM message_events").get()).toEqual(before);
});

test("operator timeouts remain unknown outcomes and request replay never repeats the create", async () => {
	let creates = 0;
	const service = new ManualSendService(
		db,
		chatId,
		new Map([
			[
				"A",
				{
					sendMessage: async () => {
						creates++;
						throw new DOMException("timeout", "TimeoutError");
					},
				},
			],
		]),
	);
	const input = { type: "send_message" as const, requestId: "request-1", botId: "A", text: "hello" };
	expect(await service.send(input)).toMatchObject({ ok: false, code: "unknown_outcome" });
	expect(await service.send(input)).toMatchObject({ ok: false, code: "unknown_outcome" });
	expect(creates).toBe(1);
});

test("telemetry retention cannot erase durable control exclusion", () => {
	new TelegramControlCommandService(db, [], "/unused", new Map(), []).consumeReply("A", chatId, 10);
	db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('A', 1, 'thinking', '{}')").run();
	applyRetention(db, { telemetryDays: 1, rawUpdateDays: 1, messageEventDays: 1 }, 10 * 86400000);
	expect(consumedControlMessageIds(db, chatId).has(10)).toBe(true);
	expect(db.query("SELECT COUNT(*) n FROM agent_events WHERE kind='thinking'").get()).toEqual({ n: 0 });
});

test("routing handoff survives a failed handler and restart before another Telegram poll", async () => {
	const { Poller } = await import("../src/telegram/poller.ts");
	let attempts = 0;
	const first = new Poller(db, "A", "unused", 123, async () => {
		attempts++;
		first.stop();
		throw new Error("route storage unavailable");
	});
	(first as any).api = {
		getUpdates: async () => [
			{
				update_id: 50,
				message: { ...message, text: "@beta_bot", entities: [{ type: "mention", offset: 0, length: 9 }] },
			},
		],
	};
	await first.run();
	const pendingReport = buildDebugReport(db, { botIds: ["A"], chatId, sinceMs: 86400000 });
	expect(pendingReport.bots[0]?.pending_dispatch).toEqual({ update_id: 50, message_id: 1, kind: "inserted" });
	expect(JSON.stringify(pendingReport)).not.toContain("@beta_bot");
	// A different delivery can advance the runtime cursor while this handoff is still pending.
	db.query("INSERT INTO bot_cursors (bot_id, chat_id, consumed_seq, updated_at) VALUES ('A', ?, 999, 0)").run(chatId);
	// Retention must preserve both the raw source and the event needed by the eventual obligation.
	applyRetention(db, { telemetryDays: 1, rawUpdateDays: 1, messageEventDays: 1 }, Date.now() + 2 * 86400000);
	expect(db.query("SELECT COUNT(*) n FROM message_events WHERE message_id = 1").get()).toEqual({ n: 1 });
	let delivered: unknown;
	const second = new Poller(db, "A", "unused", 123, async (result, update) => {
		attempts++;
		delivered = { result, update };
		second.stop();
	});
	(second as any).api = {
		getUpdates: async () => {
			second.stop();
			return [];
		},
	};
	await second.run();
	expect(buildDebugReport(db, { botIds: ["A"], chatId, sinceMs: 86400000 }).bots[0]?.pending_dispatch).toBeNull();
	expect(attempts).toBe(2);
	expect(delivered).toMatchObject({ result: { kind: "inserted", messageId: 1 }, update: { update_id: 50 } });
});
