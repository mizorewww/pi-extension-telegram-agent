import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { BotRuntime } from "../src/agent/runtime.ts";
import { createInstalledPiModelRuntime } from "../src/agent/model-runtime.ts";
import { loadConfig, type BotConfig } from "../src/config.ts";
import { openDb, getBotState } from "../src/db/db.ts";
import { getSessionManifest } from "../src/db/message-events.ts";
import { updateBotModelConfig } from "../src/onboarding/config-core.ts";
import { setLogSink } from "../src/observability/log.ts";
import { BotApi, type InlineKeyboardMarkup } from "../src/telegram/api.ts";
import {
	consumedControlMessageIds,
	parseTelegramControlCallback,
	parseTelegramControlCommand,
	TelegramControlCommandService,
} from "../src/telegram/control-command.ts";
import {
	TELEGRAM_CONTROL_MENU,
	TelegramControlCoordinator,
	type TelegramControlApi,
} from "../src/telegram/control-integration.ts";
import { modelMenuKey, renderModelMenu } from "../src/telegram/model-menu.ts";
import { Poller } from "../src/telegram/poller.ts";

const CHAT = -1001234567890;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function model(id: string, provider = "fixture"): Model<Api> {
	return {
		id,
		provider,
		name: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 65536,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "tg-model-menu-"));
	roots.push(root);
	writeFileSync(join(root, "persona.md"), "fixture persona");
	writeFileSync(join(root, ".env"), "bot_a_token: fixture-a\nbot_b_token: fixture-b\n");
	writeFileSync(
		join(root, "telegram.config.ts"),
		`export default {
	group_peer_id: 1234567890,
	provider: "fixture",
	model: "old",
	reasoning_effort: "off",
	compaction_model: "fixture/old:low",
	auxiliary_visual_model: "fixture/old:low",
	context_window: 65536,
	media: { mode: "context" },
	telegram_admins: [42],
	tools: { send: true, search: false, run_js: false },
	bots: [
		{
			id: "A", // primary bot
			name: "Bot A",
			token_env: "bot_a_token",
			persona_path: "persona.md",
			routing_p: 0,
		},
		{
			id: "B",
			name: "Bot B",
			token_env: "bot_b_token",
			persona_path: "persona.md",
			provider: 'other', // must remain untouched
			model: 'other-model',
			routing_p: 0,
		},
	],
};\n`,
	);
	return { root, config: loadConfig(root) };
}

function callback(data: string, sender = 42, chatId = CHAT, messageId = 100) {
	return {
		update_id: 51,
		callback_query: {
			id: "callback-1",
			from: { id: sender, is_bot: false },
			data,
			message: { message_id: messageId, date: 100, chat: { id: chatId }, from: { id: 777, is_bot: true } },
		},
	};
}

test("every Pi model is reachable through bounded buttons, independent of catalog order and long names", () => {
	const bot = { name: "Bot", provider: "fixture", model: "current", reasoningEffort: "off" } as BotConfig;
	const models = Array.from({ length: 145 }, (_, i) => model(`model-${i}-${"长".repeat(40)}`, `provider-${i % 13}`));
	const pending = ["model:r:0"];
	const pages = new Set<string>();
	const selected = new Set<string>();
	while (pending.length) {
		const data = pending.pop()!;
		if (pages.has(data)) continue;
		pages.add(data);
		const view = renderModelMenu(bot, models, data)!;
		expect(view).not.toBeNull();
		expect(view).toEqual(renderModelMenu(bot, [...models].reverse(), data)!);
		for (const button of view.replyMarkup.inline_keyboard.flat()) {
			expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
			if (button.callback_data.startsWith("model:s:")) selected.add(button.callback_data);
			else pending.push(button.callback_data);
		}
	}
	expect(selected.size).toBe(models.length);
	expect(renderModelMenu(bot, models, "model:r:999999")).toBeNull();
	expect(TELEGRAM_CONTROL_MENU.some((entry) => entry.command === "model")).toBe(true);
});

test("model config writes all selection fields atomically, preserves other bots, and rolls back exactly", () => {
	const { root, config } = fixture();
	const path = join(root, "telegram.config.ts");
	const original = readFileSync(path, "utf8");
	const selection = { provider: "new-provider", model: 'quote"slash/美元$&', reasoningEffort: "off" as const };
	const write = updateBotModelConfig(root, "A", selection);
	expect(loadConfig(root).bots[0]).toMatchObject(selection);
	expect(loadConfig(root).bots[1]).toEqual(config.bots[1]);
	write.rollback();
	expect(readFileSync(path, "utf8")).toBe(original);
	updateBotModelConfig(root, "A", selection).finalize();
	updateBotModelConfig(root, "A", { ...selection, model: "second" }).finalize();
	expect(loadConfig(root).bots[0]?.model).toBe("second");
	expect(() => updateBotModelConfig(root, "A", { ...selection, provider: "" })).toThrow();
	expect(loadConfig(root).bots[0]?.model).toBe("second");
});

test("callbacks require a human admin, the configured group, and a menu owned by the receiving bot", async () => {
	const { root, config } = fixture();
	const db = openDb(":memory:");
	let changes = 0;
	const runtime = {
		controlSnapshot: () => {
			throw new Error("unused");
		},
		compactForControl: async () => {
			throw new Error("unused");
		},
		consumeControlMessage: () => {},
		changeModelForControl: async () => {
			changes++;
			return { ok: true as const, epoch: 2, reasoningEffort: "off" as const };
		},
	};
	const service = new TelegramControlCommandService(
		db,
		config.bots,
		root,
		new Map([
			["A", runtime],
			["B", runtime],
		]),
		[42],
		undefined,
		{ getAvailableSnapshot: () => [model("next")] },
	);
	const edits: string[] = [];
	const answers: (string | undefined)[] = [];
	let markup: InlineKeyboardMarkup | undefined;
	const api: TelegramControlApi = {
		sendRichMessage: async () => {
			throw new Error("unused");
		},
		sendMessage: async (_chat, text, _reply, keyboard) => {
			markup = keyboard;
			return {
				message_id: 100,
				date: 100,
				chat: { id: CHAT },
				from: { id: 777, is_bot: true, first_name: "Bot" },
				text,
			};
		},
		answerCallbackQuery: async (_id, text) => {
			answers.push(text);
			return true;
		},
		editMessageText: async (_chat, id, text) => {
			edits.push(text);
			return {
				message_id: id,
				date: 100,
				edit_date: 101 + edits.length,
				chat: { id: CHAT },
				from: { id: 777, is_bot: true, first_name: "Bot" },
				text,
			};
		},
	};
	const coordinator = new TelegramControlCoordinator(
		db,
		service,
		new Map([
			["A", api],
			["B", api],
		]),
	);
	try {
		const command = parseTelegramControlCommand(
			{
				message: {
					message_id: 1,
					chat: { id: CHAT },
					from: { id: 42 },
					text: "/model@alpha_bot",
					entities: [{ type: "bot_command", offset: 0, length: 16 }],
				},
			},
			"B",
			[
				{ id: "A", username: "alpha_bot" },
				{ id: "B", username: "bravo_bot" },
			],
		)!;
		expect(command.replyBotId).toBe("A");
		expect(await coordinator.handle(command)).toMatchObject({ outcome: "sent" });
		expect(markup?.inline_keyboard.length).toBeGreaterThan(0);
		expect(consumedControlMessageIds(db, CHAT)).toEqual(new Set([1, 100]));
		expect(parseTelegramControlCallback(callback("model:r:0", 42, CHAT - 1), "A", CHAT)).toBeNull();
		const data = `model:s:${modelMenuKey("fixture", "next")}`;
		for (const [update, botId] of [
			[callback(data, 99), "A"],
			[callback(data), "B"],
			[callback(data, 42, CHAT, 999), "A"],
			[
				{ ...callback(data), callback_query: { ...callback(data).callback_query, from: { id: 42, is_bot: true } } },
				"A",
			],
		] as const) {
			await coordinator.handle(parseTelegramControlCallback(update, botId, CHAT)!);
		}
		expect(changes).toBe(0);
		expect(edits).toHaveLength(0);
		expect(answers.every(Boolean)).toBe(true);
		await coordinator.handle(parseTelegramControlCallback(callback(data), "A", CHAT)!);
		expect(changes).toBe(1);
		expect(edits).toHaveLength(1);
		expect(consumedControlMessageIds(db, CHAT)).toEqual(new Set([1, 100]));
		expect(db.query("SELECT text FROM messages WHERE message_id = 100").get()).toEqual({ text: edits[0] });
	} finally {
		db.close();
	}
});

test("poller handles callbacks before advancing offset without creating messages or LLM dispatches", async () => {
	const db = openDb(":memory:");
	let callbacks = 0;
	const update = callback("model:r:0");
	const poller = new Poller(
		db,
		"A",
		"unused",
		CHAT,
		() => {
			throw new Error("callback reached routing");
		},
		true,
		async () => {
			expect(getBotState(db, "A", "update_offset")).toBeNull();
			callbacks++;
		},
	);
	let polls = 0;
	(poller as any).api = {
		getUpdates: async () => {
			if (polls++) {
				poller.stop();
				return [];
			}
			return [update, update];
		},
	};
	try {
		await poller.run();
		expect(callbacks).toBe(1);
		expect(getBotState(db, "A", "update_offset")).toBe("52");
		expect(db.query("SELECT COUNT(*) n FROM messages").get()).toEqual({ n: 0 });
		expect(db.query("SELECT COUNT(*) n FROM pending_telegram_dispatch").get()).toEqual({ n: 0 });
		const api = new BotApi("unused");
		const calls: unknown[] = [];
		api.call = async (method, params) => {
			calls.push({ method, params });
			return [] as any;
		};
		await api.getUpdates(1, 25);
		expect(calls).toMatchObject([
			{ method: "getUpdates", params: { allowed_updates: ["message", "edited_message", "callback_query"] } },
		]);
	} finally {
		db.close();
	}
});

test("live selection rotates Pi session and epoch, survives reload, and failed writes leave the old model intact", async () => {
	const { root } = fixture();
	const sourcePath = join(root, "telegram.config.ts");
	writeFileSync(
		sourcePath,
		readFileSync(sourcePath, "utf8").replace('reasoning_effort: "off"', 'reasoning_effort: "high"'),
	);
	const config = loadConfig(root);
	const agentDir = join(root, "pi");
	mkdirSync(agentDir);
	const models = [{ ...model("old"), reasoning: true }, model("next"), { ...model("text-only"), input: ["text"] }];
	writeFileSync(
		join(agentDir, "provider.ts"),
		`export default pi => pi.registerProvider("fixture", { baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "fixture", models: ${JSON.stringify(models)} });`,
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [join(agentDir, "provider.ts")] }));
	const modelsRuntime = await createInstalledPiModelRuntime({ cwd: root, agentDir });
	const db = openDb(":memory:");
	const bot = config.bots[0]!;
	const runtime = new BotRuntime(db, bot, config, modelsRuntime, {
		videoTranscoder: { ffmpeg: false, ffprobe: false },
		chatActionSender: async () => {},
	});
	const logs: unknown[] = [];
	const restoreLog = setLogSink((record) => logs.push(JSON.parse(record)));
	try {
		await runtime.init();
		expect((runtime as any).session.settingsManager.getCacheWarmingMode()).toBe("off");
		const before = getSessionManifest(db, bot.id)!;
		const history: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "history-canary" }],
			api: "openai-completions",
			provider: "fixture",
			model: "old",
			stopReason: "stop",
			timestamp: 1,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		((runtime as any).session as AgentSession).sessionManager.appendMessage(history);
		const previousBytes = readFileSync(before.sessionFile, "utf8");
		const original = readFileSync(join(root, "telegram.config.ts"), "utf8");
		const persist = (selection: Parameters<typeof updateBotModelConfig>[2]) =>
			updateBotModelConfig(root, bot.id, selection);
		expect(await runtime.changeModelForControl("fixture", "text-only", persist)).toEqual({
			ok: false,
			code: "image_input_unsupported",
		});
		(runtime as any).flushing = true;
		expect(await runtime.changeModelForControl("fixture", "next", persist)).toEqual({ ok: false, code: "busy" });
		(runtime as any).flushing = false;
		expect(
			await runtime.changeModelForControl("fixture", "next", () => {
				throw new Error("secret-canary");
			}),
		).toEqual({ ok: false, code: "config_write_failed" });
		expect(getSessionManifest(db, bot.id)).toEqual(before);
		expect(bot.model).toBe("old");
		expect(readFileSync(join(root, "telegram.config.ts"), "utf8")).toBe(original);
		db.exec(
			"CREATE TEMP TRIGGER reject_model_manifest BEFORE UPDATE ON bot_session_manifest BEGIN SELECT RAISE(FAIL, 'fixture'); END",
		);
		expect(await runtime.changeModelForControl("fixture", "next", persist)).toEqual({ ok: false, code: "failed" });
		db.exec("DROP TRIGGER reject_model_manifest");
		expect(getSessionManifest(db, bot.id)).toEqual(before);
		expect(readFileSync(join(root, "telegram.config.ts"), "utf8")).toBe(original);
		expect(await runtime.changeModelForControl("fixture", "next", persist)).toMatchObject({ ok: true, epoch: 2 });
		const after = getSessionManifest(db, bot.id)!;
		expect(after.sessionId).not.toBe(before.sessionId);
		expect(after.contextFingerprint).not.toBe(before.contextFingerprint);
		expect(runtime.controlSnapshot()).toMatchObject({
			provider: "fixture",
			model: "next",
			epoch: 2,
			currentContextTokens: 0,
		});
		expect(loadConfig(root).bots[0]).toMatchObject({ provider: "fixture", model: "next", reasoningEffort: "off" });
		expect(
			await runtime.changeModelForControl("fixture", "next", () => {
				throw new Error("must not rewrite config");
			}),
		).toMatchObject({ ok: true, epoch: 2 });
		expect(getSessionManifest(db, bot.id)).toEqual(after);
		expect(readFileSync(before.sessionFile, "utf8")).toBe(previousBytes);
		const currentSession = (runtime as any).session as AgentSession;
		expect(currentSession.messages).toHaveLength(0);
		currentSession.sessionManager.appendMessage({ ...history, model: "next" });
		const reloaded = loadConfig(root);
		const restarted = new BotRuntime(db, reloaded.bots[0]!, reloaded, modelsRuntime, {
			videoTranscoder: { ffmpeg: false, ffprobe: false },
			chatActionSender: async () => {},
		});
		try {
			await restarted.init();
			expect(getSessionManifest(db, bot.id)).toEqual(after);
			expect(restarted.controlSnapshot()).toMatchObject({ model: "next", epoch: 2 });
		} finally {
			await restarted.stop();
		}
		expect(JSON.stringify(logs)).not.toContain("secret-canary");
		expect(logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ event: "model_changed" }),
				expect.objectContaining({ event: "model_change_failed" }),
			]),
		);
	} finally {
		await runtime.stop();
		restoreLog();
		db.close();
	}
});
