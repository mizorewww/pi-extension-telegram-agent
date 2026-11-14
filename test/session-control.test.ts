// Only human admins mutate the selected external config, and no control command reaches provider context.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDirectory, defaultConfigPath, loadConfig, stateDirectory } from "../src/config.ts";
import { updateBotModelConfig } from "../src/onboarding/config-core.ts";
import { addCron, describeCrons, parseSchedule, removeCron, tickCrons } from "../src/agent/cron.ts";
import { openDb } from "../src/db/db.ts";
import {
	consumedControlMessageIds,
	parseTelegramControlCommand,
	parseTelegramControlCallback,
	TelegramControlCommandService,
} from "../src/telegram/control-command.ts";

const CHAT = -1001234567890;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const base = mkdtempSync(join(tmpdir(), "tg-model-menu-"));
	roots.push(base);
	const root = join(base, "config");
	mkdirSync(root);
	writeFileSync(join(root, "persona.md"), "fixture persona");
	writeFileSync(join(root, ".env"), "bot_token: fixture\n");
	writeFileSync(
		join(root, "telegram.config.ts"),
		`export default {
	group_peer_id: 1234567890,
	name: "Bot A",
	token_env: "bot_token",
	persona_path: "persona.md",
	provider: "fixture",
	model: "old",
	reasoning_effort: "off",
	decider: {
		model: "openrouter/fixture-decider", // nested model must remain untouched
	},
	context_window: 65536,
	media: { mode: "off" },
	telegram_admins: [42],
};\n`,
	);
	return { root, config: loadConfig(root, { stateDir: join(base, "state") }) };
}

test("external config discovery and hot writes stay independent of the installed program", () => {
	const { root, config } = fixture();
	const previous = { config: process.env.TG_CONFIG_DIR, state: process.env.TG_STATE_DIR };
	try {
		delete process.env.TG_CONFIG_DIR;
		delete process.env.TG_STATE_DIR;
		assert.equal(configDirectory(), "/etc/pi-telegram-agent");
		assert.equal(stateDirectory(), "/var/lib/pi-telegram-agent");
		process.env.TG_CONFIG_DIR = root;
		process.env.TG_STATE_DIR = config.dataDir;
		const loaded = loadConfig();
		assert.equal(loaded.configDir, root);
		assert.equal(loaded.dataDir, config.dataDir);
		assert.equal(loaded.dbPath, join(config.dataDir, "agent.db"));
		assert.equal(loaded.bot.personaPath, join(root, "persona.md"));
		const original = readFileSync(defaultConfigPath(), "utf8");
		const change = updateBotModelConfig(root, { provider: "fixture", model: "new", reasoningEffort: "off" });
		assert.equal(loadConfig().bot.model, "new");
		assert.equal(loadConfig().bot.decider?.model, "fixture-decider");
		change.rollback();
		assert.equal(readFileSync(defaultConfigPath(), "utf8"), original);
	} finally {
		if (previous.config === undefined) delete process.env.TG_CONFIG_DIR;
		else process.env.TG_CONFIG_DIR = previous.config;
		if (previous.state === undefined) delete process.env.TG_STATE_DIR;
		else process.env.TG_STATE_DIR = previous.state;
	}
});

test("mutating control commands require a human admin and never reach the provider context", async () => {
	const { root, config } = fixture();
	const db = openDb(":memory:");
	let resets = 0;
	const cancelled: string[] = [];
	const runtime = {
		controlSnapshot: async () => {
			throw new Error("unused");
		},
		compactForControl: async () => {
			throw new Error("unused");
		},
		newSessionForControl: async () => {
			resets++;
			return { ok: true as const, epoch: 7 };
		},
		changeModelForControl: async () => {
			throw new Error("unused");
		},
		resetBoxForControl: async () => {
			throw new Error("unused");
		},
		taskStatusForControl: async () => "t1 [running] search: 调研",
		cancelTaskForControl: async (taskId: string) => {
			cancelled.push(taskId);
			return { ok: true as const };
		},
	};
	const service = new TelegramControlCommandService(db, config.bot, root, runtime, [42]);
	const command = (messageId: number, from: Record<string, unknown>, text = "/new") =>
		parseTelegramControlCommand(
			{
				message: {
					message_id: messageId,
					chat: { id: CHAT },
					from,
					text,
					entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }],
				},
			},
			"alpha_bot",
		)!;
	try {
		assert.match((await service.handle(command(1, { id: 99 }))).text!, /权限不足/);
		assert.equal((await service.handle(command(2, { id: 42, is_bot: true }))).text, null);
		assert.equal(resets, 0);
		assert.match((await service.handle(command(3, { id: 42 }))).text!, /epoch=7/);
		assert.equal(resets, 1);
		// /task is public; cancelling one is an admin mutation like the others.
		assert.match((await service.handle(command(4, { id: 99 }, "/task"))).text!, /t1 \[running\]/);
		assert.match((await service.handle(command(5, { id: 99 }, "/task cancel t1"))).text!, /权限不足/);
		assert.deepEqual(cancelled, []);
		assert.match((await service.handle(command(6, { id: 42 }, "/task cancel t1"))).text!, /已取消 t1/);
		assert.match((await service.handle(command(8, { id: 42 }, "/task cancel c2"))).text!, /已取消 c2/);
		assert.deepEqual(cancelled, ["t1", "c2"]);
		// Every command message is excluded from provider context, whatever its outcome.
		assert.deepEqual(consumedControlMessageIds(db, CHAT), new Set([1, 2, 3, 4, 5, 6, 8]));
		// A command addressed to another bot is not ours to answer.
		assert.equal(
			parseTelegramControlCommand(
				{
					message: {
						message_id: 7,
						chat: { id: CHAT },
						from: { id: 42 },
						text: "/new@other_bot",
						entities: [{ type: "bot_command", offset: 0, length: 14 }],
					},
				},
				"alpha_bot",
			),
			null,
		);
		// Callback mutations also require a real menu this bot sent.
		db.prepare("INSERT INTO messages (chat_id, message_id, date, is_bot) VALUES (?, 100, 1, 1)").run(CHAT);
		const callback = (senderId: number) =>
			parseTelegramControlCallback(
				{
					callback_query: {
						id: "fixture-query",
						data: "model:r:0",
						from: { id: senderId },
						message: { chat: { id: CHAT }, message_id: 100, from: { is_bot: true } },
					},
				},
				CHAT,
			)!;
		assert.match((await service.handle(callback(42))).callbackNotice!, /菜单已失效/);
		service.consumeReply(CHAT, 100);
		assert.match((await service.handle(callback(99))).callbackNotice!, /权限不足/);
		const now = Date.parse("2026-11-14T08:30:00Z");
		assert.deepEqual(parseSchedule("15m", now), { next: now + 15 * 60_000, once: true });
		assert.deepEqual(parseSchedule("0 9 * * *", now), {
			next: Date.parse("2026-11-14T09:00:00Z"),
			once: false,
		});
		assert.match(addCron(db, "30m", "check oven"), /^c1 scheduled/);
		assert.match(describeCrons(db), /^c1 \[once -> /);
		let fired = 0;
		tickCrons(db, () => Boolean(++fired), Date.now() + 31 * 60_000);
		assert.equal(fired, 1);
		assert.equal(describeCrons(db), "");
		assert.match(addCron(db, "0 9 * * *", "morning news"), /^c2 scheduled/);
		assert.equal(removeCron(db, "c2"), true);
	} finally {
		db.close();
	}
});
