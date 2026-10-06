// /model and /new swap the Pi session and epoch atomically; only human admins can trigger them.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { BotRuntime } from "../src/agent/runtime.ts";
import { createInstalledPiModelRuntime } from "../src/agent/model-runtime.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { getSessionManifest } from "../src/db/message-events.ts";
import { updateBotModelConfig } from "../src/onboarding/config-core.ts";
import { setLogSink } from "../src/observability/log.ts";
import {
	consumedControlMessageIds,
	parseTelegramControlCallback,
	parseTelegramControlCommand,
	TelegramControlCommandService,
} from "../src/telegram/control-command.ts";

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
	context_window: 65536,
	media: { mode: "context" },
	telegram_admins: [42],
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

test("mutating control commands require a human admin and never reach the provider context", async () => {
	const { root, config } = fixture();
	const db = openDb(":memory:");
	let resets = 0;
	const runtime = {
		controlSnapshot: () => {
			throw new Error("unused");
		},
		compactForControl: async () => {
			throw new Error("unused");
		},
		newSessionForControl: async () => {
			resets++;
			return { ok: true as const, epoch: 7 };
		},
		consumeControlMessage: () => {},
		changeModelForControl: async () => {
			throw new Error("unused");
		},
	};
	const service = new TelegramControlCommandService(db, config.bots, root, new Map([["A", runtime]]), [42]);
	const command = (messageId: number, from: Record<string, unknown>, text = "/new") =>
		parseTelegramControlCommand(
			{
				message: {
					message_id: messageId,
					chat: { id: CHAT },
					from,
					text,
					entities: [{ type: "bot_command", offset: 0, length: text.length }],
				},
			},
			"A",
			[{ id: "A", username: "alpha_bot" }],
		)!;
	try {
		expect((await service.handle(command(1, { id: 99 }))).text).toContain("权限不足");
		expect((await service.handle(command(2, { id: 42, is_bot: true }))).text).toBeNull();
		expect(resets).toBe(0);
		expect((await service.handle(command(3, { id: 42 }))).text).toContain("epoch=7");
		expect(resets).toBe(1);
		// Every command message is excluded from provider context, whatever its outcome.
		expect(consumedControlMessageIds(db, CHAT)).toEqual(new Set([1, 2, 3]));
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
		// /new keeps the model but starts an empty session in a new epoch; old bytes stay on disk.
		const beforeNew = getSessionManifest(db, bot.id)!;
		const beforeNewBytes = readFileSync(beforeNew.sessionFile, "utf8");
		expect(await runtime.newSessionForControl()).toEqual({ ok: true, epoch: 3 });
		expect(getSessionManifest(db, bot.id)!.sessionId).not.toBe(beforeNew.sessionId);
		expect(((runtime as any).session as AgentSession).messages).toHaveLength(0);
		expect(runtime.controlSnapshot()).toMatchObject({ model: "next", epoch: 3 });
		expect(readFileSync(beforeNew.sessionFile, "utf8")).toBe(beforeNewBytes);
		expect(JSON.stringify(logs)).not.toContain("secret-canary");
	} finally {
		await runtime.stop();
		restoreLog();
		db.close();
	}
});

test("/set buttons write only preset values and only for admins", async () => {
	const { root, config } = fixture();
	const db = openDb(":memory:");
	const service = new TelegramControlCommandService(db, config.bots, root, new Map(), [42]);
	// The menu message must be a control reply this bot owns.
	db.query("INSERT INTO telegram_control_messages (chat_id, message_id) VALUES (?, 100)").run(CHAT);
	db.query(
		"INSERT INTO messages (chat_id, message_id, date, sender_id, display_name, is_bot, first_seen_by) VALUES (?, 100, 1, 777, 'bot', 1, 'A')",
	).run(CHAT);
	const tap = (data: string, from = 42) =>
		service.handle(
			parseTelegramControlCallback(
				{
					update_id: 1,
					callback_query: {
						id: "q",
						from: { id: from, is_bot: false },
						data,
						message: { message_id: 100, date: 1, chat: { id: CHAT }, from: { id: 777, is_bot: true } },
					},
				},
				"A",
				CHAT,
			)!,
		);
	try {
		expect((await tap("set:r:0.5", 99)).callbackNotice).toContain("权限不足");
		expect((await tap("set:r:0.33")).text).toBeNull();
		const applied = await tap("set:r:0.5");
		expect(applied.callbackNotice).toBe("插话概率已设为 0.5");
		expect(applied.text).toContain("插话概率：0.5");
		expect(loadConfig(root).bots[0]!.routingP).toBe(0.5);
	} finally {
		db.close();
	}
});
