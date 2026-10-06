// Regression tests for the direct-address delivery guarantee (W1) and the flushLoop
// teardown race (W2). SHARED_PROTOCOL promises a response whenever a human explicitly
// @mentions, replies to, or name-keywords the bot; all three reasons must create a
// durable obligation so a coalesced trigger cannot silently drop the message.
// In-memory DB + fake session; no daemon, no network.

import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardProviderCall } from "../src/agent/provider-guard.ts";
import { getConsumedSeq } from "../src/db/message-events.ts";
import { BotRuntime } from "../src/agent/runtime.ts";
import type { AppConfig, BotConfig } from "../src/config.ts";
import type { BotApi } from "../src/telegram/api.ts";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { makeTelegramCompactionExtension, observeProviderPayload } from "../src/agent/extensions/index.ts";
import { setLogSink } from "../src/observability/log.ts";
import { fitContextBreakdown } from "../src/observability/usage.ts";
import { ingestUpdate } from "../src/telegram/ingest.ts";

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
		contextImageBudgetBytes: 10_000_000,
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
		groupChatId: CHAT_ID,
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

function setup(publicSend = true): Harness {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const bot = makeBot();
	const config = makeConfig(bot);
	const modelRuntime = { getModel: () => fakeModel() } as unknown as ModelRuntime;
	const sent: string[] = [];
	let sentId = 90000;
	const rt = new BotRuntime(db, bot, config, modelRuntime, {
		api: {
			sendMessageWithEntities: async () => ({
				chat: { id: CHAT_ID },
				message_id: ++sentId,
				date: 100,
				from: { id: 123, is_bot: true, first_name: "Bot" },
				text: "fixture reply",
			}),
		} as unknown as BotApi,
		chatActionSender: async () => {},
		videoTranscoder: { ffmpeg: false, ffprobe: false },
	});
	(rt as any).model = fakeModel();
	const sessionManager = SessionManager.inMemory("/tmp/unused");
	(rt as any).session = {
		settingsManager: SettingsManager.inMemory(),
		sessionManager,
		getContextUsage: () => null,
		prompt: async () => {
			const details = (rt as any).pendingTurnContext;
			if (!details) throw new Error("unexpected repair turn");
			sessionManager.appendCustomMessageEntry("telegram_context_v2", details.providerText, false, details);
			sent.push(details.providerText);
			if (publicSend) {
				const result = await (rt as any).executeSend({ message: "fixture reply" });
				sessionManager.appendMessage({
					role: "toolResult",
					toolName: "send",
					toolCallId: "fixture-send",
					content: result.content,
					details: result.details,
					isError: false,
					timestamp: Date.now(),
				});
			}
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

test("a provider turn that ends in error keeps the direct-address obligation and records no usage", async () => {
	// Pi resolves the turn normally after exhausting retries (final assistant stopReason
	// "error"). Production 429s then marked @mentions delivered without any reply and wrote
	// one zero-usage llm_runs row per failed attempt.
	const { rt, db, sent } = setup(false);
	const messageId = 1006;
	insertMessage(db, messageId, "hello @bot");
	const session = (rt as any).session;
	const prompt = session.prompt;
	const failedTurn = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "429: quota",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		},
	};
	let events: ((event: unknown) => void) | null = null;
	session.subscribe = (listener: (event: unknown) => void) => {
		events = listener;
	};
	(rt as any).subscribeEvents();
	session.prompt = async () => {
		await prompt();
		events?.({ type: "agent_start" });
		events?.(failedTurn);
		events?.({ type: "agent_settled" });
	};
	expect(rt.trigger("explicit", { reason: "explicit", chatId: CHAT_ID, messageId })).toBe("started");
	await (rt as any).flushPromise;
	expect(sent).toHaveLength(1);
	expect(obligationCount(db)).toBe(1);
	expect((db.query("SELECT COUNT(*) count FROM llm_runs").get() as { count: number }).count).toBe(0);
	// The next trigger re-packs the owed message as a mandatory event and a healthy turn clears it.
	session.prompt = async () => {
		await prompt();
		events?.({ type: "agent_start" });
		events?.({ ...failedTurn, message: { ...failedTurn.message, stopReason: "stop" } });
		await (rt as any).executeSend({ message: "fixture reply" });
		events?.({ type: "agent_settled" });
	};
	expect(rt.trigger("explicit")).toBe("started");
	await (rt as any).flushPromise;
	expect(sent).toHaveLength(2);
	expect(sent[1]).toContain(`#${messageId}`);
	expect(obligationCount(db)).toBe(0);
	expect((db.query("SELECT COUNT(*) count FROM llm_runs").get() as { count: number }).count).toBe(1);
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
		if (!raced && obligationCount(db) === 0) {
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

test("a committed send stays terminal when the usage observer fails", async () => {
	const { rt, db } = setup();
	let creates = 0;
	(rt as any).api = {
		sendMessageWithEntities: async () => {
			creates++;
			return {
				chat: { id: CHAT_ID },
				message_id: 9001,
				date: 100,
				from: { id: 123, is_bot: true, first_name: "Bot" },
				text: "sent",
			};
		},
	};
	(rt as any).lastLlmRunId = 1;
	(rt as any).lastUsageRun = { id: 1 };
	rt.usageSink = () => {
		throw new Error("observer failed");
	};
	const result = await (rt as any).executeSend({ message: "sent" });
	expect(result.terminate).toBe(true);
	expect(creates).toBe(1);
	expect(db.query("SELECT text FROM messages WHERE message_id=9001").get()).toEqual({ text: "sent" });
});

test("post-turn compaction replaces durable and in-memory visibility together", async () => {
	const { rt, db } = setup();
	insertMessage(db, 9010, "hello");
	const session = (rt as any).session;
	// Pi owns the token threshold inside the turn; the post-turn hook only reacts to image
	// transport pressure, so force that path.
	(rt as any).bot.contextImageBudgetBytes = -1;
	session.compact = async () => {
		const marker = session.sessionManager.appendCustomEntry("retained_marker", {});
		session.sessionManager.appendCompaction("summary", marker, 40000, { visibleMessageIds: [] });
		(rt as any).onCompactionEnd({
			type: "compaction_end",
			reason: "manual",
			aborted: false,
			result: { details: { visibleMessageIds: [] } },
		});
	};
	rt.trigger("explicit", { reason: "explicit", chatId: CHAT_ID, messageId: 9010 });
	await (rt as any).flushPromise;
	expect([...(rt as any).visibleMessageIds]).toEqual([]);
	expect(db.query("SELECT message_id FROM bot_visible_messages").all()).toEqual([]);
	expect(obligationCount(db)).toBe(0);
});

test("Pi compaction during a provider turn cannot resurrect discarded batch IDs", async () => {
	const { rt, db } = setup();
	insertMessage(db, 9011, "hello");
	const session = (rt as any).session;
	const prompt = session.prompt;
	session.prompt = async () => {
		await prompt();
		const marker = session.sessionManager.appendCustomEntry("retained_marker", {});
		session.sessionManager.appendCompaction("summary", marker, 40000, { visibleMessageIds: [] });
		(rt as any).onCompactionEnd({
			type: "compaction_end",
			reason: "threshold",
			aborted: false,
			result: { details: { visibleMessageIds: [] } },
		});
	};
	rt.trigger("explicit", { reason: "explicit", chatId: CHAT_ID, messageId: 9011 });
	await (rt as any).flushPromise;
	expect([...(rt as any).visibleMessageIds]).toEqual([]);
	expect(db.query("SELECT message_id FROM bot_visible_messages").all()).toEqual([]);
	expect(obligationCount(db)).toBe(0);
});

test("compaction propagates cancellation and summarizes the discarded split-turn prefix", async () => {
	const { rt } = setup();
	const controller = new AbortController();
	const prep = {
		messagesToSummarize: [{ role: "user", content: "earlier-message", timestamp: 1 }],
		turnPrefixMessages: [{ role: "user", content: "latest-discarded-message", timestamp: 2 }],
	};
	let requestText = "";
	let cancelled = false;
	(rt as any).compactionModel = fakeModel();
	(rt as any).modelRuntime = {
		streamSimple: (_model: unknown, request: any, options: any) => {
			requestText = request.messages[0].content;
			options.signal.addEventListener(
				"abort",
				() => {
					cancelled = true;
				},
				{ once: true },
			);
			return createAssistantMessageEventStream();
		},
	};
	const pending = (rt as any).generateCompactionSummary(prep, controller.signal);
	controller.abort();
	const result = await Promise.race([pending, Bun.sleep(100).then(() => ({ failure: "did not cancel" }))]);
	expect(result).toEqual({ failure: "summary generation aborted" });
	expect(cancelled).toBe(true);
	expect(requestText).toContain("earlier-message");
	expect(requestText).toContain("latest-discarded-message");
});

test("image pressure runs a normal Pi compaction and never deletes a retained shared image", async () => {
	const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "tg-image-pressure-"));
	const { rt } = setup();
	try {
		const mediaDir = join(root, "media");
		mkdirSync(mediaDir);
		writeFileSync(join(mediaDir, "shared.jpg"), new Uint8Array(100));
		(rt as any).config.dataDir = root;
		(rt as any).bot.contextImageBudgetBytes = 10;
		(rt as any).bot.compactionKeepRecent = 20000;
		const session = (rt as any).session;
		session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 20000 } });
		session.sessionManager.appendCustomMessageEntry("telegram_context_v2", "image", false, {
			version: 4,
			consumedSeq: 1,
			providerText: "image",
			blocks: [{ type: "image", name: "shared.jpg", mime: "image/jpeg" }],
			stickerCandidates: "",
			visibleMessageIds: [1],
			events: [],
		});
		let attempts = 0;
		session.compact = async () => {
			attempts++;
			// One small image fits the configured retention window.
			expect(session.settingsManager.getCompactionKeepRecentTokens()).toBe(20000);
			if (attempts === 2) throw new Error("summary unavailable");
		};
		await (rt as any).maybeAutoCompact();
		await (rt as any).maybeAutoCompact();
		expect(attempts).toBe(2);
		// A turn that just failed at the provider must not immediately spend a summary request.
		(rt as any).lastTurnFailed = true;
		await (rt as any).maybeAutoCompact();
		expect(attempts).toBe(2);
		expect(existsSync(join(mediaDir, "shared.jpg"))).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("compaction telemetry failure cancels explicitly instead of enabling Pi's default summarizer", async () => {
	const { rt } = setup();
	(rt as any).generateCompactionSummary = async () => ({ failure: "summary generation aborted" });
	(rt as any).recordEvent = () => {
		throw new Error("event storage unavailable");
	};
	expect(await (rt as any).handleBeforeCompact({ preparation: {}, signal: new AbortController().signal })).toEqual({
		cancel: true,
	});
});

test("a silent direct-address turn gets only one repair attempt and remains owed until a public send", async () => {
	const { rt, db } = setup(false);
	insertMessage(db, 9020, "hello @bot");
	const session = (rt as any).session;
	let repairs = 0;
	const prompt = session.prompt;
	session.prompt = async () => {
		if ((rt as any).pendingTurnContext) return prompt();
		repairs++;
	};
	rt.trigger("explicit", { reason: "reply", chatId: CHAT_ID, messageId: 9020 });
	await (rt as any).flushPromise;
	expect(repairs).toBe(1);
	expect(obligationCount(db)).toBe(1);
	expect((rt as any).flushing).toBe(false);
	session.prompt = async () => {
		if ((rt as any).pendingTurnContext) return prompt();
		repairs++;
		await (rt as any).executeSend({ message: "fixture reply" });
	};
	rt.trigger("explicit");
	await (rt as any).flushPromise;
	expect(repairs).toBe(2);
	expect(obligationCount(db)).toBe(0);
	db.close();
});

test("an unknown Telegram create closes the obligation without any automatic resend", async () => {
	const { rt, db } = setup(false);
	insertMessage(db, 9021, "hello @bot");
	let creates = 0;
	(rt as any).api = {
		sendMessageWithEntities: async () => {
			creates++;
			throw new TypeError("connection lost");
		},
	};
	const session = (rt as any).session;
	const prompt = session.prompt;
	let repairs = 0;
	session.prompt = async () => {
		if ((rt as any).pendingTurnContext) {
			await prompt();
			const result = await (rt as any).executeSend({ message: "fixture reply" });
			expect(result.details.outcome).toBe("unknown");
			return;
		}
		repairs++;
	};
	rt.trigger("explicit", { reason: "explicit", chatId: CHAT_ID, messageId: 9021 });
	await (rt as any).flushPromise;
	expect(creates).toBe(1);
	expect(repairs).toBe(0);
	expect(obligationCount(db)).toBe(0);
	const commits = session.sessionManager.getBranch().filter((e: any) => e.customType === "telegram_context_commit_v2");
	expect(commits.at(-1).data).toMatchObject({ outcome: "unknown", deliveredObligationIds: [9021] });
	db.close();
});

test("busy probability routing cannot overwrite the in-flight trigger identity", () => {
	const { rt, db } = setup();
	(rt as any).flushing = true;
	(rt as any).currentTriggerMessageId = 77;
	expect(rt.trigger("probability", { reason: "probability", chatId: CHAT_ID, messageId: 88 })).toBe("skipped_busy");
	expect((rt as any).currentTriggerMessageId).toBe(77);
	db.close();
});

function assistantResult(input = 100) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "summary" }],
		api: "openai-responses" as const,
		provider: "test",
		model: "test-model",
		usage: {
			input,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

test("Telegram turns initialize the native prompt and use only the latest request observation", async () => {
	const root = mkdtempSync(join(tmpdir(), "tg-context-usage-"));
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const bot = { ...makeBot(), personaPath: join(root, "persona.md"), compactionModel: "test/test-model:low" };
	writeFileSync(bot.personaPath, "Fixture persona.");
	const config = { ...makeConfig(bot), dataDir: root };
	const payload = {
		system: "adapter system",
		tools: [{ name: "send", description: "adapter tool" }],
		messages: [{ role: "user", content: "adapter user" }],
	};
	let calls = 0;
	const requestPrompts: string[] = [];
	let authAvailable = true;
	const modelRuntime = {
		getModel: () => fakeModel(),
		hasConfiguredAuth: () => authAvailable,
		checkAuth: async () => undefined,
		isUsingOAuth: () => false,
		getAuth: async () => ({ auth: { apiKey: "fixture" } }),
		streamSimple: (_model: unknown, context: any, options: any) => {
			requestPrompts.push(getCurrentSystemPrompt(context.messages));
			const stream = createAssistantMessageEventStream();
			const call = ++calls;
			void (async () => {
				if (call === 2) {
					// An adapter can retry within one stream; only the successful request belongs to this usage.
					await options.onPayload({ ...payload, system: "earlier failed attempt ".repeat(100) }, fakeModel());
					await options.onPayload(payload, fakeModel());
				}
				stream.push({ type: "done", reason: "stop", message: assistantResult(10_000) });
			})();
			return stream;
		},
	} as unknown as ModelRuntime;
	const rt = new BotRuntime(db, bot, config, modelRuntime, {
		videoTranscoder: { ffmpeg: false, ffprobe: false },
		chatActionSender: async () => {},
	});
	const restoreLog = setLogSink(() => {});
	try {
		await rt.init();
		const session = (rt as any).session;
		for (let call = 1; call <= 3; call++) {
			insertMessage(db, 9100 + call, "fixture user");
			expect(rt.trigger("probability", { reason: "probability", chatId: CHAT_ID, messageId: 9100 + call })).toBe(
				"started",
			);
			await (rt as any).flushPromise;
			// First Telegram turn must already have the same complete Pi-owned prompt as later requests.
			expect(requestPrompts.at(-1)).toBe(session.systemPrompt);
			const row = db
				.query(`SELECT system_tokens, tools_tokens, compacted_history_tokens, message_tokens,
				full_payload_hash, cache_read_estimated FROM llm_runs ORDER BY id DESC LIMIT 1`)
				.get() as any;
			expect(row.message_tokens).toBeGreaterThan(0);
			expect(row.system_tokens + row.tools_tokens + row.compacted_history_tokens + row.message_tokens).toBe(10_000);
			if (call === 2) {
				expect(row.system_tokens).toBeGreaterThan(0);
				expect(row.tools_tokens).toBeGreaterThan(0);
				const estimate = fitContextBreakdown(observeProviderPayload(payload, "fixture").tokenEstimate, 10_000);
				expect(row).toMatchObject({
					system_tokens: estimate.system,
					tools_tokens: estimate.tools,
					message_tokens: estimate.messages,
				});
				expect(row.full_payload_hash).not.toBeNull();
			} else {
				// Missing hooks must not reuse another request's breakdown or fabricate cache evidence.
				expect(row.system_tokens).toBe(0);
				expect(row.tools_tokens).toBe(0);
				expect(row.full_payload_hash).toBeNull();
				expect(row.cache_read_estimated).toBeNull();
			}
		}
		expect(calls).toBe(3);
		// A native preflight failure must leave the batch unconsumed and out of future repair turns.
		authAvailable = false;
		insertMessage(db, 9104, "deferred fixture user");
		rt.trigger("probability", { reason: "probability", chatId: CHAT_ID, messageId: 9104 });
		await (rt as any).flushPromise;
		expect(calls).toBe(3);
		expect((rt as any).pendingTurnContext).toBeNull();
		authAvailable = true;
		rt.trigger("probability", { reason: "probability", chatId: CHAT_ID, messageId: 9104 });
		await (rt as any).flushPromise;
		expect(calls).toBe(4);
		const batches = session.sessionManager.getBranch().filter((entry: any) => entry.type === "custom_message");
		expect(batches.flatMap((entry: any) => entry.details.events.map((event: any) => event.messageId))).toEqual([
			9101, 9102, 9103, 9104,
		]);
	} finally {
		await rt.stop();
		restoreLog();
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("reply bodies survive native prompt preflight dropping the old parent from context", async () => {
	const root = mkdtempSync(join(tmpdir(), "tg-reply-preflight-"));
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const bot = { ...makeBot(), personaPath: join(root, "persona.md"), compactionModel: "test/test-model:low" };
	writeFileSync(bot.personaPath, "Fixture persona.");
	const requests: string[] = [];
	const modelRuntime = {
		getModel: () => fakeModel(),
		hasConfiguredAuth: () => true,
		getAuth: async () => ({ auth: { apiKey: "fixture" } }),
		streamSimple: (_model: unknown, context: any) => {
			requests.push(JSON.stringify(context.messages.at(-1)));
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: assistantResult(requests.length < 3 ? 10_000 : 100) });
			return stream;
		},
	} as unknown as ModelRuntime;
	const rt = new BotRuntime(db, bot, { ...makeConfig(bot), dataDir: root }, modelRuntime, {
		videoTranscoder: { ffmpeg: false, ffprobe: false },
		chatActionSender: async () => {},
	});
	const restoreLog = setLogSink(() => {});
	const oldBody = "An old announcement whose important detail is beyond forty characters: launch on October 12.";
	try {
		await rt.init();
		for (const [id, text] of [
			[1, oldBody],
			[2, "An unrelated later turn."],
		] as const) {
			insertMessage(db, id, text);
			rt.trigger("probability", { reason: "probability", chatId: CHAT_ID, messageId: id });
			await (rt as any).flushPromise;
		}
		const session = (rt as any).session;
		expect((rt as any).visibleMessageIds.has(1)).toBe(true);
		let summaries = 0;
		(rt as any).generateCompactionSummary = async () => {
			summaries++;
			return { summary: "Earlier conversation summarized.", usage: assistantResult().usage };
		};
		session.settingsManager.applyOverrides({ compaction: { reserveTokens: 60_000 } });
		ingestUpdate(
			db,
			"A",
			{
				update_id: 3,
				message: {
					chat: { id: CHAT_ID },
					message_id: 3,
					date: 1_754_612_350,
					from: { id: 111, first_name: "Alice" },
					text: "Which launch date?",
					// Legacy/delayed copy: resolve the already stored parent when no snapshot is supplied.
					reply_to_message: { message_id: 1, from: { id: 111 } },
				},
			},
			CHAT_ID,
			false,
		);
		rt.trigger("probability", { reason: "probability", chatId: CHAT_ID, messageId: 3 });
		await (rt as any).flushPromise;
		expect(summaries).toBe(1);
		expect(requests).toHaveLength(3);
		expect((rt as any).visibleMessageIds.has(1)).toBe(false);
		expect(requests[2]).toContain(oldBody);
		expect(requests[2]).toContain("Which launch date?");
	} finally {
		await rt.stop();
		restoreLog();
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

function imageDetails(id: number) {
	return {
		version: 4,
		consumedSeq: id,
		providerText: `photo #${id}`,
		blocks: [
			{ type: "text", text: `photo #${id}` },
			...Array.from({ length: 4 }, () => ({ type: "image", name: "photo.png", mime: "image/png" })),
		],
		stickerCandidates: "stale-candidate-canary",
		visibleMessageIds: [id],
		events: [],
	};
}

for (const mode of ["manual", "automatic", "cancelled"] as const) {
	test(`real Pi ${mode} compaction reaches the extension when text fits but images exceed retention`, async () => {
		const root = mkdtempSync(join(tmpdir(), "tg-native-compaction-"));
		const { rt, db } = setup();
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			systemPrompt: "Deterministic fixture.",
			extensionFactories: [makeTelegramCompactionExtension((event) => (rt as any).handleBeforeCompact(event))],
		});
		await loader.reload();
		const modelRuntime = {
			getModel: () => fakeModel(),
			hasConfiguredAuth: () => true,
			getAuth: async () => ({ auth: { apiKey: "fixture" } }),
		} as unknown as ModelRuntime;
		const manager = SessionManager.inMemory(root);
		for (let i = 1; i <= 12; i++) {
			manager.appendCustomMessageEntry("telegram_context_v2", `photo #${i}`, false, imageDetails(i));
			manager.appendMessage(assistantResult());
		}
		const { session } = await createAgentSession({
			cwd: root,
			model: fakeModel() as never,
			modelRuntime,
			sessionManager: manager,
			resourceLoader: loader,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true, reserveTokens: 32768, keepRecentTokens: 20000 },
			}),
			noTools: "all",
		});
		(rt as any).session = session;
		(rt as any).bot.compactionKeepRecent = 20000;
		(rt as any).subscribeEvents();
		let summaryMessages: unknown[] = [];
		(rt as any).generateCompactionSummary = async (prep: any) => {
			summaryMessages = [...prep.messagesToSummarize, ...prep.turnPrefixMessages];
			if (mode === "cancelled") return { failure: "summary generation aborted" };
			return { summary: "summary", usage: assistantResult().usage };
		};
		session.agent.streamFunction = () => {
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: assistantResult(50000) });
			return stream;
		};
		try {
			if (mode === "automatic") await session.prompt("continue");
			else expect((await rt.compactForControl()).ok).toBe(mode === "manual");
			expect(summaryMessages.length).toBeGreaterThan(0);
			expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(
				mode === "cancelled" ? 0 : 1,
			);
			const retained = manager.buildContextEntries().filter((entry) => entry.type === "custom_message").length;
			if (mode === "cancelled") expect(retained).toBe(12);
			else expect(retained).toBeLessThan(12);
			expect(session.settingsManager.getCompactionKeepRecentTokens()).toBe(20000);
		} finally {
			session.dispose();
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const supportsImages of [true, false]) {
	test(`summary model image capability (${supportsImages}) controls multimodal input without persisting image bytes`, async () => {
		const root = mkdtempSync(join(tmpdir(), "tg-summary-images-"));
		const { rt, db } = setup();
		mkdirSync(join(root, "media"));
		writeFileSync(join(root, "media", "photo.png"), "fixture-image-bytes");
		(rt as any).config.dataDir = root;
		(rt as any).compactionModel = { ...fakeModel(), input: supportsImages ? ["text", "image"] : ["text"] };
		let request: any;
		(rt as any).modelRuntime = {
			streamSimple: (_model: unknown, input: unknown) => {
				request = input;
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: assistantResult() });
				return stream;
			},
		};
		const messages = [1, 2].map((id) => ({
			role: "custom",
			customType: "telegram_context_v2",
			content: `photo #${id}`,
			display: false,
			timestamp: id,
			details: imageDetails(id),
		}));
		const original = JSON.stringify(messages);
		const logs: string[] = [];
		const restoreLogs = setLogSink((line) => logs.push(line));
		try {
			const result = await (rt as any).generateCompactionSummary(
				{
					messagesToSummarize: [messages[0]],
					turnPrefixMessages: [messages[1]],
					previousSummary: "old summary",
				},
				new AbortController().signal,
			);
			expect(result.summary).toBe("summary");
			const content = request.messages[0].content;
			const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
			expect(blocks.filter((b: any) => b.type === "image")).toHaveLength(supportsImages ? 8 : 0);
			if (supportsImages) {
				expect(blocks[0].text).toContain("photo #1");
				expect(blocks[5].text).toContain("photo #2");
			}
			const text = blocks
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("");
			expect(text).toContain("photo #1");
			expect(text).toContain("photo #2");
			expect(text).toContain("old summary");
			expect(text).not.toContain("stale-candidate-canary");
			expect(JSON.stringify(messages)).toBe(original);
			expect(
				logs.map((line) => JSON.parse(line)).find((line) => line.event === "compaction_input")?.fields,
			).toMatchObject({ vision_supported: supportsImages, images_attached: supportsImages ? 8 : 0 });
			expect(logs.join("")).not.toContain("fixture-image-bytes");
			expect(logs.join("")).not.toContain("photo #");
		} finally {
			restoreLogs();
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const failure of ["auth", "overflow", "transport", "persistent_transport"] as const) {
	test(`native compaction skips failed-turn thresholds but preserves ${failure} recovery semantics`, async () => {
		const root = mkdtempSync(join(tmpdir(), "tg-failed-compaction-"));
		const { rt, db } = setup();
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			systemPrompt: "Deterministic fixture.",
			extensionFactories: [makeTelegramCompactionExtension((event) => (rt as any).handleBeforeCompact(event))],
		});
		await loader.reload();
		const modelRuntime = {
			getModel: () => fakeModel(),
			hasConfiguredAuth: () => true,
			getAuth: async () => ({ auth: { apiKey: "fixture" } }),
		} as unknown as ModelRuntime;
		const manager = SessionManager.inMemory(root);
		manager.appendMessage({ role: "user", content: "earlier turn", timestamp: 1 });
		manager.appendMessage(assistantResult());
		const { session } = await createAgentSession({
			cwd: root,
			model: fakeModel() as never,
			modelRuntime,
			sessionManager: manager,
			resourceLoader: loader,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true, reserveTokens: 32768, keepRecentTokens: 1 },
				retry: { enabled: false },
			}),
			noTools: "all",
		});
		(rt as any).session = session;
		(rt as any).subscribeEvents();
		let summaries = 0;
		(rt as any).generateCompactionSummary = async () => {
			summaries++;
			return { summary: "summary", usage: assistantResult().usage };
		};
		let calls = 0;
		session.agent.streamFunction = () => {
			const stream = createAssistantMessageEventStream();
			if (++calls === 1 || failure === "auth" || failure === "persistent_transport") {
				stream.push({
					type: "error",
					reason: "error",
					error: {
						...assistantResult(0),
						content: [],
						stopReason: "error",
						errorMessage:
							failure === "auth"
								? "401 Unauthorized"
								: failure === "overflow"
									? "maximum context length exceeded"
									: "GetChatMessage HTTP 413: Request Entity Too Large",
					},
				});
			} else stream.push({ type: "done", reason: "stop", message: assistantResult() });
			return stream;
		};
		const upstream = session.agent.streamFunction;
		session.agent.streamFunction = (model, context, options) =>
			guardProviderCall(() => upstream(model, context, options), model, options?.signal, { timeoutMs: 1000 });
		try {
			await session.prompt("x".repeat(140_000));
			expect(summaries).toBe(failure === "auth" ? 0 : 1);
			expect(calls).toBe(failure === "auth" ? 1 : 2);
			if (failure === "auth") {
				// The next prompt's preflight must also avoid retrying a failed threshold summary.
				await session.prompt("retry");
				expect(summaries).toBe(0);
				expect(calls).toBe(2);
			}
		} finally {
			await session.dispose();
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("failed summary attempts do not create zero-usage rows, but preserve reported usage", async () => {
	const { rt, db } = setup();
	(rt as any).compactionModel = fakeModel();
	(rt as any).bot.providerRetries = 0;
	let inputTokens = 0;
	(rt as any).modelRuntime = {
		streamSimple: () => {
			const stream = createAssistantMessageEventStream();
			const message = assistantResult(inputTokens);
			stream.push({
				type: "error",
				reason: "error",
				error: {
					...message,
					content: [],
					stopReason: "error",
					errorMessage: "401 Unauthorized",
					usage: { ...message.usage, output: 0, totalTokens: inputTokens },
				},
			});
			return stream;
		},
	};
	try {
		for (const tokens of [0, 100]) {
			inputTokens = tokens;
			const result = await (rt as any).generateCompactionSummary(
				{ messagesToSummarize: [], turnPrefixMessages: [] },
				new AbortController().signal,
			);
			expect(result).toEqual({ failure: "summary generation error" });
			expect(db.query("SELECT cache_miss FROM llm_runs").all()).toEqual(tokens ? [{ cache_miss: 100 }] : []);
		}
	} finally {
		db.close();
	}
});

test("an oversized summary input is refused before any paid request and records a bounded diagnostic", async () => {
	const { rt, db } = setup();
	(rt as any).compactionModel = { ...fakeModel(), contextWindow: 8192 };
	let calls = 0;
	(rt as any).modelRuntime = {
		streamSimple: () => {
			calls++;
			throw new Error("must not call");
		},
	};
	const logs: string[] = [];
	const restoreLogs = setLogSink((line) => logs.push(line));
	try {
		const result = await (rt as any).generateCompactionSummary(
			{
				messagesToSummarize: [{ role: "user", content: "private-body-canary".repeat(1000), timestamp: 1 }],
				turnPrefixMessages: [],
			},
			new AbortController().signal,
		);
		expect(result).toEqual({ failure: "summary input exceeds model window" });
		expect(calls).toBe(0);
		expect(
			logs.map((line) => JSON.parse(line)).find((line) => line.event === "compaction_input_rejected")?.fields,
		).toMatchObject({ category: "model_window_exceeded" });
		expect(logs.join("")).not.toContain("private-body-canary");
	} finally {
		restoreLogs();
		db.close();
	}
});

for (const compactResult of ["success", "failed", "unchanged"] as const) {
	const compactSucceeds = compactResult === "success";
	test(`image budget preflight after a failed turn preserves delivery (${compactResult})`, async () => {
		const root = mkdtempSync(join(tmpdir(), "tg-image-preflight-"));
		const { rt, db, sent } = setup();
		mkdirSync(join(root, "media"));
		writeFileSync(join(root, "media", "photo.png"), new Uint8Array(100));
		(rt as any).config.dataDir = root;
		(rt as any).config.media.mode = "context";
		(rt as any).bot.contextImageBudgetBytes = 200;
		const session = (rt as any).session;
		session.sessionManager.appendCustomMessageEntry("telegram_context_v2", "old images", false, imageDetails(1));
		(rt as any).lastTurnFailed = true;
		let compactions = 0;
		session.compact = async () => {
			compactions++;
			if (compactResult === "failed") throw new Error("summary unavailable");
			if (compactResult === "unchanged") return;
			const marker = session.sessionManager.appendCustomEntry("retained_marker", {});
			session.sessionManager.appendCompaction("summary", marker, 40000, { visibleMessageIds: [] });
		};
		const prompt = session.prompt;
		session.prompt = async () => {
			expect(session.sessionManager.buildContextEntries().filter((e: any) => e.type === "custom_message")).toHaveLength(
				0,
			);
			await prompt();
		};
		insertMessage(db, 9901, "private-preflight-canary @bot");
		const logs: string[] = [];
		const restoreLogs = setLogSink((line) => logs.push(line));
		const cursor = getConsumedSeq(db, BOT_ID, CHAT_ID);
		try {
			rt.trigger("explicit", { reason: "explicit", chatId: CHAT_ID, messageId: 9901 });
			await (rt as any).flushPromise;
			expect(compactions).toBe(1);
			expect(sent).toHaveLength(compactSucceeds ? 1 : 0);
			expect(obligationCount(db)).toBe(compactSucceeds ? 0 : 1);
			if (!compactSucceeds) {
				expect(getConsumedSeq(db, BOT_ID, CHAT_ID)).toBe(cursor);
				expect(
					logs.map((line) => JSON.parse(line)).find((line) => line.event === "context_input_rejected")?.fields.category,
				).toBe(compactResult === "failed" ? "compaction_failed" : "image_budget_exceeded");
				expect(db.query("SELECT COUNT(*) AS n FROM bot_visible_messages WHERE message_id=9901").get()).toEqual({
					n: 0,
				});
				expect(session.sessionManager.getBranch().filter((e: any) => e.type === "custom_message")).toHaveLength(1);
			}
			expect(logs.join("")).not.toContain("private-preflight-canary");
			expect(logs.join("")).not.toContain(root);
		} finally {
			restoreLogs();
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

for (const validImage of [true, false]) {
	test(`summary image transport budget preserves all images or refuses the call (${validImage})`, async () => {
		const root = mkdtempSync(join(tmpdir(), "tg-summary-budget-"));
		const { rt, db } = setup();
		mkdirSync(join(root, "media"));
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
			"base64",
		);
		writeFileSync(
			join(root, "media", "photo.png"),
			validImage ? Buffer.concat([png, Buffer.alloc(4096)]) : Buffer.alloc(4096),
		);
		(rt as any).config.dataDir = root;
		(rt as any).bot.contextImageBudgetBytes = 1000;
		(rt as any).compactionModel = { ...fakeModel(), input: ["text", "image"] };
		let calls = 0;
		(rt as any).modelRuntime = {
			streamSimple: (_model: unknown, request: any) => {
				calls++;
				const images = request.messages[0].content.filter((b: any) => b.type === "image");
				expect(images).toHaveLength(8);
				expect(images.reduce((n: number, b: any) => n + Buffer.from(b.data, "base64").length, 0)).toBeLessThanOrEqual(
					1000,
				);
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: assistantResult() });
				return stream;
			},
		};
		const messages = [1, 2].map((id) => ({
			role: "custom",
			customType: "telegram_context_v2",
			content: `photo #${id}`,
			display: false,
			timestamp: id,
			details: imageDetails(id),
		}));
		const original = JSON.stringify(messages);
		try {
			const result = await (rt as any).generateCompactionSummary(
				{ messagesToSummarize: messages, turnPrefixMessages: [] },
				new AbortController().signal,
			);
			expect(calls).toBe(validImage ? 1 : 0);
			expect(result).toMatchObject(
				validImage ? { summary: "summary" } : { failure: "summary images exceed transport budget" },
			);
			expect(JSON.stringify(messages)).toBe(original);
			expect(readFileSync(join(root, "media", "photo.png")).length).toBeGreaterThan(1000);
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
}
