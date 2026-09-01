process.env.TZ = "Asia/Singapore";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { BotConfig } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { restoreLastCompaction } from "../src/agent/runtime.ts";
import { BotApi, TelegramApiError } from "../src/telegram/api.ts";
import { TelegramTypingLease } from "../src/telegram/activity.ts";
import {
	TelegramControlCommandService,
	type ParsedTelegramControlCommand,
	type TelegramControlResult,
} from "../src/telegram/control-command.ts";
import { TelegramControlCoordinator } from "../src/telegram/control-integration.ts";
import {
	isDeterministicRichRejection,
	sendRichTextAndPersist,
	SentMessagePersistenceError,
} from "../src/telegram/send.ts";

const CHAT_ID = -1001234567890;
const RICH_MARKDOWN = "# Telegram Agent 状态\n\n## Bot A";
const PLAIN_FALLBACK = "Telegram Agent 状态\nBot A";

let db: Database;

beforeEach(() => {
	db = openDb(":memory:");
});

afterEach(() => {
	db.close();
});

test("typing stop aborts an in-flight action so it cannot reappear after a fast reply", async () => {
	let aborted = false;
	const lease = new TelegramTypingLease(
		(signal) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => {
					aborted = true;
					reject(signal.reason);
				});
			}),
	);
	lease.start();
	expect(lease.stop()).toBe(true);
	await Bun.sleep(0);
	expect(aborted).toBe(true);
});

function telegramMessage(messageId: number, rich: boolean): Record<string, unknown> {
	return {
		chat: { id: CHAT_ID, type: "supergroup", title: "test" },
		message_id: messageId,
		from: { id: 777, is_bot: true, first_name: "Bot A" },
		date: 1_786_251_069,
		...(rich
			? { rich_message: { blocks: [{ type: "heading", text: "Telegram Agent 状态" }] } }
			: { text: PLAIN_FALLBACK }),
	};
}

function statusCommand(): ParsedTelegramControlCommand {
	return {
		chatId: CHAT_ID,
		messageId: 42,
		edited: false,
		receivedByBotId: "A",
		replyBotId: "A",
		sender: { id: 1, username: "@operator", isBot: false, hasSenderChat: false },
		action: { kind: "status" },
	};
}

describe("Telegram rich control status", () => {
	test("BotApi sends InputRichMessage markdown with reply parameters", async () => {
		const api = new BotApi("test-token");
		const calls: unknown[] = [];
		(api as unknown as { call(method: string, params: unknown): Promise<unknown> }).call = async (method, params) => {
			calls.push({ method, params });
			return telegramMessage(100, true);
		};

		await api.sendRichMessage(CHAT_ID, RICH_MARKDOWN, 42);

		expect(calls).toEqual([
			{
				method: "sendRichMessage",
				params: {
					chat_id: CHAT_ID,
					rich_message: { markdown: RICH_MARKDOWN },
					reply_parameters: { message_id: 42 },
				},
			},
		]);
	});

	test("status formatter returns bounded rich Markdown and an independent plain projection", async () => {
		const bot = {
			id: "A",
			name: "Bot *A*",
			token: "test",
			personaPath: "/tmp/persona",
			routingP: 0.25,
			samplingCooldownMs: 2000,
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			reasoningEffort: "low",
			compactionThreshold: 128_000,
			compactionKeepRecent: 16_000,
			compactionModel: "openai-codex/gpt-5.6-luna:low",
			cacheRetention: "short",
			providerTimeoutMs: 300_000,
			providerRetries: 2,
			maxSuffixTokens: 12_000,
			maxMessageTokens: 4_096,
			tools: { send: true, search: false, runJs: false },
			stickerSets: [],
		} satisfies BotConfig;
		const emptyBot = { ...bot, id: "B", name: "Bot B", token: "test-b" } satisfies BotConfig;
		db.query(
			`INSERT INTO llm_runs
			 (bot_id, ts, model, epoch, context_tokens, cache_read, cache_write, cache_miss,
			  output_tokens, reasoning_tokens, latency_ms, cost,
			  system_tokens, tools_tokens, compacted_history_tokens, message_tokens)
			 VALUES ('A', 1786251069000, 'gpt-5.6-luna', 3, 1000, 700, 50, 250, 120, 30, 1250, 0.125,
			         400, 200, 150, 250)`,
		).run();
		const runtime = {
			controlSnapshot: () => ({
				state: "idle" as const,
				epoch: 3,
				provider: "openai-codex",
				model: "gpt-5.6-luna",
				reasoningEffort: "high" as const,
				contextWindow: 128_000,
				currentContextTokens: 777,
				routingP: 0.25,
				samplingCooldownMs: 2_000,
				lastCompact: { at: 1_786_251_069_000, outcome: "ok" as const },
			}),
			compactForControl: async () => ({ ok: false as const, code: "busy" as const }),
			consumeControlMessage: () => {},
		};
		const service = new TelegramControlCommandService(
			db,
			[bot, emptyBot],
			"/tmp",
			new Map([
				["A", runtime],
				["B", runtime],
			]),
			[],
		);

		const result = await service.handle(statusCommand());

		expect(result.richText).toContain("# Telegram Agent 状态");
		expect(result.richText).toContain("Bot \\*A\\*");
		expect(result.richText).toContain("epoch 3");
		expect(result.richText).toContain("reasoning high");
		expect(result.richText).toContain("cooldown 2,000 ms");
		expect(result.richText).toContain("当前上下文**：777 / 128,000 (0.6%)");

		expect(result.richText).toContain("- **上下文构成**：\n");
		expect(result.richText).toContain("🟥 `system prompt");
		expect(result.richText).toContain("↑miss 250 · ↓output 120 · R 700 · W 50 · reasoning 30");
		expect(result.richText).toContain("prompt 1,000");
		expect(result.richText).toContain("CH 70.0%");
		expect(result.richText).not.toContain("Bot B");
		expect(result.richText).not.toContain("```text\n");
		expect(result.richText).toContain("avg 1.25 s");
		expect(result.richText).toContain("$0.1250");
		expect(result.richText!.length).toBeLessThanOrEqual(3500);
		expect(result.text).toContain("A · Bot *A*");
		expect(result.text).toContain("routing=routing 0.25 · cooldown 2,000 ms");
		expect(result.text).toContain("context_current=777 / 128,000 (0.6%)");
		expect(result.text).toContain("lifetime_usage=prompt 1,000");
		expect(result.text).toContain("cache_and_cost=CH 70.0% · $0.1250");
		expect(result.text).not.toContain("B · Bot B");
		expect(result.text).not.toBe(result.richText);
	});

	test("coordinator sends and persists the rich reply once", async () => {
		const calls: string[] = [];
		const consumed: number[] = [];
		const result: TelegramControlResult = {
			chatId: CHAT_ID,
			replyToMessageId: 42,
			replyBotId: "A",
			text: PLAIN_FALLBACK,
			richText: RICH_MARKDOWN,
		};
		const coordinator = new TelegramControlCoordinator(
			db,
			{
				handle: async () => result,
				consumeReply: (_botId, _chatId, messageId) => {
					consumed.push(messageId);
				},
			},
			new Map([
				[
					"A",
					{
						sendRichMessage: async () => {
							calls.push("rich");
							return telegramMessage(100, true);
						},
						sendMessage: async () => {
							calls.push("plain");
							return telegramMessage(101, false);
						},
					},
				],
			]),
		);

		expect(await coordinator.handle(statusCommand())).toEqual({
			outcome: "sent",
			botId: "A",
			chatId: CHAT_ID,
			messageId: 100,
		});
		expect(calls).toEqual(["rich"]);
		expect(consumed).toEqual([100]);
		expect(db.query("SELECT text, rich_message FROM messages WHERE message_id = 100").get()).toEqual({
			text: "Telegram Agent 状态",
			rich_message: JSON.stringify(telegramMessage(100, true).rich_message),
		});
	});

	test("only a deterministic rich rejection falls back to the plain projection", async () => {
		expect(isDeterministicRichRejection(new TelegramApiError(404, "Not Found"))).toBe(true);
		expect(
			isDeterministicRichRejection(new TelegramApiError(400, "Bad Request: message to be replied not found")),
		).toBe(false);
		expect(isDeterministicRichRejection(new TelegramApiError(429, "Too Many Requests"))).toBe(false);
		expect(isDeterministicRichRejection(new TelegramApiError(500, "Internal Server Error"))).toBe(false);

		const calls: unknown[] = [];
		const api = {
			sendRichMessage: async () => {
				calls.push("rich");
				throw new TelegramApiError(400, "Bad Request: can't parse rich message markdown");
			},
			sendMessage: async (_chatId: number, text: string) => {
				calls.push({ plain: text });
				return telegramMessage(101, false);
			},
		};

		const sent = await sendRichTextAndPersist(db, api, "A", CHAT_ID, RICH_MARKDOWN, PLAIN_FALLBACK, 42);
		expect(sent.transport).toBe("plain_fallback");
		expect(calls).toEqual(["rich", { plain: PLAIN_FALLBACK }]);
		expect(db.query("SELECT COUNT(*) count FROM messages").get()).toEqual({ count: 1 });
	});

	test("unknown rich outcomes never retry plain or retry after persistence", async () => {
		let plainCalls = 0;
		const upstream = new TelegramApiError(500, "Internal Server Error");
		await expect(
			sendRichTextAndPersist(
				db,
				{
					sendRichMessage: async () => {
						throw upstream;
					},
					sendMessage: async () => {
						plainCalls++;
						return telegramMessage(102, false);
					},
				},
				"A",
				CHAT_ID,
				RICH_MARKDOWN,
				PLAIN_FALLBACK,
			),
		).rejects.toBe(upstream);
		expect(plainCalls).toBe(0);

		const closed = openDb(":memory:");
		closed.close();
		let richCalls = 0;
		await expect(
			sendRichTextAndPersist(
				closed,
				{
					sendRichMessage: async () => {
						richCalls++;
						return telegramMessage(103, true);
					},
					sendMessage: async () => telegramMessage(104, false),
				},
				"A",
				CHAT_ID,
				RICH_MARKDOWN,
				PLAIN_FALLBACK,
			),
		).rejects.toBeInstanceOf(SentMessagePersistenceError);
		expect(richCalls).toBe(1);
	});
});

describe("restoreLastCompaction", () => {
	test("returns null when no compaction events exist", () => {
		expect(restoreLastCompaction(db, "A")).toBeNull();
	});

	test("restores the latest successful compaction timestamp after restart", () => {
		db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('A', 1000, 'compaction', '{}')").run();
		db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('A', 2000, 'compaction', '{}')").run();
		expect(restoreLastCompaction(db, "A")).toEqual({ at: 2000, outcome: "ok" });
	});

	test("maps the latest compaction failure to outcome failed", () => {
		db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('A', 1000, 'compaction', '{}')").run();
		db.query(
			'INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (\'A\', 3000, \'error\', \'{"stage":"compaction","reason":"manual"}\')',
		).run();
		expect(restoreLastCompaction(db, "A")).toEqual({ at: 3000, outcome: "failed" });
	});

	test("ignores compaction events from other bots and unrelated errors", () => {
		db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('B', 9000, 'compaction', '{}')").run();
		db.query(
			"INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('A', 500, 'error', '{\"stage\":\"send\"}')",
		).run();
		expect(restoreLastCompaction(db, "A")).toBeNull();
	});
});
