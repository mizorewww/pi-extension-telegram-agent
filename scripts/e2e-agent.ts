// Opt-in real provider + Telegram send against an existing human message. Stop the daemon first.
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { groupMessage } from "../src/db/message-events.ts";
import { BotApi } from "../src/telegram/api.ts";
import { inspectVideoTranscoder } from "../src/media/video-frames.ts";
import { BotRuntime } from "../src/agent/runtime.ts";
import { createInstalledPiModelRuntime, createSharedModelRuntime } from "../src/agent/model-runtime.ts";

const config = loadConfig();
const { values } = parseArgs({ options: { message: { type: "string" } } });
const { bot } = config;
const messageId = Number(values.message);
if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error("usage: --message <existing human message id>");
// systemd is the only supervisor; a live daemon shares Pi storage and the bot token.
if (spawnSync("systemctl", ["is-active", "--quiet", "telegram-agent"]).status === 0)
	throw new Error("stop telegram-agent first: it shares Pi storage and the bot token");
const api = new BotApi(bot.token);
const me = await api.getMe();
const db = openDb(config.dbPath, me.id);
let runtime: BotRuntime | undefined;
try {
	const row = groupMessage(db, config.groupChatId, messageId);
	if (
		!row ||
		row.is_bot ||
		db
			.prepare("SELECT 1 FROM telegram_control_messages WHERE chat_id = ? AND message_id = ?")
			.get(config.groupChatId, messageId)
	)
		throw new Error("select an existing non-control human message from this group");
	runtime = new BotRuntime(
		db,
		bot,
		config,
		await createSharedModelRuntime([bot], () => createInstalledPiModelRuntime({ cwd: config.configDir })),
		{
			api,
			decider: null,
			videoTranscoder: inspectVideoTranscoder(),
		},
	);
	await runtime.init();
	const sentAfter = "SELECT 1 FROM messages WHERE chat_id = ? AND sender_id = ? AND message_id > ?";
	const latest = db
		.prepare("SELECT COALESCE(MAX(message_id), 0) AS id FROM messages WHERE chat_id = ?")
		.get(config.groupChatId) as { id: number };
	await runtime.trigger("direct", { chatId: config.groupChatId, messageId });
	const deadline = Date.now() + 120_000;
	let sent = false;
	while (Date.now() < deadline && !sent) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		sent = Boolean(db.prepare(sentAfter).get(config.groupChatId, me.id, latest.id));
	}
	if (!sent) throw new Error("no new public reply within 120 seconds (already admitted inputs are deduplicated)");
	console.log("PASS: public send observed; native usage", JSON.stringify((await runtime.controlSnapshot()).usage));
} finally {
	try {
		await runtime?.stop();
	} finally {
		db.close();
	}
}
