// Daemon entry: long-running core. Owns SQLite, pollers, (later) agents, IPC server.
// Started by `src/main.ts start` (detached) or directly with `bun run src/daemon/index.ts`.

import { loadConfig } from "../config.ts";
import { openDb, getDaemonState, setDaemonState } from "../db/db.ts";
import { BotApi } from "../telegram/api.ts";
import { BotRuntime } from "../agent/runtime.ts";
import { dispatchRoutingDecision, routeMessageDecision } from "../agent/router.ts";
import { IpcServer } from "./ipc-server.ts";
import { acquirePidLock, releasePidLock } from "./pid.ts";
import type { MessageRow } from "../agent/serialize.ts";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CACHE_SCHEMA_VERSION } from "../agent/prompt.ts";
import { ManualSendService } from "./manual-send.ts";
import { parseTelegramControlCommand, TelegramControlCommandService } from "../telegram/control-command.ts";
import { publishTelegramControlMenus, TelegramControlCoordinator } from "../telegram/control-integration.ts";
import { createSharedModelRuntime, PiModelConfigurationError, piAuthSource } from "../agent/model-runtime.ts";
import { parsePiModelReference } from "../agent/model-ref.ts";
import { assertPiVisionExecutorReady, createPiVisionExecutor } from "../media/vision.ts";
import { VisionScheduler } from "../media/vision-scheduler.ts";
import { MediaCacheQueue } from "../media/media-cache.ts";
import { reconcileMediaCachePaths } from "../media/local-cache.ts";
import { composeDeployment, composePollers } from "./composition.ts";
import type { IngestResult } from "../telegram/ingest.ts";
import { claimRoutingDecision, finishRoutingClaim } from "../db/routing-claims.ts";
import { applyRetention } from "../db/retention.ts";
import { log } from "../observability/log.ts";
import { inspectVideoTranscoder } from "../media/video-frames.ts";
import { pruneUnreferencedMediaCache } from "../media/lifecycle.ts";

const rootDir = process.cwd();
const config = loadConfig(rootDir);
// Exclusive pid lock at the EARLIEST moment, before any slow init (getMe / model runtime /
// session creation): a second `start` while we're still initializing must not race us
// (REQ-OPS-0001 R4). Released on shutdown; stale pid files are taken over.
const pidFd = acquirePidLock(config.dataDir);
const videoTranscoder = inspectVideoTranscoder();
// Frame sampling matters in both media modes: vision descriptions and context-mode image blocks.
const mediaNeedsFrames = config.vision.enabled || config.media.mode === "context";
if (mediaNeedsFrames && (!videoTranscoder.ffmpeg || !videoTranscoder.ffprobe)) {
	log.warn("media_transcoder", "tools_unavailable", {
		ffmpeg: videoTranscoder.ffmpeg,
		ffprobe: videoTranscoder.ffprobe,
		category: "video_transcoder_unavailable",
		impact: "video_frame_sampling_disabled",
		action: "install_ffmpeg_and_restart",
		blocking: false,
	});
}
// loadConfig already canonicalizes model references (config.ts), so values from config always parse.
// The auxiliary visual model is only used in vision mode (the default); context mode feeds
// images to the chat model directly.
const visionMode = config.media.mode === "vision";
const visualModel = visionMode && config.vision.enabled ? parsePiModelReference(config.auxiliaryVisualModel)! : null;
const chatModels = config.bots.map((bot) => ({
	provider: bot.provider,
	model: bot.model,
	thinkingLevel: bot.reasoningEffort,
	purpose: `bot:${bot.id}`,
}));
const compactionModels = config.bots.map((bot) => ({
	...parsePiModelReference(bot.compactionModel)!,
	purpose: `compaction:${bot.id}`,
}));
const { sharedModelRuntime, sharedVisionExecutor } = await (async () => {
	try {
		const runtime = await createSharedModelRuntime([
			...chatModels,
			...compactionModels,
			...(visualModel ? [{ ...visualModel, purpose: "vision" }] : []),
		]);
		if (!visionMode) {
			// Context media is attached as image blocks; a chat model without image input would
			// silently degrade every photo/sticker/video to a bare placeholder, so fail fast.
			for (const bot of chatModels) {
				const model = runtime.getModel(bot.provider, bot.model);
				if (model && !model.input.includes("image")) {
					throw new PiModelConfigurationError(
						"image_input_unsupported",
						bot.provider,
						bot.model,
						undefined,
						bot.purpose,
					);
				}
			}
		}
		const executor = visualModel ? createPiVisionExecutor(runtime, visualModel.canonical) : null;
		if (executor) assertPiVisionExecutorReady(executor);
		return { sharedModelRuntime: runtime, sharedVisionExecutor: executor };
	} catch (error) {
		releasePidLock(pidFd, config.dataDir);
		throw error;
	}
})();
const visionScheduler = visualModel ? new VisionScheduler(config.vision.concurrency) : null;
const db = openDb(config.dbPath);
const mediaDir = join(config.dataDir, "media");
const mediaPathReconciliation = reconcileMediaCachePaths(db, mediaDir);
if (mediaPathReconciliation.migrated > 0 || mediaPathReconciliation.invalidated > 0) {
	log.info("media_cache", "paths_reconciled", mediaPathReconciliation);
}
function runRetentionMaintenance(): void {
	const retention = applyRetention(db, config.retention);
	if (Object.values(retention).some((count) => count > 0)) {
		log.info("daemon", "retention_pruned", {
			agent_events: retention.agentEvents,
			llm_runs: retention.llmRuns,
			raw_updates: retention.rawUpdates,
			message_events: retention.messageEvents,
		});
	}
	db.exec("PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);");
}
runRetentionMaintenance();
const retentionTimer = setInterval(runRetentionMaintenance, 24 * 60 * 60 * 1_000);
retentionTimer.unref?.();

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
const composition = await composeDeployment(db, config, {
	createApi: (bot) => new BotApi(bot.token),
	createRuntime: async (bot, api, botApis) => {
		const runtime = new BotRuntime(db, bot, config, sharedModelRuntime, {
			api,
			botApis,
			...(sharedVisionExecutor ? { visionExecutor: sharedVisionExecutor } : {}),
			...(visionScheduler ? { visionScheduler } : {}),
			videoTranscoder,
		});
		await runtime.init();
		return runtime;
	},
	onIdentity: (bot, identity) => {
		log.info("daemon", "bot_identity_ready", {
			bot_id: bot.id,
			telegram_user_id: identity.userId,
			username: identity.username,
		});
	},
});
const { botApis, runtimes, identities, botNames, botUserIds, replyBotTargets } = composition;

// The per-bot content fingerprint rotated incompatible sessions before they were opened.
const storedSchema = getDaemonState(db, "cache_schema_version");
if (storedSchema !== String(CACHE_SCHEMA_VERSION)) {
	log.info("daemon", "cache_schema_reconciled", { previous: storedSchema ?? "none", current: CACHE_SCHEMA_VERSION });
	setDaemonState(db, "cache_schema_version", String(CACHE_SCHEMA_VERSION));
}
function recordRouteMetric(metric: string, botId: string, messageId: number): void {
	log.info("routing", "decision", { bot_id: botId, message_id: messageId, outcome: metric });
}

// IPC server for TUI attach/detach
let ipc!: IpcServer;
/** Fetch the canonical message row and push it to attached TUIs; returns the row for follow-up side effects. */
const broadcastMessageRow = (chatId: number, messageId: number): MessageRow | null => {
	const row = db
		.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
		.get(chatId, messageId) as MessageRow | null;
	if (row) ipc.broadcast(ipc.msgToItem(row));
	return row;
};
const manualSend = new ManualSendService(db, Number(`-100${config.groupPeerId}`), botApis, ({ chatId, messageId }) => {
	broadcastMessageRow(chatId, messageId);
});
ipc = new IpcServer(
	db,
	join(config.dataDir, "daemon.sock"),
	botNames,
	botUserIds,
	(request) => manualSend.send(request),
	(botId) => runtimes.get(botId)?.controlSnapshot(),
);
const mediaCache = new MediaCacheQueue(db, botApis, {
	cacheDir: mediaDir,
	onReady: (fileUniqueId, mediaPath) => ipc.broadcastMediaReady({ fileUniqueId, mediaPath }),
	onTelemetry: (event) => {
		log.info("media_cache", event.event, {
			kind: event.kind,
			outcome: event.outcome,
			bytes_bucket: event.bytesBucket,
			queue_depth: event.queueDepth,
		});
	},
});
for (const [botId, rt] of runtimes) {
	rt.eventSink = (kind, payload) => {
		ipc.broadcast({
			kind: "evt",
			ts: Date.now(),
			botId,
			botName: botNames.get(botId) ?? botId,
			evtKind: kind,
			payload: JSON.stringify(payload),
		});
	};
	rt.sentMessageSink = (rawMsg) => {
		const m = rawMsg as { chat: { id: number }; message_id: number };
		const row = broadcastMessageRow(m.chat.id, m.message_id);
		if (row) mediaCache.scheduleMessage(botId, row);
	};
	rt.usageSink = (run) => ipc.broadcastUsage(run);
	rt.visionSink = (fileUniqueId, text) => ipc.broadcastVision({ fileUniqueId, text });
	rt.mediaPruneSink = () => {
		const result = pruneUnreferencedMediaCache(db, mediaDir, [...runtimes.keys()]);
		if (result.scanned === 0) return;
		const fields = {
			bot_id: botId,
			scanned: result.scanned,
			deleted: result.deleted,
			stale: result.stale,
			failed: result.failed,
		};
		if (result.failed > 0) log.warn("media_cache", "post_compaction_pruned", fields);
		else log.info("media_cache", "post_compaction_pruned", fields);
	};
	rt.streamSink = (stream) => ipc.broadcastStream(stream);
	rt.streamDemand = () => ipc.hasStreamListener(botId);
}
const mediaBackfillCount = mediaCache.scheduleBackfill();
log.info("media_cache", "startup_scheduled", { scheduled: mediaBackfillCount, limit: 100, concurrency: 2 });

const telegramControl = new TelegramControlCommandService(db, config.bots, rootDir, runtimes, config.telegramAdmins);
const telegramControlCoordinator = new TelegramControlCoordinator(
	db,
	telegramControl,
	botApis,
	({ chatId, messageId }) => {
		broadcastMessageRow(chatId, messageId);
	},
);
const controlTasks = new Set<Promise<unknown>>();
function runTelegramControl(command: NonNullable<ReturnType<typeof parseTelegramControlCommand>>): void {
	const task = telegramControlCoordinator.handle(command).catch(() => {
		log.error("telegram_control", "coordinator_failed", {
			bot_id: command.replyBotId,
			message_id: command.messageId,
			category: "local_failure",
		});
	});
	controlTasks.add(task);
	void task.finally(() => controlTasks.delete(task));
}
void publishTelegramControlMenus(botApis);

// Direct replies are durable response opportunities. Restore them only after each
// session and observer sink is ready, before fresh polling can add more work.
for (const [botId, rt] of runtimes) {
	const outcome = rt.recoverReplyObligations();
	if (outcome) log.info("routing", "reply_recovered", { bot_id: botId, outcome });
}

// route an ingested group message to a bot per routing rules
function route(result: IngestResult): void {
	if (result.chatId == null || result.messageId == null) return;
	const row = db
		.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
		.get(result.chatId, result.messageId) as MessageRow | null;
	if (!row) return; // missing row; is_bot is enforced inside routeMessageDecision
	const decision = routeMessageDecision(db, row, identities, {
		secret: config.routerSecret ?? "",
		probs: config.bots.map((b) => b.routingP),
	});
	// The only enrichment performed by ingestion is reply-sender identity. Re-route only when
	// that new fact actually changes the deterministic outcome into a direct reply.
	if (result.kind === "enriched" && decision.reason !== "reply") return;
	if (decision.target === "nobody") return;
	// TriggerTarget is `string | "nobody"`, which collapses to string; the early return above
	// documents the nobody guard and claimRoutingDecision already accepts the decision as-is.
	const routeVersion = result.routeVersion ?? 1;
	if (!claimRoutingDecision(db, decision, routeVersion)) {
		log.info("routing", "duplicate_claim_suppressed", {
			bot_id: decision.target,
			message_id: row.message_id,
			route_version: routeVersion,
		});
		return;
	}
	const dispatched = dispatchRoutingDecision(decision, runtimes);
	finishRoutingClaim(
		db,
		decision,
		routeVersion,
		dispatched.outcome === "nobody" ? "missing_runtime" : dispatched.outcome,
	);
	if (decision.reason === "probability") {
		const metric =
			dispatched.outcome === "started"
				? "route_probability_triggered"
				: dispatched.outcome === "skipped_busy"
					? "route_probability_skipped_busy"
					: dispatched.outcome === "skipped_cooldown"
						? "route_probability_skipped_cooldown"
						: `route_probability_${dispatched.outcome}`;
		recordRouteMetric(metric, decision.target, row.message_id);
	} else {
		log.info("routing", "decision", {
			bot_id: decision.target,
			message_id: row.message_id,
			reason: decision.reason,
			outcome: dispatched.outcome,
			route_version: routeVersion,
		});
	}
}

const pollers = composePollers(
	db,
	config,
	(result, update, botId) => {
		log.info("telegram_ingest", "update_committed", {
			bot_id: botId,
			kind: result.kind,
			chat_id: result.chatId,
			message_id: result.messageId,
		});
		const command = parseTelegramControlCommand(update, botId, identities);
		if (command) runTelegramControl(command);
		else route(result);
		if (result.chatId != null && result.messageId != null) {
			const row = broadcastMessageRow(result.chatId, result.messageId);
			// Poller offset + canonical row are durable before this non-blocking side effect.
			if (row) mediaCache.scheduleMessage(botId, row);
		}
	},
	replyBotTargets,
);

let stopping = false;
async function shutdown(signal: string) {
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
	const mediaCacheStop = mediaCache.stop();
	const runtimeStops = await Promise.allSettled([...runtimes.values()].map((rt) => rt.stop()));
	for (const [index, result] of runtimeStops.entries()) {
		if (result.status === "rejected") {
			const botId = [...runtimes.keys()][index];
			log.warn("daemon", "runtime_stop_failed", {
				bot_id: botId,
				category: "dispose_failed",
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
	}
	await mediaCacheStop;
	if (controlTasks.size > 0) {
		await Promise.race([Promise.allSettled([...controlTasks]), new Promise((resolve) => setTimeout(resolve, 5_000))]);
	}
	ipc.stop();
	releasePidLock(pidFd, config.dataDir);
	// wait for the poller loops to actually exit; stop() aborts any in-flight long
	// poll or backoff sleep, so this returns promptly inside the hard shutdown bound
	await Promise.allSettled([pollerRuns]);
	db.close();
	clearTimeout(hardTimer);
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Publish the readiness socket only after synchronous startup work and signal handlers are ready.
ipc.start();
log.info("daemon", "ready", { pid: process.pid, group_peer_id: config.groupPeerId, bot_count: config.bots.length });
const pollerRuns = Promise.all(pollers.map((p) => p.run()));
await pollerRuns;
