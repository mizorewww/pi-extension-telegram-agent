// Opt-in native compaction of the real bot context. Stop the daemon first; this calls the provider.
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { acquirePidLock, releasePidLock } from "../src/daemon/pid.ts";
import { BotApi } from "../src/telegram/api.ts";
import { inspectVideoTranscoder } from "../src/media/video-frames.ts";
import { BotRuntime } from "../src/agent/runtime.ts";
import { createInstalledPiModelRuntime, createSharedModelRuntime } from "../src/agent/model-runtime.ts";

const config = loadConfig();
const { bot } = config;
acquirePidLock(config.dataDir);
const api = new BotApi(bot.token);
const db = openDb(config.dbPath, (await api.getMe()).id);
let runtime: BotRuntime | undefined;
try {
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
