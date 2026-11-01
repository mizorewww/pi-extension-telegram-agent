// E2E agent test: trigger one configured bot with a synthetic human message, real provider + Telegram group.
// Verifies: serialization -> session -> LLM -> send tool (terminate) -> DB insert -> telemetry.
// Usage: bun run scripts/e2e-agent.ts --bot <id>
import { loadConfig } from "../src/config.ts";
import { openDb, setBotState } from "../src/db/db.ts";
import { BotApi } from "../src/telegram/api.ts";
import { inspectVideoTranscoder } from "../src/media/video-frames.ts";
import { BotRuntime } from "../src/agent/runtime.ts";
import { createSharedModelRuntime } from "../src/agent/model-runtime.ts";
import { selectConfiguredBot } from "./bot-selection.ts";

const config = loadConfig(process.cwd());
const bot = selectConfiguredBot(config.bots, process.argv.slice(2));
const db = openDb(config.dbPath);
const chatId = config.groupChatId;

// bot identity (normally set by daemon)
const me = await new BotApi(bot.token).getMe();
setBotState(db, bot.id, "bot_user_id", String(me.id));
setBotState(db, bot.id, "bot_username", me.username);

// synthetic human trigger message (identifiable as a test)
const syntheticId = Math.floor(Date.now() / 1000);
db.query(
	`INSERT OR IGNORE INTO messages (chat_id, message_id, date, sender_id, display_name, username, is_bot, text, first_seen_by)
	 VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'test')`,
).run(
	chatId,
	syntheticId,
	Math.floor(Date.now() / 1000),
	999000001,
	"Tester",
	"tester_human",
	`[test] ${bot.name} 在吗？看到的话吱一声`,
);

const modelRuntime = await createSharedModelRuntime([bot]);
const rt = new BotRuntime(db, bot, config, modelRuntime, { videoTranscoder: inspectVideoTranscoder() });
await rt.init();

console.log(`[e2e] triggering bot ${bot.id} (${bot.provider}/${bot.model})...`);
const runsBefore = (db.query("SELECT COUNT(*) c FROM llm_runs WHERE bot_id = ?").get(bot.id) as { c: number }).c;
const sendsBefore = (
	db.query("SELECT COUNT(*) c FROM agent_events WHERE bot_id = ? AND kind = 'send'").get(bot.id) as { c: number }
).c;
rt.trigger();

let settled = false;
let ranOnce = false;

// wait until the run settles (poll llm_runs / agent_events; counts are deltas against the
// pre-trigger baseline so historical runs never satisfy the assertion)
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
	const usage = db.query("SELECT COUNT(*) c FROM llm_runs WHERE bot_id = ?").get(bot.id) as { c: number };
	if (usage.c > runsBefore) {
		ranOnce = true;
		// give the run a moment to potentially call send after first llm response
		await new Promise((r) => setTimeout(r, 5000));
		const send2 = db.query("SELECT COUNT(*) c FROM agent_events WHERE bot_id = ? AND kind = 'send'").get(bot.id) as {
			c: number;
		};
		if (send2.c > sendsBefore) {
			settled = true;
			break;
		}
		console.log("[e2e] LLM ran but chose silence (local assistant text only)");
		break;
	}
	await new Promise((r) => setTimeout(r, 1000));
}

const events = db.query("SELECT kind, payload FROM agent_events WHERE bot_id = ? ORDER BY id").all(bot.id) as {
	kind: string;
	payload: string;
}[];
for (const e of events) console.log(`  event ${e.kind}: ${e.payload.slice(0, 160)}`);
const runs = db
	.query(
		"SELECT context_tokens, cache_read, cache_miss, output_tokens, cost, epoch, system_hash, tools_hash FROM llm_runs WHERE bot_id = ?",
	)
	.all(bot.id);
console.log("[e2e] llm_runs:", JSON.stringify(runs));
const sent = db
	.query("SELECT message_id, text, username FROM messages WHERE sender_id = ? ORDER BY message_id DESC LIMIT 1")
	.get(me.id) as Record<string, unknown> | null;
console.log("[e2e] latest bot message in transcript:", JSON.stringify(sent));

await rt.stop();
db.close();
// exit code reflects the result — a run that never happened (or an
// exception path) must not silently pass.
if (!settled && !ranOnce) {
	console.error(`[e2e] FAIL: no agent run completed within 120s (${bot.provider} error or wiring broken)`);
	process.exit(1);
}
console.log(
	settled ? "[e2e] PASS (send verified)" : "[e2e] DONE (run completed, model chose silence; check events above)",
);
process.exit(0);
