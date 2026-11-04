// Opt-in native compaction of the real bot context. Stop the daemon first; this calls the provider.
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { acquirePidLock, releasePidLock } from "../src/daemon/pid.ts";
import { BotApi } from "../src/telegram/api.ts";
import { inspectVideoTranscoder } from "../src/media/video-frames.ts";
import { BotRuntime } from "../src/agent/runtime.ts";
import { createSharedModelRuntime } from "../src/agent/model-runtime.ts";
import { selectConfiguredBot } from "./bot-selection.ts";

const config = loadConfig(process.cwd());
const bot = selectConfiguredBot(config.bots, process.argv.slice(2));
acquirePidLock(config.dataDir);
const db = openDb(config.dbPath);
let runtime: BotRuntime | undefined;
try {
	runtime = new BotRuntime(db, bot, config, await createSharedModelRuntime([bot]), {
		api: new BotApi(bot.token),
		botApis: new Map(config.bots.map((b) => [b.id, new BotApi(b.token)])),
		videoTranscoder: inspectVideoTranscoder(),
	});
	await runtime.init();
	const result = await runtime.compactForControl();
	if (!result.ok) throw new Error(`compaction did not produce a summary: ${result.code}`);
	console.log(`PASS: native compaction committed; tokens before ${result.tokensBefore}`);
} finally {
	try {
		await runtime?.stop();
	} finally {
		db.close();
		releasePidLock(config.dataDir);
	}
}
