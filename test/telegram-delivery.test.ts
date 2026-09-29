import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db/db.ts";
import { buildDebugReport } from "../src/observability/debug-report.ts";
import { applyRetention, pruneUnconfiguredBotState } from "../src/db/retention.ts";
import { routeMessageDecision } from "../src/agent/router.ts";
import type { MessageRow } from "../src/agent/serialize.ts";
import { serializeMessageEvents } from "../src/agent/serialize.ts";
import { packMessageEvents } from "../src/agent/token-packer.ts";
import { listRecentMessageEvents, messageEventHighWater } from "../src/db/message-events.ts";
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

test("old replies preserve the embedded body without ingesting or routing the parent", () => {
	const oldText =
		"An archived announcement with enough detail to exceed the old forty-character snippet. The launch is October 12.";
	const reply = {
		...message,
		date: 2_000_000,
		text: "Which date was announced?",
		reply_to_message: { ...message, message_id: 99, date: 1, text: oldText },
	};
	expect(ingestUpdate(db, "A", { update_id: 1, message: reply }, chatId, false)).toMatchObject({
		kind: "inserted",
		messageId: 1,
	});
	expect(ingestUpdate(db, "B", { update_id: 1, message: reply }, chatId, false).kind).toBe("duplicate");
	expect(db.query("SELECT message_id FROM messages").all()).toEqual([{ message_id: 1 }]);
	db.exec("DELETE FROM raw_updates");
	const events = listRecentMessageEvents(db, chatId, 0, messageEventHighWater(db, chatId), 10);
	expect(events).toHaveLength(1);
	const packed = packMessageEvents(db, events, [], 12_000, { visibleIds: new Set() });
	expect(packed.text).toContain(oldText);
	expect(packed.text).toContain(reply.text);
	expect(packed.visibleMessageIds).toEqual([1]);
	// A later delivery/edit of the parent must not change the reply snapshot.
	ingestUpdate(
		db,
		"A",
		{ update_id: 2, message: { ...reply.reply_to_message, text: "changed afterwards" } },
		chatId,
		false,
	);
	expect(serializeMessageEvents(db, events, { visibleIds: new Set() })).toBe(packed.text);
});

test("quoted captions and selected text share the bounded suffix budget with the new message", () => {
	const reply = {
		...message,
		text: "Explain the ending.",
		quote: { text: "引用的关键句。".repeat(3000), position: 0 },
		reply_to_message: {
			...message,
			message_id: 99,
			text: undefined,
			caption: "开始。" + "很长的旧文。".repeat(10000) + "结尾。",
			photo: [{ file_id: "fixture", file_unique_id: "fixture", width: 1, height: 1 }],
		},
	};
	ingestUpdate(db, "A", { update_id: 1, message: reply }, chatId, false);
	const events = listRecentMessageEvents(db, chatId, 0, messageEventHighWater(db, chatId), 10);
	const original = JSON.stringify(events);
	const packed = packMessageEvents(db, events, [], 512, { visibleIds: new Set() });
	expect(packed.deferredMandatory).toBe(0);
	expect(packed.estimatedTokens).toBeLessThanOrEqual(512);
	expect(packed.text).toContain(reply.text);
	expect(packed.text).toContain("开始。");
	expect(packed.text).toContain("结尾。");
	expect(packed.text).toContain("[truncated original_chars=");
	expect(JSON.stringify(events)).toBe(original);
});

test("a later bot copy can append missing reply content without routing the child twice", () => {
	const partial = { ...message, reply_to_message: { message_id: 99, from: message.from } };
	ingestUpdate(db, "A", { update_id: 1, message: partial }, chatId, false);
	const first = db.query("SELECT payload_json FROM message_events").get();
	const complete = { ...partial, reply_to_message: { ...message, message_id: 99, text: "The archived body." } };
	expect(ingestUpdate(db, "B", { update_id: 1, message: complete }, chatId, false).kind).toBe("duplicate");
	expect(db.query("SELECT payload_json FROM message_events WHERE kind = 'message'").get()).toEqual(first);
	const events = listRecentMessageEvents(db, chatId, 0, messageEventHighWater(db, chatId), 10);
	expect(events.map((event) => event.kind)).toEqual(["message", "metadata"]);
	expect(serializeMessageEvents(db, events.slice(1), { visibleIds: new Set() })).toContain("The archived body.");
	expect(ingestUpdate(db, "C", { update_id: 1, message: complete }, chatId, false).kind).toBe("duplicate");
	expect(messageEventHighWater(db, chatId)).toBe(events.at(-1)!.ingestSeq);
});

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

test("route diagnostics find matching chat runs outside the latest sample and ignore summaries", () => {
	const now = Date.now();
	for (const messageId of [1, 2])
		db.query(`INSERT INTO routing_claims
		(chat_id, message_id, bot_id, route_version, reason, status, created_at, updated_at)
		VALUES (?, ?, 'A', 1, 'reply', 'started', ?, ?)`).run(chatId, messageId, now - 300000, now - 300000);
	const run = db.query(`INSERT INTO llm_runs (bot_id, ts, model, epoch, trigger_message_id, compaction)
		VALUES ('A', ?, 'fixture', 1, ?, ?)`);
	run.run(now - 290000, 1, 0);
	run.run(now - 290000, 2, 1);
	for (let i = 0; i < 25; i++) run.run(now - 1000 + i, 100 + i, 0);
	const report = buildDebugReport(db, { botIds: ["A"], chatId, sinceMs: 3600000, now });
	expect(report.bots[0]?.runs).toHaveLength(20);
	expect(
		report.findings.filter((finding) => finding.code === "route_without_run").map((finding) => finding.message_id),
	).toEqual([2]);
});

test("older edits from a delayed poller cannot roll canonical or event history backward", () => {
	ingestUpdate(db, "A", { update_id: 1, message }, chatId, true);
	ingestUpdate(db, "A", { update_id: 2, edited_message: { ...message, text: "new", edit_date: 300 } }, chatId, true);
	const before = db.query("SELECT COUNT(*) n FROM message_events").get();
	expect(
		ingestUpdate(db, "B", { update_id: 3, edited_message: { ...message, text: "old", edit_date: 200 } }, chatId, true)
			.kind,
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

test("cursors of unconfigured bots stop pinning message_events retention", () => {
	ingestUpdate(db, "A", { update_id: 1, message: { ...message, date: 100 } }, chatId, true);
	const seq = (db.query("SELECT MAX(ingest_seq) value FROM message_events").get() as { value: number }).value;
	for (const botId of ["A", "gone"]) {
		db.query("INSERT INTO bot_cursors (bot_id, chat_id, consumed_seq, updated_at) VALUES (?, ?, ?, 0)").run(
			botId,
			chatId,
			botId === "A" ? seq : 0,
		);
	}
	const retention = { telemetryDays: 1, rawUpdateDays: 1, messageEventDays: 1 };
	applyRetention(db, retention, 10 * 86400000);
	expect(db.query("SELECT COUNT(*) n FROM message_events").get()).toEqual({ n: 1 });
	expect(pruneUnconfiguredBotState(db, ["A"])).toBe(1);
	applyRetention(db, retention, 10 * 86400000);
	expect(db.query("SELECT COUNT(*) n FROM message_events").get()).toEqual({ n: 0 });
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
	const pendingReport = buildDebugReport(db, { botIds: ["A"], chatId, sinceMs: 86400000 });
	expect(pendingReport.bots[0]?.pending_dispatch).toEqual({ update_id: 50, message_id: 1, kind: "inserted" });
	expect(JSON.stringify(pendingReport)).not.toContain("@beta_bot");
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
	expect(buildDebugReport(db, { botIds: ["A"], chatId, sinceMs: 86400000 }).bots[0]?.pending_dispatch).toBeNull();
	expect(attempts).toBe(2);
	expect(delivered).toMatchObject({ result: { kind: "inserted", messageId: 1 }, update: { update_id: 50 } });
});
