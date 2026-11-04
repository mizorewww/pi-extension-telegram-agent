// Opt-in real provider + Telegram send against an existing human message. Stop the daemon first.
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { openDb, setBotState } from "../src/db/db.ts";
import { groupMessage } from "../src/db/message-events.ts";
import { acquirePidLock, releasePidLock } from "../src/daemon/pid.ts";
import { BotApi } from "../src/telegram/api.ts";
import { inspectVideoTranscoder } from "../src/media/video-frames.ts";
import { BotRuntime } from "../src/agent/runtime.ts";
import { createInstalledPiModelRuntime, createSharedModelRuntime } from "../src/agent/model-runtime.ts";
import { selectConfiguredBot } from "./bot-selection.ts";

const config = loadConfig();
const { values } = parseArgs({ options: { bot: { type: "string" }, message: { type: "string" } } });
const bot = selectConfiguredBot(config.bots, ["--bot", values.bot ?? ""]);
const messageId = Number(values.message);
if (!Number.isSafeInteger(messageId) || messageId <= 0)
	throw new Error("usage: --bot <id> --message <existing human message id>");
acquirePidLock(config.dataDir);
const db = openDb(config.dbPath);
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
	const api = new BotApi(bot.token);
	const me = await api.getMe();
	setBotState(db, bot.id, "bot_user_id", String(me.id));
	setBotState(db, bot.id, "bot_username", me.username);
	runtime = new BotRuntime(
		db,
		bot,
		config,
		await createSharedModelRuntime([bot], () => createInstalledPiModelRuntime({ cwd: config.configDir })),
		{
			api,
			botApis: new Map(config.bots.map((b) => [b.id, new BotApi(b.token)])),
			videoTranscoder: inspectVideoTranscoder(),
		},
	);
	await runtime.init();
	let sent = false;
	runtime.sentMessageSink = () => {
		sent = true;
	};
	await runtime.trigger("explicit", { reason: "explicit", chatId: config.groupChatId, messageId, fromBot: false });
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline && !sent) await new Promise((resolve) => setTimeout(resolve, 500));
	if (!sent) throw new Error("no new public reply within 120 seconds (already admitted inputs are deduplicated)");
	console.log("PASS: public send observed; native usage", JSON.stringify((await runtime.controlSnapshot()).usage));
} finally {
	try {
		await runtime?.stop();
	} finally {
		db.close();
		releasePidLock(config.dataDir);
	}
}
