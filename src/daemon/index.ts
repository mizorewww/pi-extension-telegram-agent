// Daemon entry: long-running core. Owns SQLite, pollers and bot runtimes.
// Run as `node dist/src/daemon/index.js`, supervised by the systemd user unit (docs/runbooks/daemon.md).

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { parsePiModelReference } from "../agent/model-ref.ts";
import { createSharedModelRuntime, PiModelConfigurationError, piAuthSource } from "../agent/model-runtime.ts";
import { BotFire, type BotIdentity, MessageRouter } from "../agent/router.ts";
import { BotRuntime } from "../agent/runtime.ts";
import type { MessageRow } from "../agent/serialize.ts";
import { loadConfig } from "../config.ts";
import { getDaemonState, openDb, setBotState, setDaemonState } from "../db/db.ts";
import { applyRetention } from "../db/retention.ts";
import { pruneMediaCache } from "../media/lifecycle.ts";
import { inspectVideoTranscoder } from "../media/video-frames.ts";
import { assertPiVisionExecutorReady, createPiVisionExecutor } from "../media/vision.ts";
import { VisionScheduler } from "../media/vision-scheduler.ts";
import { errorCategory, log } from "../observability/log.ts";
import { BOX_RESET_CHECK_MS, runWeeklyBoxReset } from "../sandbox/schedule.ts";
import { BotApi } from "../telegram/api.ts";
import {
	parseTelegramControlCallback,
	parseTelegramControlCommand,
	TelegramControlCommandService,
} from "../telegram/control-command.ts";
import { publishTelegramControlMenus, TelegramControlCoordinator } from "../telegram/control-integration.ts";
import type { IngestResult } from "../telegram/ingest.ts";
import { Poller } from "../telegram/poller.ts";
import { acquirePidLock, releasePidLock } from "./pid.ts";

const rootDir = process.cwd();
const config = loadConfig(rootDir);
// Exclusive pid lock before any slow init (getMe / model runtime / sessions), so a second copy
// can never race this one onto the same tokens. Released on shutdown; stale pid files are taken over.
acquirePidLock(config.dataDir);
const videoTranscoder = inspectVideoTranscoder();
// Frame sampling feeds vision descriptions and view_image.
const mediaNeedsFrames = config.media.mode !== "off";
if (mediaNeedsFrames && !videoTranscoder) {
	log.warn("media_transcoder", "tools_unavailable", {
		category: "video_transcoder_unavailable",
		impact: "video_frame_sampling_disabled",
		action: "install_ffmpeg_and_restart",
		blocking: false,
	});
}
// loadConfig already canonicalizes model references (config.ts), so values from config always parse.
// Hybrid mode describes media with the auxiliary vision model.
const visualModel = config.media.mode === "hybrid" ? parsePiModelReference(config.media.visionModel)! : null;
const chatModels = config.bots.map((bot) => ({
	provider: bot.provider,
	model: bot.model,
	thinkingLevel: bot.reasoningEffort,
	purpose: `bot:${bot.id}`,
}));
const { sharedModelRuntime, sharedVisionExecutor } = await (async () => {
	try {
		const runtime = await createSharedModelRuntime([
			...chatModels,
			...(visualModel ? [{ ...visualModel, purpose: "vision" }] : []),
		]);
		if (config.media.mode === "hybrid") {
			// view_image attaches image blocks; a chat model without image input would silently
			// degrade every viewed photo/sticker/video to a bare placeholder, so fail fast.
			for (const bot of chatModels) {
				const model = runtime.getModel(bot.provider, bot.model);
				if (model && !model.input.includes("image")) {
					throw new PiModelConfigurationError("image_input_unsupported", bot.provider, bot.model, bot.purpose);
				}
			}
		}
		const executor = visualModel ? createPiVisionExecutor(runtime, visualModel.canonical) : null;
		if (executor) assertPiVisionExecutorReady(executor);
		return { sharedModelRuntime: runtime, sharedVisionExecutor: executor };
	} catch (error) {
		releasePidLock(config.dataDir);
		throw error;
	}
})();
const visionScheduler = visualModel ? new VisionScheduler(config.media.concurrency) : null;
const db = openDb(config.dbPath);
const mediaDir = join(config.dataDir, "media");
const runtimes = new Map<string, BotRuntime>();
async function runRetentionMaintenance(): Promise<void> {
	const cursors = await Promise.all([...runtimes.values()].map((rt) => rt.admittedThrough()));
	const through = cursors.length ? Math.min(...cursors) : 0;
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

// router secret: stable across restarts, generated once
if (!config.routerSecret) {
	let secret = getDaemonState(db, "router_secret");
	if (!secret) {
		secret = randomBytes(32).toString("hex");
		setDaemonState(db, "router_secret", secret);
		log.info("daemon", "router_secret_created");
	}
	config.routerSecret = secret;
}

// resolve bot identities (getMe) so we can recognize own messages and mentions
for (const bot of config.bots) {
	log.info("daemon", "bot_configured", {
		bot_id: bot.id,
		provider: bot.provider,
		model: bot.model,
		reasoning: bot.reasoningEffort,
		auth: piAuthSource(sharedModelRuntime, bot.provider),
	});
}
const botApis = new Map(config.bots.map((bot) => [bot.id, new BotApi(bot.token)] as const));
const identities: BotIdentity[] = [];
for (const bot of config.bots) {
	const me = await botApis.get(bot.id)!.getMe();
	setBotState(db, bot.id, "bot_user_id", String(me.id));
	setBotState(db, bot.id, "bot_username", me.username);
	identities.push({ id: bot.id, userId: me.id, username: me.username, name: bot.name });
	log.info("daemon", "bot_identity_ready", { bot_id: bot.id, telegram_user_id: me.id, username: me.username });
}
for (const bot of config.bots) {
	const runtime = new BotRuntime(db, bot, config, sharedModelRuntime, {
		api: botApis.get(bot.id)!,
		botApis,
		...(sharedVisionExecutor ? { visionExecutor: sharedVisionExecutor } : {}),
		...(visionScheduler ? { visionScheduler } : {}),
		videoTranscoder,
	});
	await runtime.init();
	runtimes.set(bot.id, runtime);
}
maintenance();

// `/fire` state shared by the control command (writer) and routing (reader); off on every start.
const botFire = new BotFire();
const router = new MessageRouter(
	db,
	identities,
	() => ({ secret: config.routerSecret ?? "", probs: config.bots.map((b) => b.routingP) }),
	runtimes,
	botFire,
);

for (const rt of runtimes.values()) {
	rt.sentMessageSink = (rawMsg) => {
		const m = rawMsg as { chat: { id: number }; message_id: number };
		const row = db
			.prepare("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
			.get(m.chat.id, m.message_id) as unknown as MessageRow | null;
		if (!row) return; // persistence failed: nothing durable to route
		// Only agent sends reach this sink; control replies never route.
		void router
			.routeLocalSend(row)
			.catch(() => log.warn("routing", "local_send_failed", { category: "local_failure" }));
	};
}

const telegramControl = new TelegramControlCommandService(
	db,
	config.bots,
	rootDir,
	runtimes,
	config.telegramAdmins,
	sharedModelRuntime,
	botFire,
);
const telegramControlCoordinator = new TelegramControlCoordinator(db, telegramControl, botApis);
void publishTelegramControlMenus(botApis);

const boxes = [...runtimes].flatMap(([botId, rt]) =>
	rt.workBox ? [{ botId, busy: () => rt.tasksBusy(), resetBox: (reason: "weekly") => rt.resetBox(reason) }] : [],
);
const runBoxReset = () =>
	void runWeeklyBoxReset(db, boxes).catch(() =>
		log.warn("sandbox", "weekly_reset_failed", { category: "local_failure" }),
	);
runBoxReset();
const boxResetTimer = setInterval(runBoxReset, BOX_RESET_CHECK_MS);

// Routing and control both run inside the poller's durable handoff: the pending dispatch is
// only deleted after this handler returns, so a crash before claim/handle replays the update.
const onMessage = async (result: IngestResult, update: unknown, botId: string) => {
	log.info("telegram_ingest", "update_committed", {
		bot_id: botId,
		kind: result.kind,
		chat_id: result.chatId,
		message_id: result.messageId,
	});
	if (result.chatId == null || result.messageId == null) return;
	const row = db
		.prepare("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
		.get(result.chatId, result.messageId) as unknown as MessageRow | null;
	if (!row) return;
	const command = parseTelegramControlCommand(update, botId, identities);
	if (command) telegramControlCoordinator.dispatch(command);
	else await router.route(result, row);
};
const onCallback = async (update: unknown, botId: string) => {
	const command = parseTelegramControlCallback(update, botId, config.groupChatId);
	if (command) telegramControlCoordinator.dispatch(command);
};
const pollers = config.bots.map(
	(bot) => new Poller(db, bot.id, botApis.get(bot.id)!, config.groupChatId, onMessage, onCallback),
);

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
	for (const p of pollers) p.stop();
	clearInterval(retentionTimer);
	clearInterval(boxResetTimer);
	const runtimeStops = await Promise.allSettled([...runtimes.values()].map((rt) => rt.stop()));
	for (const [index, result] of runtimeStops.entries()) {
		if (result.status === "rejected") {
			const botId = [...runtimes.keys()][index];
			log.warn("daemon", "runtime_stop_failed", {
				bot_id: botId,
				category: errorCategory(result.reason),
			});
		}
	}
	releasePidLock(config.dataDir);
	// wait for the poller loops to actually exit; stop() aborts any in-flight long
	// poll or backoff sleep, so this returns promptly inside the hard shutdown bound
	await Promise.allSettled([pollerRuns]);
	await telegramControlCoordinator.drain();
	db.close();
	clearTimeout(hardTimer);
	process.exit(exitCode);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log.info("daemon", "ready", { pid: process.pid, group_peer_id: config.groupPeerId, bot_count: config.bots.length });
// A fatal poller error (revoked token) must still run the graceful shutdown so other bots'
// in-flight turns settle and the pid file is released.
const pollerRuns = Promise.all(pollers.map((p) => p.run()));
await pollerRuns.catch(() => shutdown("poller_fatal", 1));
