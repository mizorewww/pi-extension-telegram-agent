// Delivery invariants: a direct address stays owed until a public send settles it, an unknown
// send is never repeated, and compaction keeps Pi-native semantics. No daemon, no network.

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardProviderCall } from "../src/agent/provider-guard.ts";
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
import { makeTelegramCompactionExtension } from "../src/agent/extensions/index.ts";

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
		contextWindow: 65536,
		media: { mode: "off", visionModel: "test/vision:off", maxPerTurn: 2, concurrency: 2 },
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
	expect(obligationCount(db)).toBe(1);
	(rt as any).flushing = false;
	expect(rt.trigger("explicit", { reason: "explicit", chatId: CHAT_ID, messageId })).toBe("started");
	await (rt as any).flushPromise;
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain(`#${messageId}`);
	expect(obligationCount(db)).toBe(0);
});

test("a provider turn that ends in error keeps the direct-address obligation and records no usage", async () => {
	// Production 429s once marked @mentions delivered and wrote one zero-usage row per attempt.
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

for (const mode of ["automatic", "cancelled"] as const) {
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
			else expect((await rt.compactForControl()).ok).toBe(false);
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

for (const failure of ["auth", "overflow", "persistent_transport"] as const) {
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
