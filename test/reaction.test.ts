// Regression tests for the send tool's optional reaction parameter.
// Reaction semantics (docs/cache.md v21):
// - the reaction lands on the reply_to message via setMessageReaction;
// - setMessageReaction is idempotent, so a reaction-only failure is thrown back to the
//   model for a safe retry instead of crossing the message-create commit boundary;
// - a failed reaction never downgrades an already-committed message;
// - a reaction-only send is public but is NOT the reply a direct address is owed, so the
//   v20 reply-recovery obligation survives it.
// In-memory DB + fake api; no daemon, no network.

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { executeAgentSend } from "../src/agent/send.ts";
import type { SendParams } from "../src/agent/tools.ts";
import { type BotApi, isReactionEmoji, TelegramApiError } from "../src/telegram/api.ts";
import type { AppConfig, BotConfig } from "../src/config.ts";
import { BotRuntime } from "../src/agent/runtime.ts";
import type { TelegramContextDetails } from "../src/agent/extensions/context.ts";
import { SessionManager, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";

const CHAT_ID = -1004402809405;

test("reaction emoji whitelist follows the Bot API enum", () => {
	// canonical members, including ZWJ sequences
	for (const emoji of ["👍", "👎", "🔥", "🤣", "🎉", "❤️‍🔥", "👨‍💻", "🤷‍♂️", "🤷‍♀️"]) {
		expect(isReactionEmoji(emoji)).toBe(true);
	}
	// variation-selector-free spellings of the same emoji also pass
	expect(isReactionEmoji("❤")).toBe(true);
	// famous non-reactions and composed strings are rejected
	for (const emoji of ["😂", "🥺", "👍👍", "", "like", "1️⃣"]) {
		expect(isReactionEmoji(emoji)).toBe(false);
	}
});

interface SendHarness {
	events: { kind: string; payload: Record<string, unknown> }[];
	calls: [string, ...unknown[]][];
	typingStops: number;
	send(params: SendParams): Promise<Awaited<ReturnType<typeof executeAgentSend>>>;
}

function sendHarness(options: { visible?: number[]; reactionError?: unknown } = {}): SendHarness {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const events: SendHarness["events"] = [];
	const calls: SendHarness["calls"] = [];
	let sentId = 9000;
	const handle: SendHarness = {
		events,
		calls,
		typingStops: 0,
		send: (params) =>
			executeAgentSend(params, {
				db,
				api: {
					sendMessageWithEntities: async (chatId: number, text: string, _entities: unknown, replyTo?: number) => {
						calls.push(["sendMessage", chatId, text, replyTo ?? null]);
						return {
							chat: { id: chatId },
							message_id: ++sentId,
							date: 100,
							from: { id: 123, is_bot: true, first_name: "Bot" },
							text,
						};
					},
					setMessageReaction: async (chatId: number, messageId: number, emoji: string) => {
						calls.push(["setMessageReaction", chatId, messageId, emoji]);
						if (options.reactionError) throw options.reactionError;
						return true;
					},
				} as unknown as BotApi,
				botId: "A",
				chatId: CHAT_ID,
				emitMediaUpdates: false,
				visibleMessageIds: new Set(options.visible ?? []),
				triggerMessageId: null,
				recordPublicSend: () => {},
				markVisible: () => {},
				onSent: () => {},
				recordEvent: (kind, payload) => events.push({ kind, payload: payload as Record<string, unknown> }),
				stopTyping: () => {
					handle.typingStops++;
				},
				recordDuration: () => {},
			}),
	};
	return handle;
}

test("a reaction-only send applies the reaction and terminates without creating a message", async () => {
	const h = sendHarness({ visible: [42] });
	const result = await h.send({ reaction: "🔥", reply_to: 42 });
	expect(result.content[0].text).toBe("ok");
	expect(result.terminate).toBe(true);
	expect(result.details.sent).toEqual([]);
	expect(h.calls).toEqual([["setMessageReaction", CHAT_ID, 42, "🔥"]]);
	const sendEvent = h.events.find((event) => event.kind === "send");
	expect(sendEvent?.payload).toMatchObject({ reply_to: 42, reaction: "🔥", reacted_to: 42, sent: [] });
	expect(h.typingStops).toBeGreaterThan(0);
});

test("a message and a reaction travel together; the reaction lands on the replied message", async () => {
	const h = sendHarness({ visible: [42] });
	const result = await h.send({ message: "收到", reaction: "👍", reply_to: 42 });
	expect(result.details.sent).toHaveLength(1);
	expect(h.calls).toEqual([
		["sendMessage", CHAT_ID, "收到", 42],
		["setMessageReaction", CHAT_ID, 42, "👍"],
	]);
	const sendEvent = h.events.find((event) => event.kind === "send");
	expect(sendEvent?.payload).toMatchObject({ reaction: "👍", reacted_to: 42 });
});

test("an invalid reaction emoji is rejected before any network call", async () => {
	const h = sendHarness({ visible: [42] });
	await expect(h.send({ reaction: "🥺", reply_to: 42 })).rejects.toThrow("invalid reaction emoji");
	expect(h.calls).toEqual([]);
});

test("a reaction without reply_to has no target and is rejected preflight", async () => {
	const h = sendHarness({ visible: [42] });
	await expect(h.send({ reaction: "🔥" })).rejects.toThrow("reply_to");
	expect(h.calls).toEqual([]);
});

test("a reaction cannot target an invisible message", async () => {
	const h = sendHarness({ visible: [42] });
	await expect(h.send({ reaction: "🔥", reply_to: 43 })).rejects.toThrow("reply_not_visible");
	expect(h.calls).toEqual([]);
});

test("a failed reaction never downgrades an already-committed message", async () => {
	const h = sendHarness({
		visible: [42],
		reactionError: new TelegramApiError(400, "REACTION_INVALID"),
	});
	const result = await h.send({ message: "收到", reaction: "👍", reply_to: 42 });
	expect(result.content[0].text).toBe("ok");
	expect(result.details.sent).toHaveLength(1);
	const failed = h.events.find((event) => event.kind === "reaction_failed");
	expect(failed?.payload).toMatchObject({ message_id: 42 });
	const sendEvent = h.events.find((event) => event.kind === "send");
	expect(sendEvent?.payload).toMatchObject({ reaction: "👍", reacted_to: null });
});

test("a failed reaction-only call throws so the model can retry the idempotent call", async () => {
	const h = sendHarness({
		visible: [42],
		reactionError: new TelegramApiError(400, "REACTION_INVALID"),
	});
	await expect(h.send({ reaction: "👍", reply_to: 42 })).rejects.toThrow("REACTION_INVALID");
	expect(h.typingStops).toBeGreaterThan(0);
	expect(h.events.find((event) => event.kind === "send")).toBeUndefined();
});

// --- runtime integration: reaction vs the direct-address delivery guarantee ---

function makeBot(): BotConfig {
	return {
		id: "A",
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

test("a reaction-only turn does not clear a direct-address obligation; the owed reply still lands", async () => {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const bot = makeBot();
	const config = makeConfig(bot);
	const modelRuntime = { getModel: () => fakeModel() } as unknown as ModelRuntime;
	const reactions: [number, number, string][] = [];
	const rt = new BotRuntime(db, bot, config, modelRuntime, {
		api: {
			sendMessageWithEntities: async () => ({
				chat: { id: CHAT_ID },
				message_id: 9100,
				date: 100,
				from: { id: 123, is_bot: true, first_name: "Bot" },
				text: "fixture reply",
			}),
			setMessageReaction: async (chatId: number, messageId: number, emoji: string) => {
				reactions.push([chatId, messageId, emoji]);
				return true;
			},
		} as unknown as BotApi,
		chatActionSender: async () => {},
		videoTranscoder: { ffmpeg: false, ffprobe: false },
	});
	(rt as never as { model: unknown }).model = fakeModel();
	const sessionManager = SessionManager.inMemory("/tmp/unused");
	const turnContext = () => (rt as never as { pendingTurnContext: TelegramContextDetails | null }).pendingTurnContext;
	const session = {
		settingsManager: SettingsManager.inMemory(),
		sessionManager,
		getContextUsage: () => null,
		prompt: async () => {
			const details = turnContext();
			if (details) sessionManager.appendCustomMessageEntry("telegram_context_v2", details.providerText, false, details);
		},
	};
	(rt as never as { session: unknown }).session = session;
	const messageId = 9200;
	db.query(
		`INSERT INTO messages
			(chat_id, message_id, date, sender_id, display_name, username, is_bot, text, first_seen_by)
		 VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'A')`,
	).run(CHAT_ID, messageId, 1_754_612_345, 111, "Alice", "alice", "hello @bot");
	const obligationCount = () =>
		(db.query("SELECT COUNT(*) count FROM reply_obligations").get() as { count: number }).count;

	// The turn reacts instead of replying.
	const append = session.prompt;
	let reacted = false;
	const react = async () => {
		await append();
		if (reacted) return;
		reacted = true;
		const result = await (
			rt as never as { executeSend: (params: SendParams) => Promise<{ terminate: boolean }> }
		).executeSend({ reaction: "🔥", reply_to: messageId });
		expect(result.terminate).toBe(true);
	};
	let repairs = 0;
	session.prompt = async () => {
		if (turnContext()) return react();
		repairs++;
	};
	rt.trigger("explicit", { reason: "explicit", chatId: CHAT_ID, messageId });
	await (rt as never as { flushPromise: Promise<void> }).flushPromise;
	expect(reactions).toEqual([[CHAT_ID, messageId, "🔥"]]);
	// A reaction is not the public reply the direct address is owed: one repair, still owed.
	expect(repairs).toBe(1);
	expect(obligationCount()).toBe(1);

	// The repair turn's real send clears the obligation.
	session.prompt = async () => {
		if (turnContext()) return react();
		repairs++;
		await (rt as never as { executeSend: (params: SendParams) => Promise<unknown> }).executeSend({
			message: "fixture reply",
		});
	};
	rt.trigger("explicit");
	await (rt as never as { flushPromise: Promise<void> }).flushPromise;
	expect(repairs).toBe(2);
	expect(obligationCount()).toBe(0);
	db.close();
});
