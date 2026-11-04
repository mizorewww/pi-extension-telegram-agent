// Only human admins can run mutating control commands, and no command reaches the provider context.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
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
	context_window: 65536,
	media: { mode: "off" },
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
	const service = new TelegramControlCommandService(db, config.bots, root, new Map([["A", runtime]]), [42]);
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
			"A",
			[{ id: "A", username: "alpha_bot" }],
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
		assert.deepEqual(cancelled, ["t1"]);
		// Every command message is excluded from provider context, whatever its outcome.
		assert.deepEqual(consumedControlMessageIds(db, CHAT), new Set([1, 2, 3, 4, 5, 6]));
		// Callback mutations also require ownership of a real menu sent by this bot.
		db.prepare(
			"INSERT INTO messages (chat_id, message_id, date, first_seen_by, is_bot) VALUES (?, 100, 1, 'B', 1)",
		).run(CHAT);
		service.consumeReply("B", CHAT, 100);
		const callback = (senderId: number) =>
			parseTelegramControlCallback(
				{
					callback_query: {
						id: "fixture-query",
						data: "set:r:0.1",
						from: { id: senderId },
						message: { chat: { id: CHAT }, message_id: 100, from: { is_bot: true } },
					},
				},
				"A",
				CHAT,
			)!;
		assert.match((await service.handle(callback(42))).callbackNotice!, /菜单已失效/);
		db.prepare("UPDATE messages SET first_seen_by = 'A' WHERE message_id = 100").run();
		assert.match((await service.handle(callback(99))).callbackNotice!, /权限不足/);
		assert.equal(loadConfig(root).bots[0]!.routingP, 0);
		await service.handle(callback(42));
		assert.equal(loadConfig(root).bots[0]!.routingP, 0.1);
	} finally {
		db.close();
	}
});
