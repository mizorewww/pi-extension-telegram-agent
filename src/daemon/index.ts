// Daemon entry: long-running core. Owns SQLite, the poller and the bot runtime.
// The release installer runs this entry under the dedicated system service.

import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
	createInstalledPiModelRuntime,
	createSharedModelRuntime,
	PiModelConfigurationError,
	piAuthSource,
} from "../agent/model-runtime.ts";
import { createDecider } from "../agent/decider.ts";
import { MessageRouter } from "../agent/router.ts";
import { BotRuntime } from "../agent/runtime.ts";
import type { MessageRow } from "../agent/serialize.ts";
import { loadConfig } from "../config.ts";
import { getDaemonState, openDb, setDaemonState } from "../db/db.ts";
import { applyRetention } from "../db/retention.ts";
import { pruneMediaCache } from "../media/lifecycle.ts";
import { inspectVideoTranscoder } from "../media/video-frames.ts";
import { createPiVisionExecutor } from "../media/vision.ts";
import { VisionScheduler } from "../media/vision-scheduler.ts";
import { errorCategory, log } from "../observability/log.ts";
import { BOX_RESET_CHECK_MS, runWeeklyBoxReset } from "../sandbox/schedule.ts";
import { SemanticIndex } from "../tools/semantic.ts";
import { BotApi } from "../telegram/api.ts";
import {
	parseTelegramControlCallback,
	parseTelegramControlCommand,
	TelegramControlCommandService,
} from "../telegram/control-command.ts";
import { publishTelegramControlMenu, TelegramControlCoordinator } from "../telegram/control-integration.ts";
import type { IngestResult } from "../telegram/ingest.ts";
import { Poller } from "../telegram/poller.ts";

// systemd is the only supervisor and keeps a single copy of this process.
const config = loadConfig();
const videoTranscoder = inspectVideoTranscoder();
// Frame sampling feeds video descriptions.
const mediaNeedsFrames = config.media.mode !== "off";
if (mediaNeedsFrames && !videoTranscoder) {
	log.warn("media_transcoder", "tools_unavailable", {
		category: "video_transcoder_unavailable",
		impact: "video_frame_sampling_disabled",
		action: "install_ffmpeg_and_restart",
		blocking: false,
	});
}
const { bot } = config;
const chatModel = { provider: bot.provider, model: bot.model, thinkingLevel: bot.reasoningEffort, purpose: "bot" };
const sharedModelRuntime = await createSharedModelRuntime([chatModel], () =>
	createInstalledPiModelRuntime({ cwd: config.configDir }),
);
if (config.media.mode === "hybrid") {
	// Hybrid descriptions send images to the chat model; one without image input would
	// silently degrade every photo/sticker/video to a bare placeholder, so fail fast.
	const model = sharedModelRuntime.getModel(bot.provider, bot.model);
	if (model && !model.input.includes("image"))
		throw new PiModelConfigurationError("image_input_unsupported", bot.provider, bot.model, "bot");
}
const sharedVisionExecutor = config.media.mode === "hybrid" ? createPiVisionExecutor(sharedModelRuntime, bot) : null;
const decider = bot.decider ? createDecider(sharedModelRuntime, bot.decider, bot.name) : null;
const visionScheduler = sharedVisionExecutor ? new VisionScheduler(config.media.concurrency) : null;
log.info("daemon", "bot_configured", {
	provider: bot.provider,
	model: bot.model,
	reasoning: bot.reasoningEffort,
	auth: piAuthSource(sharedModelRuntime, bot.provider),
	decider: bot.decider ? `${bot.decider.provider}/${bot.decider.model}` : null,
});
// The bot's identity recognizes its own messages and mentions; it also owns the archive's file_ids.
const api = new BotApi(bot.token);
const me = await api.getMe();
const db = openDb(config.dbPath, me.id);
if (getDaemonState(db, "bot_user_id") !== String(me.id)) {
	// Another token: the previous bot's file_ids and update offset mean nothing to this one.
	db.exec("DELETE FROM media_file_ids; DELETE FROM daemon_state WHERE key = 'update_offset';");
	setDaemonState(db, "bot_user_id", String(me.id));
}
setDaemonState(db, "bot_username", me.username);
const identity = { userId: me.id, username: me.username, name: bot.name };
log.info("daemon", "bot_identity_ready", { telegram_user_id: me.id, username: me.username });
const mediaDir = join(config.dataDir, "media");
const semantic = bot.tools.semantic ? new SemanticIndex(db, config.groupChatId, config.geminiApiKey) : null;
const runtime = new BotRuntime(db, bot, config, sharedModelRuntime, {
	api,
	decider,
	...(sharedVisionExecutor ? { visionExecutor: sharedVisionExecutor } : {}),
	...(visionScheduler ? { visionScheduler } : {}),
	videoTranscoder,
});
await runtime.init();
semantic?.start();
async function runRetentionMaintenance(): Promise<void> {
	const through = await runtime.admittedThrough();
	const now = Date.now();
	const totals = { rawUpdates: 0, messageEvents: 0 };
	while (true) {
		const batch = applyRetention(db, config.retention, through, now);
		const media = pruneMediaCache(db, mediaDir, now);
		totals.rawUpdates += batch.rawUpdates;
		totals.messageEvents += batch.messageEvents;
		if (!batch.rawUpdates && !batch.messageEvents && !media.scanned) break;
		await setImmediate(); // Drain old backlog in bounded transactions without blocking live messages.
	}
	if (totals.rawUpdates || totals.messageEvents) log.info("daemon", "retention_pruned", totals);
	db.exec("PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);");
}
const maintenance = () =>
	void runRetentionMaintenance().catch(() => log.warn("daemon", "retention_failed", { category: "local_failure" }));
const retentionTimer = setInterval(maintenance, 24 * 60 * 60 * 1000);
retentionTimer.unref();

maintenance();

const router = new MessageRouter(db, identity, runtime);

const telegramControl = new TelegramControlCommandService(
	db,
	bot,
	config.configDir,
	runtime,
	config.telegramAdmins,
	sharedModelRuntime,
);
const telegramControlCoordinator = new TelegramControlCoordinator(db, telegramControl, api);
void publishTelegramControlMenu(api);

const box = runtime.workBox
	? { busy: () => runtime.tasksBusy(), resetBox: (reason: "weekly") => runtime.resetBox(reason) }
	: null;
const runBoxReset = () =>
	void (box ? runWeeklyBoxReset(db, box) : Promise.resolve()).catch(() =>
		log.warn("sandbox", "weekly_reset_failed", { category: "local_failure" }),
	);
runBoxReset();
const boxResetTimer = setInterval(runBoxReset, BOX_RESET_CHECK_MS);

// Routing and control both run inside the poller's durable handoff: the pending dispatch is
// only deleted after this handler returns, so a crash before claim/handle replays the update.
const onMessage = async (result: IngestResult, update: unknown) => {
	log.info("telegram_ingest", "update_committed", {
		kind: result.kind,
		chat_id: result.chatId,
		message_id: result.messageId,
	});
	if (result.chatId == null || result.messageId == null) return;
	const row = db
		.prepare("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
		.get(result.chatId, result.messageId) as unknown as MessageRow | null;
	if (!row) return;
	const command = parseTelegramControlCommand(update, me.username);
	if (command) telegramControlCoordinator.dispatch(command);
	else await router.route(result, row);
};
const onCallback = async (update: unknown) => {
	const command = parseTelegramControlCallback(update, config.groupChatId);
	if (command) telegramControlCoordinator.dispatch(command);
};
const poller = new Poller(db, api, config.groupChatId, onMessage, onCallback);

let stopping = false;
async function shutdown(signal: string, exitCode = 0) {
	if (stopping) return;
	stopping = true;
	log.info("daemon", "shutdown_started", { signal });
	// hard bound: a wedged provider request / SDK dispose must never leave the daemon
	// unkillable — SIGTERM always wins within STOP_HARD_TIMEOUT
	const hardTimer = setTimeout(() => {
		log.error("daemon", "shutdown_timeout", { timeout_ms: 35_000 });
		process.exit(1);
	}, 35_000);
	hardTimer.unref?.();
	poller.stop();
	clearInterval(retentionTimer);
	clearInterval(boxResetTimer);
	await semantic?.stop();
	await runtime
		.stop()
		.catch((error: unknown) => log.warn("daemon", "runtime_stop_failed", { category: errorCategory(error) }));
	// wait for the poller loops to actually exit; stop() aborts any in-flight long
	// poll or backoff sleep, so this returns promptly inside the hard shutdown bound
	await Promise.allSettled([pollerRun]);
	await telegramControlCoordinator.drain();
	db.close();
	clearTimeout(hardTimer);
	process.exit(exitCode);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log.info("daemon", "ready", { pid: process.pid, group_peer_id: config.groupPeerId });
// A fatal poller error (revoked token) must still run the graceful shutdown so in-flight turns settle.
const pollerRun = poller.run();
await pollerRun.catch(() => shutdown("poller_fatal", 1));
