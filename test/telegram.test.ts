// Mentions win routing, the routing handoff is durable, and an unknown create is never repeated.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db/db.ts";
import { applyRetention } from "../src/db/retention.ts";
import { nameKeywordTrigger, routeMessageDecision } from "../src/agent/router.ts";
import type { MessageRow } from "../src/agent/serialize.ts";
import { ingestUpdate } from "../src/telegram/ingest.ts";
import { ManualSendService } from "../src/daemon/manual-send.ts";

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
		ingestUpdate(
			db,
			"A",
			{ update_id: caption ? 2 : 1, message: { ...addressed, message_id: caption ? 2 : 1 } },
			chatId,
			true,
		);
		const row = db.query("SELECT * FROM messages WHERE message_id = ?").get(caption ? 2 : 1) as MessageRow;
		for (const order of [bots, [...bots].reverse()]) {
			expect(routeMessageDecision(db, row, order, { secret: "test", probs: [0, 0] })).toMatchObject({
				target: "B",
				reason: "explicit",
			});
		}
	}
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

test("routing handoff survives a failed handler and restart before another Telegram poll", async () => {
	const { Poller } = await import("../src/telegram/poller.ts");
	let attempts = 0;
	const first = new Poller(
		db,
		"A",
		"unused",
		chatId,
		async () => {
			attempts++;
			first.stop();
			throw new Error("route storage unavailable");
		},
		true,
	);
	(first as any).api = {
		getUpdates: async () => [
			{
				update_id: 50,
				message: { ...message, text: "@beta_bot", entities: [{ type: "mention", offset: 0, length: 9 }] },
			},
		],
	};
	await first.run();
	expect(
		db.query("SELECT update_id, message_id, kind FROM pending_telegram_dispatch WHERE bot_id = 'A'").get(),
	).toEqual({ update_id: 50, message_id: 1, kind: "inserted" });
	// A different delivery can advance the runtime cursor while this handoff is still pending.
	db.query("INSERT INTO bot_cursors (bot_id, chat_id, consumed_seq, updated_at) VALUES ('A', ?, 999, 0)").run(chatId);
	// Retention must preserve both the raw source and the event needed by the eventual obligation.
	applyRetention(db, { telemetryDays: 1, rawUpdateDays: 1, messageEventDays: 1 }, Date.now() + 2 * 86400000);
	expect(db.query("SELECT COUNT(*) n FROM message_events WHERE message_id = 1").get()).toEqual({ n: 1 });
	let delivered: unknown;
	const second = new Poller(
		db,
		"A",
		"unused",
		chatId,
		async (result, update) => {
			attempts++;
			delivered = { result, update };
			second.stop();
		},
		true,
	);
	(second as any).api = {
		getUpdates: async () => {
			second.stop();
			return [];
		},
	};
	await second.run();
	expect(
		db.query("SELECT update_id, message_id, kind FROM pending_telegram_dispatch WHERE bot_id = 'A'").get(),
	).toBeNull();
	expect(attempts).toBe(2);
	expect(delivered).toMatchObject({ result: { kind: "inserted", messageId: 1 }, update: { update_id: 50 } });
});

test("ASCII bot names trigger only as whole words, since a name trigger owes a reply", () => {
	const fires = (name: string, text: string) => nameKeywordTrigger({ text } as MessageRow, { name } as never);
	expect([
		fires("Al", "Also"),
		fires("Al", "hey al, ok?"),
		fires("Mochi", "mochi2"),
		fires("小雪", "小雪你怎么看"),
	]).toEqual([false, true, false, true]);
});
