// Regression tests for the direct-address delivery guarantee (W1) and the flushLoop
// teardown race (W2). SHARED_PROTOCOL promises a response whenever a human explicitly
// @mentions, replies to, or name-keywords the bot; all three reasons must create a
// durable obligation so a coalesced trigger cannot silently drop the message.
// In-memory DB + fake session; no daemon, no network.

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { BotRuntime } from "../src/agent/runtime.ts";
import type { AppConfig, BotConfig } from "../src/config.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const CHAT_ID = -1004402809405;
const BOT_ID = "A";

function makeBot(): BotConfig {
	return {
		id: BOT_ID,
		name: "小雪",
		token: "unused",
		personaPath: "unused",
		routingP: 0,
		samplingCooldownMs: 0,
		provider: "test",
		model: "test-model",
		reasoningEffort: "off",
		compactionThreshold: 32768,
		compactionKeepRecent: 1,
		compactionModel: "test/compaction:off",
		cacheRetention: "short",
		providerTimeoutMs: 300_000,
		providerRetries: 2,
		maxSuffixTokens: 512,
		maxMessageTokens: 4096,
		tools: { send: true, search: false, runJs: false },
		stickerSets: [],
	};
}

function makeConfig(bot: BotConfig): AppConfig {
	return {
		dataDir: "/tmp/unused",
		dbPath: "/tmp/unused/agent.db",
		groupPeerId: 4402809405,
		bots: [bot],
		tinyfishApiKey: "",
		auxiliaryVisualModel: "test/vision:off",
		vision: { enabled: false, foregroundMediaLimit: 2, concurrency: 2 },
		contextWindow: 65536,
		media: { mode: "vision", maxImagesPerTurn: 4, downloadConcurrency: 2 },
		retention: { telemetryDays: 90, rawUpdateDays: 30, messageEventDays: 365 },
		routerSecret: null,
		telegramAdmins: [],
	};
}

function fakeModel() {
	return {
		id: "test-model",
		name: "test",
		api: "openai-responses",
		provider: "test",
		baseUrl: "http://unused",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65536,
		maxTokens: 4096,
	};
}

interface Harness {
	rt: BotRuntime;
	db: Database;
	sent: string[];
}

function setup(): Harness {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const bot = makeBot();
	const config = makeConfig(bot);
	const modelRuntime = { getModel: () => fakeModel() } as unknown as ModelRuntime;
	const sent: string[] = [];
	const rt = new BotRuntime(db, bot, config, modelRuntime, {
		chatActionSender: async () => {},
	});
	(rt as any).model = fakeModel();
	(rt as any).session = {
		getContextUsage: () => null,
		sendCustomMessage: async (message: { content: string }) => {
			sent.push(message.content);
		},
		sessionManager: {
			appendCustomEntry: () => "entry",
		},
	};
	return { rt, db, sent };
}

function insertMessage(db: Database, messageId: number, text: string): void {
	db.query(
		`INSERT INTO messages
			(chat_id, message_id, date, sender_id, display_name, username, is_bot, text, first_seen_by)
		 VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'A')`,
	).run(CHAT_ID, messageId, 1_754_612_345, 111, "Alice", "alice", text);
}

function obligationCount(db: Database): number {
	return (db.query("SELECT COUNT(*) count FROM reply_obligations").get() as { count: number }).count;
}

test("explicit @mention coalesced during a flush still creates a durable obligation and delivers it", async () => {
	const { rt, db, sent } = setup();
	const messageId = 1001;
	insertMessage(db, messageId, "hello @bot");
	(rt as any).flushing = true;
	expect(rt.trigger("explicit", { reason: "explicit", chatId: CHAT_ID, messageId })).toBe("coalesced");
	// W1: the obligation must exist even though the trigger only coalesced.
	expect(obligationCount(db)).toBe(1);
	(rt as any).flushing = false;
	expect(rt.trigger("explicit", { reason: "explicit", chatId: CHAT_ID, messageId })).toBe("started");
	await (rt as any).flushPromise;
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain(`#${messageId}`);
	expect(obligationCount(db)).toBe(0);
});

test("name-keyword direct address gets the same obligation guarantee", async () => {
	const { rt, db, sent } = setup();
	const messageId = 1002;
	insertMessage(db, messageId, "小雪你怎么看");
	(rt as any).flushing = true;
	expect(rt.trigger("explicit", { reason: "name", chatId: CHAT_ID, messageId })).toBe("coalesced");
	expect(obligationCount(db)).toBe(1);
	(rt as any).flushing = false;
	expect(rt.trigger("explicit", { reason: "name", chatId: CHAT_ID, messageId })).toBe("started");
	await (rt as any).flushPromise;
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain(`#${messageId}`);
	expect(obligationCount(db)).toBe(0);
});

test("already-visible messages never create a duplicate obligation", () => {
	const { rt, db } = setup();
	const messageId = 1003;
	insertMessage(db, messageId, "hello");
	(rt as any).visibleMessageIds.add(messageId);
	(rt as any).flushing = true;
	expect(rt.trigger("explicit", { reason: "explicit", chatId: CHAT_ID, messageId })).toBe("coalesced");
	expect(obligationCount(db)).toBe(0);
});

test("ordinary overflow is silently consumed without a provider call (design lock)", async () => {
	const { rt, db, sent } = setup();
	const messageId = 1004;
	insertMessage(db, messageId, "x".repeat(20_000));
	expect(rt.trigger("explicit")).toBe("started");
	await (rt as any).flushPromise;
	expect(sent).toHaveLength(0);
	const highWater = (db.query("SELECT MAX(ingest_seq) value FROM message_events").get() as { value: number }).value;
	const cursor = db.query("SELECT consumed_seq consumedSeq FROM bot_cursors WHERE bot_id = 'A'").get() as {
		consumedSeq: number;
	};
	expect(cursor.consumedSeq).toBe(highWater);
});

test("W2: a trigger arriving in the flushLoop teardown window is not stranded", async () => {
	const { rt, db, sent } = setup();
	const messageId = 1005;
	insertMessage(db, messageId, "hello @bot");
	const lease = (rt as any).typingLease;
	const originalStop = lease.stop.bind(lease);
	let raced = false;
	let raceResult: string | null = null;
	lease.stop = () => {
		if (!raced) {
			raced = true;
			// Runs inside flushLoop's finally: the do-while has already exited but the
			// outer .finally() has not yet cleared `flushing` — the exact race window.
			raceResult = rt.trigger("explicit", { reason: "explicit", chatId: CHAT_ID, messageId });
		}
		return originalStop();
	};
	expect(rt.trigger("explicit", { reason: "explicit", chatId: CHAT_ID, messageId })).toBe("started");
	const firstFlush = (rt as any).flushPromise;
	await firstFlush;
	expect(raced).toBe(true);
	expect(raceResult!).toBe("coalesced");
	// The race-window trigger must have been consumed by a follow-up flush, not stranded.
	await (rt as any).flushPromise;
	expect((rt as any).pendingTrigger).toBe(false);
	expect((rt as any).flushing).toBe(false);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain(`#${messageId}`);
});
