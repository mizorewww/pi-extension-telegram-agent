// Only human admins can run mutating control commands, and no command reaches the provider context.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import {
	consumedControlMessageIds,
	parseTelegramControlCommand,
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
	compaction_model: "fixture/old:low",
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
		resetBoxForControl: async () => {
			throw new Error("unused");
		},
		taskStatusForControl: () => "t1 [running] search: 调研",
		cancelTaskForControl: (taskId: string) => {
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
		expect((await service.handle(command(1, { id: 99 }))).text).toContain("权限不足");
		expect((await service.handle(command(2, { id: 42, is_bot: true }))).text).toBeNull();
		expect(resets).toBe(0);
		expect((await service.handle(command(3, { id: 42 }))).text).toContain("epoch=7");
		expect(resets).toBe(1);
		// /task is public; cancelling one is an admin mutation like the others.
		expect((await service.handle(command(4, { id: 99 }, "/task"))).text).toContain("t1 [running]");
		expect((await service.handle(command(5, { id: 99 }, "/task cancel t1"))).text).toContain("权限不足");
		expect(cancelled).toEqual([]);
		expect((await service.handle(command(6, { id: 42 }, "/task cancel t1"))).text).toContain("已取消 t1");
		expect(cancelled).toEqual(["t1"]);
		// Every command message is excluded from provider context, whatever its outcome.
		expect(consumedControlMessageIds(db, CHAT)).toEqual(new Set([1, 2, 3, 4, 5, 6]));
	} finally {
		db.close();
	}
});
