// Compaction e2e: real session + real summary LLM call through BotRuntime's public
// control boundary. The automatic threshold can sit near 984K tokens on a 1M-window
// model, so this script drives the same explicit path used by Telegram /compact.
// Usage: node dist/scripts/e2e-compaction.js --bot <id>   (touches real services, needs .env)
import { loadConfig } from "../src/config.ts";
import { openDb, getBotState, setBotState } from "../src/db/db.ts";
import { BotApi } from "../src/telegram/api.ts";
import { inspectVideoTranscoder } from "../src/media/video-frames.ts";
import { BotRuntime } from "../src/agent/runtime.ts";
import { createSharedModelRuntime } from "../src/agent/model-runtime.ts";
import { selectConfiguredBot } from "./bot-selection.ts";

const config = loadConfig(process.cwd());
const bot = selectConfiguredBot(config.bots, process.argv.slice(2));
const db = openDb(config.dbPath);
const me = await new BotApi(bot.token).getMe();
setBotState(db, bot.id, "bot_user_id", String(me.id));
setBotState(db, bot.id, "bot_username", me.username);
const modelRuntime = await createSharedModelRuntime([bot]);
const rt = new BotRuntime(db, bot, config, modelRuntime, { videoTranscoder: inspectVideoTranscoder() });
await rt.init();
try {
	const epochBefore = Number(getBotState(db, bot.id, "context_epoch") ?? "1");
	console.log(`[e2e] bot=${bot.id} epoch before:`, epochBefore);
	const result = await rt.compactForControl();
	if (!result.ok) throw new Error(`compaction failed: ${result.code}`);

	const epochAfter = Number(getBotState(db, bot.id, "context_epoch") ?? "1");
	if (epochAfter <= epochBefore) throw new Error(`epoch did not advance (${epochBefore} -> ${epochAfter})`);
	const errors = db
		.prepare("SELECT payload FROM agent_events WHERE bot_id = ? AND kind = 'error' AND ts > ?")
		.all(bot.id, Date.now() - 120_000);
	if (errors.length > 0) throw new Error(`unexpected error events: ${JSON.stringify(errors)}`);

	console.log(
		`[e2e] PASS: compaction observed, epoch ${epochBefore} -> ${epochAfter}, tokens before ${result.tokensBefore}`,
	);
} finally {
	await rt.stop();
	db.close();
}
