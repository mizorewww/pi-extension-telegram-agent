// Mentions win routing, the routing handoff is durable, and an unknown create is never repeated.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db/db.ts";
import { applyRetention } from "../src/db/retention.ts";
import {
	BotFire,
	dispatchRoutingDecision,
	FIRE_BOT_TRIGGER_BUDGET,
	MessageRouter,
	nameKeywordTrigger,
	routeMessageDecision,
	type RoutingTrigger,
} from "../src/agent/router.ts";
import { executeAgentSend } from "../src/agent/send.ts";
import type { BotApi } from "../src/telegram/api.ts";
import { sendMarkdownTextAndPersist } from "../src/telegram/send.ts";
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

test("/fire lets other bots trigger only the enabled bot in its chat, never itself, within a budget", () => {
	let updateId = 100;
	const post = (messageId: number, from: Record<string, unknown>, text: string, editDate?: number) => {
		const mention = text.match(/^@\w+/)?.[0];
		const msg = {
			...message,
			message_id: messageId,
			from,
			text,
			...(mention ? { entities: [{ type: "mention", offset: 0, length: mention.length }] } : {}),
			...(editDate ? { edit_date: editDate } : {}),
		};
		ingestUpdate(db, "A", { update_id: updateId++, [editDate ? "edited_message" : "message"]: msg }, chatId, true);
		return db.query("SELECT * FROM messages WHERE message_id = ?").get(messageId) as MessageRow;
	};
	const other = { id: 77, is_bot: true, first_name: "Other" };
	const config = { secret: "test", probs: [0, 0] };
	const fire = new BotFire();
	const triggers: unknown[] = [];
	const runtime = {
		trigger: (_source: unknown, trigger: unknown) => {
			triggers.push(trigger);
			return "started" as const;
		},
	};
	const runtimes = new Map([["A", runtime]]);
	const fireAt = (row: MessageRow) =>
		dispatchRoutingDecision(routeMessageDecision(db, row, bots, config, fire), runtimes, fire);

	// Default off: bot messages stay observed history.
	const first = post(1, other, "@alpha_bot hi");
	expect(routeMessageDecision(db, first, bots, config)).toMatchObject({ target: "nobody" });
	expect(fireAt(first)).toMatchObject({ target: "nobody" });
	// Scope: another chat, or another bot, being enabled does not redistribute A's mention.
	fire.enable("A", -100999);
	fire.enable("B", chatId);
	expect(fireAt(first)).toMatchObject({ target: "nobody" });

	fire.enable("A", chatId);
	expect(fireAt(first)).toMatchObject({ target: "A", reason: "explicit", fromBot: true, outcome: "started" });
	expect(triggers).toEqual([{ reason: "explicit", chatId, messageId: 1, fromBot: true }]);
	// A bot never triggers itself, and an edited bot message never re-triggers.
	const own = post(2, { id: 10, is_bot: true, first_name: "Alpha" }, "@alpha_bot me");
	expect(fireAt(own)).toMatchObject({ target: "nobody" });
	expect(fireAt(post(1, other, "@alpha_bot edited", 200))).toMatchObject({ target: "nobody" });

	// Budget: FIRE_BOT_TRIGGER_BUDGET accepted bot turns, then silence until a human speaks.
	for (let id = 3; id < 2 + FIRE_BOT_TRIGGER_BUDGET; id++) {
		expect(fireAt(post(id, other, "@alpha_bot again"))).toMatchObject({ outcome: "started" });
	}
	expect(fire.status("A", chatId)).toBe(0);
	expect(fireAt(post(20, other, "@alpha_bot loop"))).toMatchObject({ target: "nobody" });
	expect(fireAt(post(21, { id: 42, first_name: "Human" }, "hello"))).toMatchObject({ fromBot: false });
	expect(fire.status("A", chatId)).toBe(FIRE_BOT_TRIGGER_BUDGET);
	expect(fireAt(post(22, other, "@alpha_bot back"))).toMatchObject({ target: "A", outcome: "started" });

	fire.disable("A", chatId);
	expect(fireAt(post(23, other, "@alpha_bot off"))).toMatchObject({ target: "nobody" });
});

test("/fire routes persisted sibling sends locally, once, never to the sender or from control replies", async () => {
	const fire = new BotFire();
	const queue: { botId: string; trigger: RoutingTrigger }[] = [];
	const runtimes = new Map(
		bots.map((bot) => [
			bot.id,
			{
				trigger: (_source: unknown, trigger: RoutingTrigger) => {
					queue.push({ botId: bot.id, trigger });
					return "started" as const;
				},
			},
		]),
	);
	const router = new MessageRouter(db, bots, () => ({ secret: "test", probs: [0, 0] }), runtimes, fire);
	let nextId = 500;
	const sentRaw = new Map<number, Record<string, unknown>>();
	const apiFor = (botId: string) => {
		const bot = bots.find((candidate) => candidate.id === botId)!;
		return {
			sendMessage: async () => {
				throw new Error("unused");
			},
			sendMessageWithEntities: async (chat: number, text: string) => {
				const mention = text.match(/^@\w+/)?.[0];
				const raw = {
					message_id: ++nextId,
					date: 100,
					chat: { id: chat },
					from: { id: bot.userId, is_bot: true, first_name: bot.name, username: bot.username },
					text,
					...(mention ? { entities: [{ type: "mention", offset: 0, length: mention.length }] } : {}),
				};
				sentRaw.set(raw.message_id, raw);
				return raw;
			},
		};
	};
	// Real agent send path; the sink mirrors the daemon's sentMessageSink (route only persisted rows).
	const send = async (botId: string, message: string) => {
		const noop = () => {};
		await executeAgentSend(
			{ message },
			{
				db,
				api: apiFor(botId) as unknown as BotApi,
				botId,
				chatId,
				emitMediaUpdates: false,
				visibleMessageIds: new Set(),
				allowedReactions: null,
				triggerMessageId: null,
				recordPublicSend: noop,
				markVisible: noop,
				onSent: (raw) => {
					const row = db
						.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
						.get(chatId, raw.message_id as number) as MessageRow | null;
					if (row) router.routeLocalSend(row);
				},
				recordEvent: noop,
				stopTyping: noop,
				recordDuration: noop,
			},
		);
		return nextId;
	};
	const other = (botId: string) => (botId === "A" ? "@beta_bot" : "@alpha_bot");

	// Default off: a sibling's mention is persisted but triggers nobody.
	await send("B", "@alpha_bot hi");
	expect(queue).toEqual([]);

	// Both on: the bots ping-pong through the real send path until each budget is spent.
	fire.enable("A", chatId);
	fire.enable("B", chatId);
	await send("B", "@alpha_bot start");
	let turns = 0;
	// Bounded so a broken budget fails the assertion below instead of hanging the suite.
	for (let next = queue.shift(); next && turns <= 20; next = queue.shift()) {
		expect(next.trigger).toMatchObject({ reason: "explicit", fromBot: true });
		turns++;
		await send(next.botId, `${other(next.botId)} reply`);
	}
	expect(turns).toBe(2 * FIRE_BOT_TRIGGER_BUDGET);
	expect([fire.status("A", chatId), fire.status("B", chatId)]).toEqual([0, 0]);

	// A human message refills; the sender is never its own target.
	router.route(
		ingestUpdate(db, "A", { update_id: 900, message: { ...message, message_id: 900, text: "hi all" } }, chatId, true),
		db.query("SELECT * FROM messages WHERE message_id = 900").get() as MessageRow,
	);
	await send("A", "@alpha_bot talking to myself");
	expect(queue).toEqual([]);

	// No duplicate dispatch: a later poller echo of the same send is suppressed by its claim.
	const echoed = await send("B", "@alpha_bot once");
	expect(queue.map(({ botId }) => botId)).toEqual(["A"]);
	const echo = ingestUpdate(db, "A", { update_id: 901, message: sentRaw.get(echoed) }, chatId, true);
	expect(echo.kind).toBe("duplicate");
	router.route(echo, db.query("SELECT * FROM messages WHERE message_id = ?").get(echoed) as MessageRow);
	router.routeLocalSend(db.query("SELECT * FROM messages WHERE message_id = ?").get(echoed) as MessageRow);
	expect(queue).toHaveLength(1);
	expect(fire.status("A", chatId)).toBe(FIRE_BOT_TRIGGER_BUDGET - 1);

	// A control reply is persisted by the coordinator (no agent sink) and marked; even a poller
	// echo of it never triggers.
	queue.length = 0;
	const { canonical } = await sendMarkdownTextAndPersist(db, apiFor("B"), "B", chatId, "@alpha_bot status");
	db.query("INSERT INTO telegram_control_messages (chat_id, message_id) VALUES (?, ?)").run(
		chatId,
		canonical.message_id,
	);
	const controlRow = db.query("SELECT * FROM messages WHERE message_id = ?").get(canonical.message_id);
	router.route({ kind: "duplicate" }, controlRow as MessageRow);
	expect(queue).toEqual([]);

	// Telegram accepted it but local persistence failed: nothing durable, nothing routed.
	db.exec("CREATE TEMP TRIGGER fail_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'disk'); END");
	await send("B", "@alpha_bot lost");
	expect(queue).toEqual([]);
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
