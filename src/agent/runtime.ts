// BotRuntime: one persona bot = one Pi AgentSession + immutable event consumption + visible refs.
// See docs/architecture.md and docs/research.md.

import type { Database } from "bun:sqlite";
import { readFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, retryAssistantCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	VERSION as PI_VERSION,
	type AgentSession,
	type AgentSessionEvent,
	type CompactionResult,
	type ModelRuntime,
	type SessionEntry,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { MIN_COMPACTION_RESERVE, type AppConfig, type BotConfig } from "../config.ts";
import { getBotState, setBotState } from "../db/db.ts";
import { BotApi, TelegramApiError } from "../telegram/api.ts";
import { TelegramTypingLease } from "../telegram/activity.ts";
import { executeAgentSend } from "./send.ts";
import { type MessageRow, TELEGRAM_SERIALIZER_VERSION } from "./serialize.ts";
import {
	buildSystemPrompt,
	sha256Short,
	CACHE_SCHEMA_VERSION,
	COMPACTION_SUMMARY_PROMPT,
	SHARED_PROTOCOL,
} from "./prompt.ts";
import { TOOL_DEFS, toolProtocolHash, type SendParams, type SearchParams } from "./tools.ts";
import { runTinyFishTool } from "../tools/search.ts";
import { runJs } from "../tools/run-js.ts";
import { contextMediaRefs, createContextImageResolver, ensureContextMedia } from "../media/context-media.ts";
import { isVisionMedia, type MediaDownloadApi } from "../media/local-cache.ts";
import { createPiVisionExecutor, ensureVision, type VisionExecutor, type VisionUpdateSink } from "../media/vision.ts";
import type { VisionScheduler } from "../media/vision-scheduler.ts";
import {
	ensureStickerCatalog,
	recentContextStickerCandidates,
	stickerCatalogPromptBlock,
	stickerCatalogSnapshotHash,
} from "../media/sticker-catalog.ts";
import {
	createReplyObligation,
	listReplyObligations,
	removeReplyObligations,
	replyObligationCount,
} from "../db/reply-obligations.ts";
import type { RoutingTrigger, TriggerResult, TriggerSource } from "./router.ts";
import type { AgentStreamFrame, RuntimeControlSnapshot, UsageRun } from "../ipc.ts";
import { consumedControlMessageIds } from "../telegram/control-command.ts";
import { classifyPiProviderFailure } from "./model-runtime.ts";
import { providerRetryPolicy, guardProviderCall } from "./provider-guard.ts";
import {
	commitConsumedContext,
	addVisibleMessageIds,
	getConsumedSeq,
	getSessionManifest,
	listRecentMessageEvents,
	listReplyObligationEvents,
	listVisibleMessageIds,
	messageEventHighWater,
	replaceVisibleMessageIds,
	setConsumedSeq,
	setSessionManifest,
	type MessageEvent,
} from "../db/message-events.ts";
import { availableSuffixBudget, estimateProviderTokensUpperBound, packMessageEvents } from "./token-packer.ts";
import {
	estimateCacheReadFromPrefix,
	buildTelegramContextBlocks,
	makeAssistantPersistencePolicyExtension,
	makeCachePayloadObserverExtension,
	makeTelegramCompactionExtension,
	makeTelegramContextExtension,
	serializeCompactionMessages,
	TELEGRAM_CONTEXT_TYPE,
	TELEGRAM_CONTEXT_VERSION,
	TELEGRAM_EXTENSION_ORDER,
	contextImageBytes,
	contextImageNames,
	type ProviderPayloadObservation,
	type TelegramContextDetails,
} from "./extensions/index.ts";
import { buildContextFingerprint, canResumeContextSession, sha256 } from "./context-fingerprint.ts";
import { contextStateFromEntries } from "./context-state.ts";
import { parsePiModelReference, type PiRequestThinkingLevel } from "./model-ref.ts";
import type { VideoTranscoderAvailability } from "../media/video-frames.ts";
import { errorCategory, log } from "../observability/log.ts";
import { fitContextBreakdown } from "../observability/usage.ts";
import { AgentActivityCollector } from "./activity.ts";

const MAX_EVENT_SCAN = 256;
const MAX_OBLIGATION_SCAN = 64;
const TELEGRAM_CONTEXT_COMMIT_TYPE = "telegram_context_commit_v2";
const EPOCH_KEY = "context_epoch";
const VISION_BATCH_CONCURRENCY = 2;

const ACTIVITY_RAW_EVENT_KINDS = new Set([
	"assistant_text",
	"thinking",
	"tool_call",
	"tool_result",
	"tool_search",
	"tool_fetch",
	"tool_run_js",
	"markdown_sent",
	"plain_fallback",
	"send",
	"send_degraded",
	"error",
]);
const ACTIVITY_DETAIL_EVENT_KINDS = new Set(
	[...ACTIVITY_RAW_EVENT_KINDS].filter((kind) => kind !== "assistant_text" && kind !== "thinking"),
);

export type ManualCompactResult =
	| { ok: true; epoch: number; tokensBefore: number }
	| { ok: false; code: "busy" | "stopping" | "unavailable" | "nothing_to_compact" | "failed" };

/** Latest compaction outcome for /status: restored from agent_events so it survives restarts. */
export function restoreLastCompaction(db: Database, botId: string): RuntimeControlSnapshot["lastCompact"] {
	const row = db
		.query(
			`SELECT ts, kind FROM agent_events
			 WHERE bot_id = ? AND (kind = 'compaction' OR (kind = 'error' AND json_extract(payload, '$.stage') = 'compaction'))
			 ORDER BY ts DESC LIMIT 1`,
		)
		.get(botId) as { ts: number; kind: string } | null;
	if (!row) return null;
	return { at: row.ts, outcome: row.kind === "compaction" ? "ok" : "failed" };
}

function parseStoredMessageHashes(value: string | null): string[] | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : null;
	} catch {
		return null;
	}
}

export class BotRuntime {
	private db: Database;
	private bot: BotConfig;
	private config: AppConfig;
	private modelRuntime: ModelRuntime;
	private visionExecutor: VisionExecutor | null;
	private api: BotApi;
	private readonly botApis: ReadonlyMap<string, MediaDownloadApi>;
	private session: AgentSession | null = null;
	private model!: NonNullable<ReturnType<ModelRuntime["getModel"]>>; // resolved in init()
	private compactionModel!: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
	private compactionReasoning: PiRequestThinkingLevel = "low";
	private running = false;
	// Flush state machine (REQ-AGENT-0001): `flushing` is owned locally and set synchronously
	// at trigger time — never gated on SDK events. While flushing, triggers only coalesce
	// into `pendingTrigger`; the flush loop drains it (burst-merge semantics unchanged).
	private flushing = false;
	private pendingTrigger = false;
	private stopping = false;
	private flushPromise: Promise<void> | null = null;
	private cooldownUntil = 0;
	private cooldownAfterFlush = false;
	private controlCompacting = false;
	private lastControlCompact: RuntimeControlSnapshot["lastCompact"] = null;
	private readonly monotonicNow: () => number;
	private visibleMessageIds = new Set<number>();
	private epoch = 1;
	private runStartTs = 0;
	private systemHash = "";
	private toolsHash = "";
	private streamSequence = 0;
	private activeStreamId: string | null = null;
	private activitySequence = 0;
	private activity: AgentActivityCollector | null = null;
	private activeAssistantMessage: Extract<AgentMessage, { role: "assistant" }> | null = null;
	private contextFingerprint = "";
	private telemetryHmacKey = "";
	private staticPrefixTokenEstimate = 0;
	private pendingPayloadObservations: ProviderPayloadObservation[] = [];
	private currentTriggerMessageId: number | null = null;
	private pendingInputMetrics = {
		inputEvents: 0,
		estimatedTokens: 0,
		rowsScanned: 0,
		visionCalls: 0,
		imagesAttached: 0,
	};
	private providerCallsInRun = 0;
	private lastLlmRunId: number | null = null;
	private lastUsageRun: UsageRun | null = null;
	private thinkingStartedAt = 0;
	private thinkingMs = 0;
	private thinkingFinished = false;
	private readonly visionScheduler: VisionScheduler | null;
	private readonly typingLease: TelegramTypingLease;
	private readonly videoTranscoder: VideoTranscoderAvailability | undefined;
	/** Optional sink for TUI/live broadcasting of agent events. */
	eventSink: ((kind: string, payload: unknown) => void) | null = null;
	/** Optional sink for messages this bot sent (poller echo dedupes them, so TUI needs this path). */
	sentMessageSink: ((rawMsg: unknown) => void) | null = null;
	/** Optional sink for llm_run telemetry (REQ-UI-0003: live usage push). */
	usageSink: ((run: UsageRun) => void) | null = null;
	/** Optional sink for newly persisted media descriptions (REQ-UI-0006). */
	visionSink: VisionUpdateSink | null = null;
	/** Bounded cache observer invoked only after successful compaction visibility commits. */
	mediaPruneSink: (() => void) | null = null;
	/** Ephemeral Pi-feed assistant snapshots; never persisted (REQ-UI-0010). */
	streamSink: ((frame: AgentStreamFrame) => void) | null = null;
	/** Lets the daemon avoid building snapshots when no matching listener completed hello. */
	streamDemand: (() => boolean) | null = null;

	constructor(
		db: Database,
		bot: BotConfig,
		config: AppConfig,
		modelRuntime: ModelRuntime,
		options: {
			monotonicNow?: () => number;
			chatActionSender?: (signal: AbortSignal) => Promise<unknown>;
			api?: BotApi;
			botApis?: ReadonlyMap<string, MediaDownloadApi>;
			visionExecutor?: VisionExecutor;
			visionScheduler?: VisionScheduler;
			videoTranscoder?: VideoTranscoderAvailability;
		} = {},
	) {
		this.db = db;
		this.bot = bot;
		this.config = config;
		this.modelRuntime = modelRuntime;
		this.visionExecutor = options.visionExecutor ?? null;
		this.visionScheduler = options.visionScheduler ?? null;
		this.videoTranscoder = options.videoTranscoder;
		this.monotonicNow = options.monotonicNow ?? (() => performance.now());
		this.api = options.api ?? new BotApi(bot.token);
		this.botApis = options.botApis ?? new Map([[bot.id, this.api]]);
		const chatId = Number(`-100${config.groupPeerId}`);
		this.typingLease = new TelegramTypingLease(
			options.chatActionSender ?? ((signal) => this.api.sendChatAction(chatId, signal)),
			{
				onFailure: (error) => {
					const category =
						error instanceof TelegramApiError
							? `telegram_${error.code}`
							: typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "TimeoutError"
								? "timeout"
								: "request_failed";
					log.warn("telegram_activity", "typing_failed", { bot_id: this.bot.id, category, retry: true });
				},
			},
		);
		this.epoch = Number(getBotState(db, bot.id, EPOCH_KEY) ?? "1");
		this.visibleMessageIds = new Set(listVisibleMessageIds(db, bot.id, chatId, this.epoch));
		this.lastControlCompact = restoreLastCompaction(db, bot.id);
	}

	get botUserId(): number {
		return Number(getBotState(this.db, this.bot.id, "bot_user_id") ?? "0");
	}

	get botUsername(): string {
		return getBotState(this.db, this.bot.id, "bot_username") ?? "";
	}

	async init(): Promise<void> {
		const persona = readFileSync(this.bot.personaPath, "utf8");
		const chatId = Number(`-100${this.config.groupPeerId}`);
		// Catalog identity + format is pinned into the stable system prefix below.
		if (this.bot.stickerSets.length > 0) {
			await ensureStickerCatalog(this.db, this.api, this.bot.id, this.bot.stickerSets);
		}
		const stickerCatalog =
			this.bot.stickerSets.length > 0 ? stickerCatalogPromptBlock(this.db, this.bot.id, this.bot.stickerSets) : "";
		const systemPrompt = buildSystemPrompt(persona, stickerCatalog);
		this.systemHash = sha256Short(systemPrompt);

		const sendTool = {
			name: "send",
			label: "Send",
			description: TOOL_DEFS[0].description,
			parameters: TOOL_DEFS[0].parameters,
			execute: async (_toolCallId: string, params: SendParams) => {
				return await this.executeSend(params);
			},
		};
		const searchTool = {
			name: "search",
			label: "Search",
			description: TOOL_DEFS[1].description,
			parameters: TOOL_DEFS[1].parameters,
			execute: async (_toolCallId: string, params: SearchParams) => {
				const result = await runTinyFishTool(this.config.tinyfishApiKey, params);
				this.recordEvent(result.event.kind, result.event.payload);
				return {
					content: [{ type: "text" as const, text: result.content }],
					details: result.details,
				};
			},
		};
		const runJsTool = {
			name: "run_js",
			label: "Run JS",
			description: TOOL_DEFS[2].description,
			parameters: TOOL_DEFS[2].parameters,
			execute: async (_toolCallId: string, params: { code: string }) => {
				const result = await runJs(params.code);
				this.recordEvent("tool_run_js", { ok: result.ok, durationMs: result.durationMs });
				return {
					content: [{ type: "text" as const, text: result.output || "(no output)" }],
					details: { ok: result.ok, durationMs: result.durationMs },
				};
			},
		};
		const catalogModel = this.modelRuntime.getModel(this.bot.provider, this.bot.model);
		if (!catalogModel) throw new Error(`model not found: ${this.bot.provider}/${this.bot.model}`);
		const model = { ...catalogModel, contextWindow: Math.min(catalogModel.contextWindow, this.config.contextWindow) };
		this.model = model;
		const compactionSelection = parsePiModelReference(this.bot.compactionModel);
		if (!compactionSelection) throw new Error("invalid compaction_model; expected provider/model:effort");
		const compactionModel = this.modelRuntime.getModel(compactionSelection.provider, compactionSelection.model);
		if (!compactionModel) {
			throw new Error(`compaction model not found: ${compactionSelection.provider}/${compactionSelection.model}`);
		}
		this.compactionModel = compactionModel;
		this.compactionReasoning = compactionSelection.thinkingLevel;

		// Custom compaction: chat-oriented summary (state, not replay), threshold from config.
		// Pi's trigger formula is contextTokens > contextWindow - reserveTokens, so reserve = window - threshold.
		const threshold = this.bot.compactionThreshold;
		const reserveTokens = Math.max(MIN_COMPACTION_RESERVE, model.contextWindow - threshold);
		// Tool order is cache-visible protocol: never reorder (docs/cache.md, REQ-TEST-0001 R2).
		// Per-bot tool toggles (REQ-CONF-0001): filter the fixed-order tool list. send off
		// means the bot cannot speak in-group (observer-only); search/run_js off saves tokens.
		const activeTools = [sendTool, searchTool, runJsTool].filter((t) =>
			t.name === "send" ? this.bot.tools.send : t.name === "search" ? this.bot.tools.search : this.bot.tools.runJs,
		);
		this.toolsHash = toolProtocolHash(activeTools);
		this.staticPrefixTokenEstimate = estimateProviderTokensUpperBound(
			`${systemPrompt}\n${JSON.stringify(activeTools.map(({ name, description, parameters }) => ({ name, description, parameters })))}`,
		);
		this.contextFingerprint = buildContextFingerprint({
			piVersion: PI_VERSION,
			provider: this.bot.provider,
			api: model.api,
			model: this.bot.model,
			contextWindow: model.contextWindow,
			reasoningEffort: this.bot.reasoningEffort,
			cacheRetention: this.bot.cacheRetention,
			cacheSchemaVersion: CACHE_SCHEMA_VERSION,
			commonPromptSha256: sha256(SHARED_PROTOCOL),
			personaSha256: sha256(persona),
			serializerVersion: TELEGRAM_SERIALIZER_VERSION,
			compactionPromptSha256: sha256(COMPACTION_SUMMARY_PROMPT),
			compactionModel: compactionSelection.canonical,
			stickerCatalogSnapshotSha256: stickerCatalogSnapshotHash(this.db, this.bot.id, this.bot.stickerSets),
			mediaMode: this.config.media.mode,
			extensionOrder: TELEGRAM_EXTENSION_ORDER,
			tools: activeTools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		});

		const sessionsDir = join(this.config.dataDir, "sessions", this.bot.id);
		mkdirSync(sessionsDir, { recursive: true });
		const manifest = getSessionManifest(this.db, this.bot.id);
		const hasAnySession = readdirSync(sessionsDir).some((file) => file.endsWith(".jsonl"));
		const canResume = canResumeContextSession(
			manifest,
			this.contextFingerprint,
			manifest != null && existsSync(manifest.sessionFile),
		);
		const sessionManager = canResume
			? SessionManager.open(manifest!.sessionFile, sessionsDir, this.config.dataDir)
			: SessionManager.create(this.config.dataDir, sessionsDir);
		if (!canResume && (manifest != null || hasAnySession)) {
			this.epoch += 1;
			setBotState(this.db, this.bot.id, EPOCH_KEY, String(this.epoch));
			replaceVisibleMessageIds(this.db, this.bot.id, chatId, this.epoch, []);
			this.visibleMessageIds.clear();
		}

		const payloadKey = sha256(
			`telegram-payload-observer:${this.config.routerSecret ?? this.config.dataDir}:${this.bot.id}`,
		);
		this.telemetryHmacKey = payloadKey;
		const extensions = [
			// The image resolver is only wired in context mode; in vision mode the context is
			// text-only (vision descriptions render inside the serialized placeholders).
			makeTelegramContextExtension(
				this.config.media.mode === "context"
					? createContextImageResolver(join(this.config.dataDir, "media"))
					: undefined,
			),
			makeTelegramCompactionExtension((event) => this.handleBeforeCompact(event)),
			makeCachePayloadObserverExtension(payloadKey, (observation) => {
				this.pendingPayloadObservations.push(observation);
				if (this.pendingPayloadObservations.length > 8) this.pendingPayloadObservations.shift();
			}),
			makeAssistantPersistencePolicyExtension(
				(text) => {
					this.recordEvent("assistant_text", { text });
					log.info("agent_runtime", "model_silence", {
						bot_id: this.bot.id,
						trigger_message_id: this.currentTriggerMessageId,
					});
				},
				(message) => this.captureAssistantActivity(message),
			),
		];
		const loader = new DefaultResourceLoader({
			cwd: this.config.dataDir,
			agentDir: join(this.config.dataDir, "pi-agent"),
			systemPrompt,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: extensions,
		});
		await loader.reload();

		const { session } = await createAgentSession({
			cwd: this.config.dataDir,
			model,
			thinkingLevel: this.bot.reasoningEffort,
			modelRuntime: this.modelRuntime,
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true, reserveTokens, keepRecentTokens: this.bot.compactionKeepRecent },
				retry: { ...providerRetryPolicy(this.bot.providerRetries), provider: { maxRetries: 0 } },
			}),
			resourceLoader: loader,
			noTools: "builtin",
			customTools: activeTools,
		});
		this.session = session;
		const streamFunction = session.agent.streamFunction;
		session.agent.streamFunction = (requestModel, context, options) =>
			guardProviderCall(
				(signal) =>
					streamFunction(requestModel, context, {
						...options,
						signal,
						cacheRetention: this.bot.cacheRetention,
						timeoutMs: this.bot.providerTimeoutMs,
					}),
				requestModel,
				options?.signal,
				{
					timeoutMs: this.bot.providerTimeoutMs,
				},
			);
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error(`persistent session file unavailable for bot ${this.bot.id}`);
		setSessionManifest(this.db, {
			botId: this.bot.id,
			sessionId: session.sessionId,
			sessionFile,
			contextFingerprint: this.contextFingerprint,
			createdAt: canResume ? manifest!.createdAt : Date.now(),
		});
		this.reconcileContextStateFromSession();
		this.subscribeEvents();
		log.info("agent_runtime", "session_ready", {
			bot_id: this.bot.id,
			state: canResume ? "resumed" : "new",
			epoch: this.epoch,
			fingerprint: this.contextFingerprint.slice(0, 12),
			system_hash: this.systemHash,
			tools_hash: this.toolsHash,
			tools: activeTools.map((tool) => tool.name).join(","),
			cache_schema: CACHE_SCHEMA_VERSION,
		});
	}

	/** Recover the SQLite half of prior custom-message commits without parsing rendered text. */
	private reconcileContextStateFromSession(): void {
		if (!this.session) return;
		const chatId = Number(`-100${this.config.groupPeerId}`);
		const state = contextStateFromEntries(
			this.session.sessionManager.buildContextEntries(),
			getConsumedSeq(this.db, this.bot.id, chatId),
		);
		setConsumedSeq(this.db, this.bot.id, chatId, state.consumedSeq);
		replaceVisibleMessageIds(this.db, this.bot.id, chatId, this.epoch, [...state.visible]);
		const delivered = this.deliveredCommitIdsFromEntries(this.session.sessionManager.getBranch());
		removeReplyObligations(
			this.db,
			this.bot.id,
			[...delivered].map((messageId) => ({ chatId, messageId })),
		);
		this.visibleMessageIds = state.visible;
	}

	/** Structured context ownership; provider-rendered strings are never parsed for identities. */
	private deliveredCommitIdsFromEntries(entries: readonly SessionEntry[]): Set<number> {
		const delivered = new Set<number>();
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== TELEGRAM_CONTEXT_COMMIT_TYPE) continue;
			const ids = (entry.data as { deliveredObligationIds?: unknown } | undefined)?.deliveredObligationIds;
			if (!Array.isArray(ids)) continue;
			for (const messageId of ids) {
				if (Number.isSafeInteger(messageId) && (messageId as number) > 0) delivered.add(messageId as number);
			}
		}
		return delivered;
	}

	private subscribeEvents(): void {
		if (!this.session) return;
		this.session.subscribe((event) => {
			const now = Date.now();
			switch (event.type) {
				case "agent_start":
					this.beginAssistantActivity(now);
					this.running = true;
					this.runStartTs = now;
					this.providerCallsInRun = 0;
					this.lastLlmRunId = null;
					this.lastUsageRun = null;
					this.thinkingStartedAt = 0;
					this.thinkingMs = 0;
					this.thinkingFinished = false;
					this.pendingPayloadObservations = [];
					break;
				case "message_start":
					if (event.message.role === "assistant") {
						this.observeThinking(event.message, now);
						this.updateAssistantStream(event.message, now);
					}
					break;
				case "message_update":
					if (event.message.role === "assistant") {
						this.observeThinking(event.message, now);
						this.updateAssistantStream(event.message, now);
					}
					break;
				case "message_end": {
					const msg = event.message;
					if (msg.role === "assistant") {
						this.observeThinking(msg, now, true);
						const thinking = msg.content
							.filter((c) => c.type === "thinking")
							.map((c) => (c as { thinking: string }).thinking)
							.join("\n");
						if (thinking.trim()) this.recordEvent("thinking", { text: thinking });
						if (msg.usage) this.recordUsage(msg.usage, now);
					}
					break;
				}
				case "auto_retry_start":
					log.warn("agent_runtime", "provider_retry_scheduled", {
						bot_id: this.bot.id,
						scope: "chat",
						attempt: event.attempt,
						delay_ms: event.delayMs,
					});
					break;
				case "agent_end":
					break;
				case "tool_execution_start":
					this.recordEvent("tool_call", { tool: event.toolName, args: event.args });
					log.info("agent_tool", "execution_started", {
						bot_id: this.bot.id,
						tool: event.toolName,
						trigger_message_id: this.currentTriggerMessageId,
					});
					break;
				case "tool_execution_end":
					if (event.toolName === "send") {
						try {
							this.recordEvent("tool_result", { tool: event.toolName, isError: event.isError });
						} catch {
							log.warn("agent_tool", "result_persist_failed", {
								bot_id: this.bot.id,
								tool: "send",
								category: "local_failure",
							});
						}
					} else {
						this.recordEvent("tool_result", { tool: event.toolName, isError: event.isError });
					}
					log.info("agent_tool", "execution_finished", {
						bot_id: this.bot.id,
						tool: event.toolName,
						is_error: event.isError,
						trigger_message_id: this.currentTriggerMessageId,
					});
					break;
				case "agent_settled":
					this.running = false;
					this.typingLease.stop();
					this.finishAssistantActivity(now);
					// no flush re-trigger here: the flush loop owns pendingTrigger (REQ-AGENT-0001 R1)
					break;
				case "compaction_end":
					this.onCompactionEnd(event);
					break;
			}
		});
	}

	private observeThinking(message: Extract<AgentMessage, { role: "assistant" }>, now: number, ended = false): void {
		if (this.thinkingFinished) return;
		const hasThinking = message.content.some(
			(content) => content.type === "thinking" && Boolean((content as { thinking?: string }).thinking),
		);
		const hasAnswer = message.content.some((content) =>
			content.type !== "thinking" && content.type !== "text" ? true : content.type === "text" && Boolean(content.text),
		);
		if (hasThinking && this.thinkingStartedAt === 0) this.thinkingStartedAt = now;
		if (this.thinkingStartedAt > 0 && (hasAnswer || ended)) {
			this.thinkingMs += Math.max(0, now - this.thinkingStartedAt);
			this.thinkingStartedAt = 0;
			this.thinkingFinished = true;
		} else if (ended) {
			this.thinkingFinished = true;
		}
	}

	private beginAssistantActivity(now: number): void {
		if (this.activity) return;
		const streamId = `${this.bot.id}-${++this.streamSequence}`;
		this.activeStreamId = streamId;
		this.activity = new AgentActivityCollector(`${this.bot.id}:${now}:${++this.activitySequence}`, now);
		this.activeAssistantMessage = null;
		if (!this.wantsAssistantStream()) return;
		this.streamSink?.({
			phase: "start",
			streamId,
			botId: this.bot.id,
			botName: this.bot.name,
			ts: now,
		});
	}

	private updateAssistantStream(
		message: Extract<AgentSessionEvent, { type: "message_update" }>["message"],
		now: number,
	): void {
		if (message.role !== "assistant") return;
		if (!this.activity || !this.activeStreamId) this.beginAssistantActivity(now);
		this.activeAssistantMessage = message;
		this.emitAssistantActivity(now);
	}

	private captureAssistantActivity(message: Extract<AgentMessage, { role: "assistant" }>): void {
		if (!this.activity) this.beginAssistantActivity(Date.now());
		this.activity?.captureAssistant(message);
		this.activeAssistantMessage = null;
		this.emitAssistantActivity(Date.now());
	}

	private emitAssistantActivity(now: number): void {
		const streamId = this.activeStreamId;
		const activity = this.activity;
		if (!streamId || !activity || !this.wantsAssistantStream()) return;
		const snapshot = activity.snapshot(this.activeAssistantMessage);
		if (snapshot.sections.length === 0) return;
		this.streamSink?.({
			phase: "update",
			streamId,
			botId: this.bot.id,
			botName: this.bot.name,
			ts: now,
			activity: snapshot,
		});
	}

	private finishAssistantActivity(now: number): void {
		const activity = this.activity;
		if (!activity) {
			this.endAssistantStream(now);
			return;
		}
		const snapshot = activity.snapshot(this.activeAssistantMessage);
		this.activity = null;
		this.activeAssistantMessage = null;
		try {
			if (snapshot.sections.length > 0) this.recordEvent("agent_activity", snapshot);
		} finally {
			this.endAssistantStream(now);
		}
	}

	private endAssistantStream(now = Date.now()): void {
		const streamId = this.activeStreamId;
		if (!streamId) return;
		this.activeStreamId = null;
		if (!this.wantsAssistantStream()) return;
		this.streamSink?.({
			phase: "end",
			streamId,
			botId: this.bot.id,
			botName: this.bot.name,
			ts: now,
		});
	}

	private wantsAssistantStream(): boolean {
		return this.streamSink != null && (this.streamDemand?.() ?? true);
	}

	/** Successful compaction rotates only provider visibility; the business cursor is monotonic. */
	private onCompactionEnd(event: Extract<AgentSessionEvent, { type: "compaction_end" }>): void {
		if (event.aborted || !event.result) {
			const category = classifyPiProviderFailure(event.errorMessage ?? "compaction failed");
			this.recordEvent("error", { stage: "compaction", reason: event.reason, aborted: event.aborted, category });
			this.lastControlCompact = { at: Date.now(), outcome: "failed" };
			log.error("agent_runtime", "compaction_failed", {
				bot_id: this.bot.id,
				reason: event.reason,
				aborted: event.aborted,
				category,
			});
			return;
		}
		this.epoch += 1;
		setBotState(this.db, this.bot.id, EPOCH_KEY, String(this.epoch));
		const details = event.result.details as { visibleMessageIds?: unknown } | undefined;
		const kept = Array.isArray(details?.visibleMessageIds)
			? details.visibleMessageIds.filter(
					(messageId): messageId is number => Number.isSafeInteger(messageId) && (messageId as number) > 0,
				)
			: [];
		this.visibleMessageIds = new Set(kept);
		const chatId = Number(`-100${this.config.groupPeerId}`);
		replaceVisibleMessageIds(this.db, this.bot.id, chatId, this.epoch, kept);
		this.recordEvent("compaction", { epoch: this.epoch, kept: kept.length });
		this.lastControlCompact = { at: Date.now(), outcome: "ok" };
		log.info("agent_runtime", "compaction_committed", { bot_id: this.bot.id, epoch: this.epoch, kept: kept.length });
		try {
			this.mediaPruneSink?.();
		} catch {
			log.error("media_cache", "prune_observer_failed", {
				bot_id: this.bot.id,
				category: "observer_failed",
			});
		}
	}

	/** session_before_compact handler: empty summary is refused via cancel, never persisted. */
	private async handleBeforeCompact(
		event: SessionBeforeCompactEvent,
	): Promise<{ cancel: true } | { compaction: CompactionResult }> {
		try {
			const prep = event.preparation;
			const gen = await this.generateCompactionSummary(prep, event.signal);
			if (!("summary" in gen)) {
				// NOTE: the SDK swallows extension handler exceptions and would silently fall back
				// to the default summarizer, so refusal goes through cancel -> compaction_end { aborted: true }.
				this.recordEvent("error", { stage: "compaction", error: gen.failure });
				return { cancel: true };
			}
			const branchEntries = event.branchEntries;
			const keptIndex = branchEntries.findIndex((entry) => entry.id === prep.firstKeptEntryId);
			const keptEntries = keptIndex >= 0 ? branchEntries.slice(keptIndex) : [];
			const chatId = Number(`-100${this.config.groupPeerId}`);
			const state = contextStateFromEntries(keptEntries, getConsumedSeq(this.db, this.bot.id, chatId));
			const unresolvedReplyMessageIds = listReplyObligations(this.db, this.bot.id, chatId, MAX_OBLIGATION_SCAN).map(
				(obligation) => obligation.messageId,
			);
			return {
				compaction: {
					summary: gen.summary,
					firstKeptEntryId: prep.firstKeptEntryId,
					tokensBefore: prep.tokensBefore,
					usage: gen.usage,
					details: {
						version: TELEGRAM_CONTEXT_VERSION,
						consumedSeq: state.consumedSeq,
						visibleMessageIds: [...state.visible],
						unresolvedReplyMessageIds,
					},
				},
			};
		} catch (error) {
			// Pi falls back to its default summarizer if an extension throws. Refuse explicitly.
			log.warn("agent_runtime", "compaction_handler_failed", {
				bot_id: this.bot.id,
				category: errorCategory(error),
			});
			return { cancel: true };
		}
	}

	/** The configured summary model shares the native retry policy and request watchdog. */
	private async generateCompactionSummary(
		prep: SessionBeforeCompactEvent["preparation"],
		signal: AbortSignal,
	): Promise<
		{ summary: string; usage: Awaited<ReturnType<ModelRuntime["completeSimple"]>>["usage"] } | { failure: string }
	> {
		const conversation = serializeCompactionMessages(prep.messagesToSummarize);
		const userText =
			`<conversation>\n${conversation}\n</conversation>\n\n` +
			(prep.previousSummary
				? `<previous-summary>\n${prep.previousSummary}\n</previous-summary>\n\n把上面的旧摘要与新内容合并成一份更新的摘要。`
				: "请输出摘要。");
		const request = {
			systemPrompt: COMPACTION_SUMMARY_PROMPT,
			messages: [{ role: "user" as const, content: userText, timestamp: Date.now() }],
		};
		const model = this.compactionModel;
		const result = await retryAssistantCall(
			async () => {
				const response = await guardProviderCall(
					(attemptSignal) =>
						this.modelRuntime.streamSimple(model, request, {
							cacheRetention: "none",
							maxTokens: Math.min(4096, model.maxTokens),
							reasoning: this.compactionReasoning,
							signal: attemptSignal,
							timeoutMs: this.bot.providerTimeoutMs,
							maxRetries: 0,
						}),
					model,
					signal,
					{ timeoutMs: this.bot.providerTimeoutMs },
				).result();
				try {
					this.recordCompactionUsage(response.usage, Date.now(), model);
				} catch {
					log.warn("agent_runtime", "compaction_usage_failed", { bot_id: this.bot.id, category: "local_failure" });
				}
				return response;
			},
			providerRetryPolicy(this.bot.providerRetries),
			signal,
			{
				onRetryScheduled: (attempt, _maxAttempts, delayMs) =>
					log.warn("agent_runtime", "provider_retry_scheduled", {
						bot_id: this.bot.id,
						scope: "compaction",
						attempt,
						delay_ms: delayMs,
					}),
			},
		);
		if (result.stopReason === "error" || result.stopReason === "aborted") {
			return { failure: `summary generation ${result.stopReason}` };
		}
		const summary = contentText(result.content);
		if (!summary.trim()) return { failure: "empty summary" };
		return { summary, usage: result.usage };
	}

	private executeSend(params: SendParams) {
		return executeAgentSend(params, {
			db: this.db,
			api: this.api,
			botId: this.bot.id,
			chatId: Number(`-100${this.config.groupPeerId}`),
			emitMediaUpdates: this.config.media.mode === "vision",
			visibleMessageIds: this.visibleMessageIds,
			triggerMessageId: this.currentTriggerMessageId,
			recordPublicSend: () => this.recordPublicSend(),
			markVisible: (ids) => this.markVisible(ids),
			onSent: (raw) => this.sentMessageSink?.(raw),
			recordEvent: (kind, payload) => this.recordEvent(kind, payload),
			stopTyping: () => {
				this.typingLease.stop();
			},
			recordDuration: (durationMs) => this.recordSendDuration(durationMs),
		});
	}

	/** Lifecycle state used by deterministic scheduling and the Telegram control plane. */
	samplingState(now = this.monotonicNow()): "idle" | "busy" | "cooldown" | "stopping" {
		if (this.stopping) return "stopping";
		if (this.flushing || this.controlCompacting) return "busy";
		if (now < this.cooldownUntil) return "cooldown";
		return "idle";
	}

	isAvailableForSampling(now = this.monotonicNow()): boolean {
		return this.samplingState(now) === "idle";
	}

	/** Called by the scheduler when this bot gets a response opportunity. */
	trigger(source: TriggerSource = "explicit", routingTrigger?: RoutingTrigger): TriggerResult {
		// SHARED_PROTOCOL: explicit @mention, reply-to-bot, and configured-name keyword are all
		// direct addresses that must reach the provider even when this trigger only coalesces.
		const isDirectReply =
			routingTrigger != null &&
			(routingTrigger.reason === "explicit" || routingTrigger.reason === "reply" || routingTrigger.reason === "name");
		let directReplyPending = false;
		let directReplyMessageId: number | null = null;
		if (routingTrigger) this.currentTriggerMessageId = routingTrigger.messageId;
		if (isDirectReply && !this.visibleMessageIds.has(routingTrigger.messageId)) {
			const created = createReplyObligation(this.db, this.bot.id, routingTrigger.chatId, routingTrigger.messageId);
			directReplyPending = true;
			directReplyMessageId = routingTrigger.messageId;
			const alreadyRecorded = this.db
				.query(
					"SELECT 1 FROM agent_events WHERE bot_id = ? AND kind = 'reply_obligation_created' AND json_extract(payload, '$.message_id') = ? LIMIT 1",
				)
				.get(this.bot.id, routingTrigger.messageId);
			if (created || !alreadyRecorded) {
				this.recordEvent("reply_obligation_created", { message_id: routingTrigger.messageId });
			}
		}
		const state = this.samplingState();
		if (state === "stopping") return "skipped_stopping";
		if (source === "probability" && state !== "idle") {
			return state === "busy" ? "skipped_busy" : "skipped_cooldown";
		}
		if (this.controlCompacting) {
			this.pendingTrigger = true;
			return "coalesced";
		}
		if (this.flushing) {
			// re-entrant trigger while a flush is in flight (e.g. slow media download):
			// coalesce into pendingTrigger; the loop picks it up (burst merge, R1)
			this.pendingTrigger = true;
			if (directReplyPending && directReplyMessageId != null) {
				this.recordEvent("reply_obligation_coalesced", { message_id: directReplyMessageId });
			}
			return "coalesced";
		}
		if (source === "probability") this.cooldownAfterFlush = true;
		this.flushing = true; // set synchronously, before any await — never gated on SDK events
		log.info("agent_runtime", "flush_started", {
			bot_id: this.bot.id,
			source,
			trigger_message_id: this.currentTriggerMessageId,
			direct_reply: isDirectReply,
		});
		this.typingLease.start();
		this.flushPromise = this.flushLoop()
			.catch((err) => {
				const category = classifyPiProviderFailure(err);
				// R3: a failed flush only produces an error event; nothing escapes as an
				// unhandled rejection. Uncommitted events are retried by later triggers.
				try {
					this.recordEvent("error", { stage: "flush", category });
				} catch {
					// shutdown may have closed the db under a wedged flush; nothing more to do
				}
				log.error("agent_runtime", "flush_failed", {
					bot_id: this.bot.id,
					category,
					trigger_message_id: this.currentTriggerMessageId,
				});
			})
			.finally(() => {
				this.flushing = false;
				this.flushPromise = null;
				if (this.cooldownAfterFlush) {
					this.cooldownUntil = this.monotonicNow() + this.bot.samplingCooldownMs;
					this.cooldownAfterFlush = false;
				}
				// A trigger that arrived between the flushLoop do-while exit and this finally saw
				// `flushing === true` and only set pendingTrigger, but the loop is already gone.
				// Re-arm it here once the flag is cleared (same pattern as compactForControl).
				if (this.pendingTrigger && !this.stopping) {
					this.pendingTrigger = false;
					this.trigger("explicit");
				}
			});
		return "started";
	}

	private async flushLoop(): Promise<void> {
		try {
			let moreReplies = false;
			do {
				this.pendingTrigger = false;
				this.typingLease.start();
				moreReplies = await this.flush();
			} while ((this.pendingTrigger || moreReplies) && !this.stopping);
		} finally {
			this.typingLease.stop();
		}
	}

	/** Read a bounded immutable event window, commit its cursor, and wake the agent. */
	private async flush(): Promise<boolean> {
		if (!this.session) return false;
		const chatId = Number(`-100${this.config.groupPeerId}`);
		const obligations = listReplyObligations(this.db, this.bot.id, chatId, MAX_OBLIGATION_SCAN);

		const consumedSeq = getConsumedSeq(this.db, this.bot.id, chatId);
		let highWater = messageEventHighWater(this.db, chatId);
		let recent = listRecentMessageEvents(this.db, chatId, consumedSeq, highWater, MAX_EVENT_SCAN);
		let obligationEvents = listReplyObligationEvents(this.db, this.bot.id, chatId, MAX_OBLIGATION_SCAN);
		let rowsScanned = recent.length + obligationEvents.length;
		const consumedControl = consumedControlMessageIds(this.db, chatId);
		const obligationIds = new Set(obligations.map((obligation) => obligation.messageId));
		const ordinaryEvents = (): MessageEvent[] =>
			recent.filter(
				(event) =>
					!consumedControl.has(event.messageId) &&
					!obligationIds.has(event.messageId) &&
					!(event.kind === "message" && this.visibleMessageIds.has(event.messageId)),
			);
		const requiredEvents = (): MessageEvent[] => {
			const seen = new Set<number>();
			const result: MessageEvent[] = [];
			const candidates = [...obligationEvents, ...recent.filter((event) => obligationIds.has(event.messageId))];
			for (const event of candidates) {
				if (consumedControl.has(event.messageId) || seen.has(event.ingestSeq)) continue;
				seen.add(event.ingestSeq);
				result.push(event);
			}
			return result;
		};
		let mandatory = requiredEvents();
		let normal = ordinaryEvents();

		this.pendingInputMetrics = {
			inputEvents: 0,
			estimatedTokens: 0,
			rowsScanned: 0,
			visionCalls: 0,
			imagesAttached: 0,
		};
		if (this.config.media.mode === "context") {
			await this.ensureBatchContextMedia([...mandatory, ...normal], obligationIds);
		} else {
			await this.ensureBatchVision([...mandatory, ...normal], obligationIds);
			// Vision descriptions land as media_update events mid-scan: pick them up so the
			// same flush already sees the fresh descriptions.
			const postVisionHighWater = messageEventHighWater(this.db, chatId);
			if (postVisionHighWater > highWater) {
				highWater = postVisionHighWater;
				recent = listRecentMessageEvents(this.db, chatId, consumedSeq, highWater, MAX_EVENT_SCAN);
				obligationEvents = listReplyObligationEvents(this.db, this.bot.id, chatId, MAX_OBLIGATION_SCAN);
				rowsScanned += recent.length + obligationEvents.length;
				mandatory = requiredEvents();
				normal = ordinaryEvents();
			}
		}
		const usage = this.session.getContextUsage();
		const suffixBudget = availableSuffixBudget({
			contextWindow: usage?.contextWindow ?? this.model.contextWindow,
			currentContextTokens: usage?.tokens ?? 0,
			staticPrefixTokens: this.staticPrefixTokenEstimate,
			maxSuffixTokens: this.bot.maxSuffixTokens,
			outputReserve: Math.min(4096, this.model.maxTokens),
			reasoningReserve: this.bot.reasoningEffort === "off" ? 0 : 4096,
			toolFollowupReserve: this.bot.tools.search || this.bot.tools.runJs ? 6144 : 2048,
		});
		const packed = packMessageEvents(
			this.db,
			mandatory,
			normal,
			suffixBudget,
			{ visibleIds: new Set(this.visibleMessageIds) },
			this.bot.maxMessageTokens,
			this.config.media.mode === "context"
				? {
						refs: (fileUniqueId) => contextMediaRefs(this.db, fileUniqueId),
						maxImages: this.config.media.maxImagesPerTurn,
					}
				: undefined,
		);
		log.info("agent_runtime", "context_packed", {
			bot_id: this.bot.id,
			trigger_message_id: this.currentTriggerMessageId,
			consumed_seq: consumedSeq,
			high_water: highWater,
			rows_scanned: rowsScanned,
			input_events: packed.events.length,
			visible_count: packed.visibleMessageIds.length,
			obligation_count: obligations.length,
			estimated_tokens: packed.estimatedTokens,
			images_attached: packed.imagesAttached,
			suffix_budget: suffixBudget,
		});
		if (packed.deferredMandatory > 0) {
			log.warn("agent_runtime", "obligations_deferred", {
				bot_id: this.bot.id,
				trigger_message_id: this.currentTriggerMessageId,
				deferred_mandatory: packed.deferredMandatory,
				suffix_budget: suffixBudget,
			});
		}
		if (!packed.text.trim()) {
			if (highWater > consumedSeq) setConsumedSeq(this.db, this.bot.id, chatId, highWater);
			// No provider call was made: nothing changed, so looping again cannot make progress.
			// Deferred obligations stay pending until the next trigger or a compaction frees budget.
			return false;
		}
		const stickerCandidates = recentContextStickerCandidates(
			this.db,
			this.bot.id,
			chatId,
			this.epoch,
			packed.visibleMessageIds,
		);
		const stickerCandidateTokens = stickerCandidates ? estimateProviderTokensUpperBound(`\n\n${stickerCandidates}`) : 0;
		const boundedStickerCandidates =
			stickerCandidates && packed.estimatedTokens + stickerCandidateTokens <= suffixBudget ? stickerCandidates : "";
		const boundedStickerCandidateTokens = boundedStickerCandidates
			? estimateProviderTokensUpperBound(`\n\n${boundedStickerCandidates}`)
			: 0;

		// Persisted content is pure message bytes. The sticker candidate tail lives only in
		// details.stickerCandidates and reaches the provider through the context-event
		// projection (extensions/context.ts), which appends it to the last context message at
		// request time. Never bake it into persisted bytes: compaction reads persisted content
		// directly, and baked tails would accumulate one stale block per turn.
		const selectedIds = new Set(packed.visibleMessageIds);
		const delivered = obligations.filter((obligation) => selectedIds.has(obligation.messageId));
		const details: TelegramContextDetails = {
			version: TELEGRAM_CONTEXT_VERSION,
			consumedSeq: highWater,
			providerText: packed.text,
			blocks: buildTelegramContextBlocks(packed.segments),
			stickerCandidates: boundedStickerCandidates,
			visibleMessageIds: packed.visibleMessageIds,
			events: packed.events.map((event) => ({
				ingestSeq: event.ingestSeq,
				kind: event.kind,
				chatId: event.chatId,
				messageId: event.messageId,
				fullMessageVisible: event.kind === "message" || event.kind === "edit",
			})),
		};
		this.currentTriggerMessageId = packed.events.at(-1)?.messageId ?? this.currentTriggerMessageId;
		this.pendingInputMetrics = {
			inputEvents: packed.events.length,
			estimatedTokens: packed.estimatedTokens + boundedStickerCandidateTokens,
			rowsScanned,
			visionCalls: this.pendingInputMetrics.visionCalls,
			imagesAttached: packed.imagesAttached,
		};
		// sendCustomMessage(triggerTurn) does not resolve until the provider turn, including
		// tool execution, has finished. Make only the fully packed references addressable
		// during that turn; durable visibility still commits after the session submission.
		for (const messageId of packed.visibleMessageIds) this.visibleMessageIds.add(messageId);
		try {
			await this.session.sendCustomMessage(
				{ customType: TELEGRAM_CONTEXT_TYPE, content: packed.text, display: false, details },
				{ triggerTurn: true },
			);
		} catch (error) {
			this.reconcileContextStateFromSession();
			throw error;
		}
		log.info("agent_runtime", "provider_turn_settled", {
			bot_id: this.bot.id,
			trigger_message_id: this.currentTriggerMessageId,
			input_events: packed.events.length,
			provider_calls: this.providerCallsInRun,
		});
		await this.maybeAutoCompact();
		const deliveredObligationIds = delivered.map((obligation) => obligation.messageId);
		if (deliveredObligationIds.length > 0) {
			this.session.sessionManager.appendCustomEntry(TELEGRAM_CONTEXT_COMMIT_TYPE, {
				consumedSeq: highWater,
				deliveredObligationIds,
			});
		}
		commitConsumedContext(this.db, {
			botId: this.bot.id,
			chatId,
			consumedSeq: highWater,
			epoch: this.epoch,
			visibleMessageIds: packed.visibleMessageIds,
			deliveredObligationIds,
		});
		for (const obligation of delivered) {
			this.recordEvent("reply_obligation_delivered", { message_id: obligation.messageId });
		}
		return replyObligationCount(this.db, this.bot.id, chatId) > 0;
	}

	/** Schedule persisted direct replies after startup; committed rows reconcile idempotently. */
	recoverReplyObligations(): TriggerResult | null {
		const chatId = Number(`-100${this.config.groupPeerId}`);
		const obligations = listReplyObligations(this.db, this.bot.id, chatId, MAX_OBLIGATION_SCAN);
		if (obligations.length === 0) return null;
		for (const obligation of obligations) {
			this.recordEvent("reply_obligation_recovered", { message_id: obligation.messageId });
		}
		return this.trigger("explicit");
	}

	/** Public read model for deterministic Telegram status output. */
	controlSnapshot(): RuntimeControlSnapshot {
		const contextUsage = this.session?.getContextUsage();
		return {
			state: this.controlCompacting ? "compacting" : this.samplingState(),
			epoch: this.epoch,
			provider: this.model.provider,
			model: this.model.id,
			reasoningEffort: this.session?.thinkingLevel ?? this.bot.reasoningEffort,
			contextWindow: this.model.contextWindow,
			currentContextTokens: contextUsage?.tokens ?? null,
			routingP: this.bot.routingP,
			samplingCooldownMs: this.bot.samplingCooldownMs,
			lastCompact: this.lastControlCompact,
		};
	}

	/** Keep a control command/reply out of the current epoch; durable exclusion is audit-backed. */
	consumeControlMessage(messageId: number): void {
		if (!Number.isSafeInteger(messageId) || messageId <= 0) return;
		const chatId = Number(`-100${this.config.groupPeerId}`);
		removeReplyObligations(this.db, this.bot.id, [{ chatId, messageId }]);
	}

	/**
	 * Compact when the real context cost exceeds the configured threshold. Pi's own
	 * threshold check only sees provider-billed tokens, so image-heavy contexts never
	 * compact on their own; this closes that gap after each settled provider turn.
	 * After a successful compaction the retained images are pruned (files + DB refs):
	 * they are summarized away and must not keep shipping as base64, otherwise the
	 * compacted context would immediately re-trip the image budget.
	 */
	private async maybeAutoCompact(): Promise<void> {
		if (this.stopping || !this.session) return;
		// Called from inside flush() after the provider turn settled, so `flushing` is
		// always true here and must not gate the check (it silently disabled compaction
		// for image-heavy contexts). `running` is also still true at this point: Pi emits
		// agent_settled only after agent.prompt() resolves, i.e. after sendCustomMessage
		// has already returned. The turn itself is over (isStreaming is false), so
		// compacting is safe.
		if (this.controlCompacting || this.session.isStreaming) {
			log.warn("agent_runtime", "auto_compact_skipped", {
				bot_id: this.bot.id,
				control_compacting: this.controlCompacting,
				is_streaming: this.session.isStreaming,
			});
			return;
		}
		try {
			const usage = this.session.getContextUsage();
			const piTokens = usage?.tokens ?? 0;
			const entries = this.session.sessionManager.buildContextEntries?.() ?? [];
			const imageBytes = contextImageBytes(entries, join(this.config.dataDir, "media"));
			if (piTokens <= this.bot.compactionThreshold && imageBytes <= this.bot.contextImageBudgetBytes) return;
			log.info("agent_runtime", "auto_compact_triggered", {
				bot_id: this.bot.id,
				pi_tokens: piTokens,
				image_bytes: imageBytes,
				threshold: this.bot.compactionThreshold,
				image_budget: this.bot.contextImageBudgetBytes,
			});
			await this.session.compact();
			this.pruneCompactedImages();
		} catch (error) {
			// Estimation or compaction failure must never break the settled flush.
			log.warn("agent_runtime", "auto_compact_failed", {
				bot_id: this.bot.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Delete image files (and their DB refs) still referenced by the compacted context. */
	private pruneCompactedImages(): void {
		const entries = this.session?.sessionManager.buildContextEntries() ?? [];
		const names = contextImageNames(entries);
		if (names.size === 0) return;
		const mediaDir = join(this.config.dataDir, "media");
		for (const name of names) {
			try {
				unlinkSync(join(mediaDir, name));
			} catch {
				// already gone
			}
		}
		const rows = this.db
			.query("SELECT file_unique_id, context_files FROM media WHERE context_files IS NOT NULL")
			.all() as { file_unique_id: string; context_files: string }[];
		for (const row of rows) {
			try {
				const refs = JSON.parse(row.context_files) as { name?: unknown }[];
				if (refs.some((ref) => typeof ref.name === "string" && names.has(ref.name))) {
					this.db.query("UPDATE media SET context_files = NULL WHERE file_unique_id = ?").run(row.file_unique_id);
				}
			} catch {
				// malformed refs: leave as-is
			}
		}
		log.info("agent_runtime", "compaction_images_pruned", { bot_id: this.bot.id, images: names.size });
	}

	/** Manual compact that never passes instructions and never aborts an active response. */
	async compactForControl(): Promise<ManualCompactResult> {
		if (this.stopping) return { ok: false, code: "stopping" };
		if (!this.session) return { ok: false, code: "unavailable" };
		if (this.flushing || this.running || this.controlCompacting || this.session.isStreaming) {
			return { ok: false, code: "busy" };
		}
		this.controlCompacting = true;
		try {
			const result = await this.session.compact();
			this.lastControlCompact = { at: Date.now(), outcome: "ok" };
			return { ok: true, epoch: this.epoch, tokensBefore: result.tokensBefore };
		} catch (error) {
			this.lastControlCompact = { at: Date.now(), outcome: "failed" };
			const message = error instanceof Error ? error.message : String(error);
			// Depends on Pi session.compact() error wording; re-check these strings when upgrading Pi.
			return {
				ok: false,
				code: /Nothing to compact|Already compacted/.test(message) ? "nothing_to_compact" : "failed",
			};
		} finally {
			this.controlCompacting = false;
			if (this.pendingTrigger && !this.stopping) {
				this.pendingTrigger = false;
				this.trigger("explicit");
			}
		}
	}

	/**
	 * Prepare context images for the batch: download + convert/sample only, never a provider
	 * call. Bounded per turn, with direct-reply events ordered before ordinary catch-up.
	 * Preparation failures are transient (retried on a later turn); packing falls back to the
	 * text placeholder when no prepared refs exist.
	 */
	private async ensureBatchContextMedia(
		batch: readonly MessageEvent[],
		obligationIds: ReadonlySet<number>,
	): Promise<void> {
		if (this.config.media.maxImagesPerTurn <= 0) return;
		const pending: string[] = [];
		const seen = new Set<string>();
		const prioritized = [...batch].sort(
			(left, right) =>
				Number(obligationIds.has(right.messageId)) - Number(obligationIds.has(left.messageId)) ||
				right.ingestSeq - left.ingestSeq,
		);
		for (const event of prioritized) {
			if (event.kind !== "message") continue;
			const row = event.payload as MessageRow;
			if (!row.media) continue;
			const media = JSON.parse(row.media) as { kind: string; mime?: string; file_unique_id?: string };
			if (!media.file_unique_id || !isVisionMedia(media.kind, media.mime)) continue;
			if (seen.has(media.file_unique_id)) continue;
			seen.add(media.file_unique_id);
			if (contextMediaRefs(this.db, media.file_unique_id)) continue; // already prepared, shared by both bots
			pending.push(media.file_unique_id);
			if (pending.length >= this.config.media.maxImagesPerTurn) break;
		}

		let next = 0;
		const workers = Math.min(this.config.media.downloadConcurrency, pending.length);
		await Promise.all(
			Array.from({ length: workers }, async () => {
				while (next < pending.length) {
					const fileUniqueId = pending[next++]!;
					try {
						await ensureContextMedia(this.db, this.api, this.bot.id, fileUniqueId, {
							cacheDir: join(this.config.dataDir, "media"),
							botApis: this.botApis,
							videoTranscoder: this.videoTranscoder,
						});
					} catch {
						this.recordEvent("error", { stage: "context_media", category: "request_failed" });
					}
				}
			}),
		);
	}

	/** Lazy vision: bounded per turn, with direct-reply events ordered before ordinary catch-up. */
	private async ensureBatchVision(batch: readonly MessageEvent[], obligationIds: ReadonlySet<number>): Promise<void> {
		if (!this.config.vision.enabled || this.config.vision.foregroundMediaLimit <= 0) return;
		const pending: string[] = [];
		const seen = new Set<string>();
		const prioritized = [...batch].sort(
			(left, right) =>
				Number(obligationIds.has(right.messageId)) - Number(obligationIds.has(left.messageId)) ||
				right.ingestSeq - left.ingestSeq,
		);
		for (const event of prioritized) {
			if (event.kind === "media_update") continue;
			const row = event.payload as MessageRow;
			if (!row.media) continue;
			const media = JSON.parse(row.media) as { kind: string; mime?: string; file_unique_id?: string };
			if (!media.file_unique_id || !isVisionMedia(media.kind, media.mime)) continue;
			if (seen.has(media.file_unique_id)) continue;
			seen.add(media.file_unique_id);
			const existing = this.db.query("SELECT vision FROM media WHERE file_unique_id = ?").get(media.file_unique_id) as {
				vision: string | null;
			} | null;
			if (existing?.vision) continue; // persistent cache hit, shared by both bots
			pending.push(media.file_unique_id);
			if (pending.length >= this.config.vision.foregroundMediaLimit) break;
		}

		let next = 0;
		const workers = Math.min(VISION_BATCH_CONCURRENCY, pending.length);
		await Promise.all(
			Array.from({ length: workers }, async () => {
				while (next < pending.length) {
					const fileUniqueId = pending[next++]!;
					await this.ensureOneVision(fileUniqueId);
				}
			}),
		);
	}

	private async ensureOneVision(fileUniqueId: string): Promise<void> {
		try {
			await ensureVision(this.db, this.api, this.bot.id, fileUniqueId, this.getVisionExecutor(), {
				cacheDir: join(this.config.dataDir, "media"),
				onPersist: (fileUniqueId, text) => this.visionSink?.(fileUniqueId, text),
				onTelemetry: (telemetry) => {
					if (telemetry.providerCalled) {
						this.pendingInputMetrics.visionCalls++;
					}
					this.recordEvent("vision", telemetry);
				},
				scheduler: this.visionScheduler ?? undefined,
				botApis: this.botApis,
				videoTranscoder: this.videoTranscoder,
			});
		} catch {
			this.recordEvent("error", { stage: "vision", category: "request_failed" });
		}
	}

	private getVisionExecutor(): VisionExecutor {
		if (!this.visionExecutor) {
			this.visionExecutor = createPiVisionExecutor(this.modelRuntime, this.config.auxiliaryVisualModel);
		}
		return this.visionExecutor;
	}

	private markVisible(ids: readonly number[]): void {
		for (const id of ids) this.visibleMessageIds.add(id);
		const chatId = Number(`-100${this.config.groupPeerId}`);
		addVisibleMessageIds(this.db, this.bot.id, chatId, this.epoch, ids);
	}

	private recordPublicSend(): void {
		if (this.lastLlmRunId == null) return;
		this.db.query("UPDATE llm_runs SET public_send_count = public_send_count + 1 WHERE id = ?").run(this.lastLlmRunId);
	}

	private recordEvent(kind: string, payload: unknown): void {
		const activity = this.activity;
		const grouped = activity != null && ACTIVITY_RAW_EVENT_KINDS.has(kind);
		const storedPayload = grouped
			? payload && typeof payload === "object" && !Array.isArray(payload)
				? { ...(payload as Record<string, unknown>), activity_id: activity.activityId }
				: { value: payload, activity_id: activity.activityId }
			: payload;
		if (grouped && ACTIVITY_DETAIL_EVENT_KINDS.has(kind)) activity.captureEvent(kind, payload);
		this.db
			.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (?, ?, ?, ?)")
			.run(this.bot.id, Date.now(), kind, JSON.stringify(storedPayload));
		if (grouped) this.emitAssistantActivity(Date.now());
		else this.eventSink?.(kind, payload);
	}

	private recordUsage(
		usage: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			reasoning?: number;
			cost: { total: number };
		},
		now: number,
	): void {
		this.providerCallsInRun++;
		const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		const reasoningTokens = usage.reasoning ?? 0;
		const latencyMs = this.runStartTs ? now - this.runStartTs : null;
		const observation = this.pendingPayloadObservations.shift();
		const contextBreakdown = fitContextBreakdown(
			observation?.tokenEstimate ?? { system: 0, tools: 0, compactedHistory: 0, messages: contextTokens },
			contextTokens,
		);
		const metrics = this.pendingInputMetrics;
		const sessionIdHash = this.session ? sha256(`${this.telemetryHmacKey}:${this.session.sessionId}`) : null;
		const previous =
			usage.cacheRead === 0 &&
			usage.cacheWrite === 0 &&
			this.bot.cacheRetention !== "none" &&
			observation &&
			sessionIdHash
				? (this.db
						.query(`
					SELECT context_tokens contextTokens, system_hash systemHash,
					       tools_hash toolsHash, messages_hash messagesHash
					  FROM llm_runs
					 WHERE bot_id = ? AND compaction = 0 AND provider = ? AND api = ?
					   AND model = ? AND epoch = ? AND session_id_hash = ? AND cache_retention = ?
					 ORDER BY id DESC LIMIT 1
				`)
						.get(
							this.bot.id,
							this.bot.provider,
							this.model.api,
							this.bot.model,
							this.epoch,
							sessionIdHash,
							this.bot.cacheRetention,
						) as {
						contextTokens: number | null;
						systemHash: string | null;
						toolsHash: string | null;
						messagesHash: string | null;
					} | null)
				: null;
		const previousMessageHashes = parseStoredMessageHashes(previous?.messagesHash ?? null);
		const cacheReadEstimated =
			observation &&
			previous &&
			typeof previous.contextTokens === "number" &&
			previous.systemHash &&
			previous.toolsHash &&
			previousMessageHashes
				? estimateCacheReadFromPrefix(
						observation,
						{
							systemHash: previous.systemHash,
							toolsHash: previous.toolsHash,
							messageHashes: previousMessageHashes,
							contextTokens: previous.contextTokens,
						},
						contextTokens,
					)
				: null;
		const effectiveCacheRead = cacheReadEstimated ?? usage.cacheRead;
		const effectiveCacheMiss = cacheReadEstimated == null ? usage.input : contextTokens - cacheReadEstimated;
		const res = this.db
			.query(
				`INSERT INTO llm_runs (
					bot_id, ts, model, epoch, context_tokens, cache_read, cache_write,
					cache_read_estimated, cache_miss,
					output_tokens, reasoning_tokens, latency_ms, cost, compaction,
					system_hash, tools_hash, messages_hash, provider, api, session_id_hash,
					cache_retention, full_payload_hash, first_divergent_segment,
					first_divergent_message_index, first_divergent_byte_offset, trigger_message_id,
					public_send_count, vision_calls, images_attached, tool_followup_rounds, input_events,
					input_tokens_estimated, rows_scanned, system_tokens, tools_tokens,
					compacted_history_tokens, message_tokens, thinking_ms
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				this.bot.id,
				now,
				this.bot.model,
				this.epoch,
				contextTokens,
				usage.cacheRead,
				usage.cacheWrite,
				cacheReadEstimated,
				usage.input,
				usage.output,
				reasoningTokens,
				latencyMs,
				usage.cost.total,
				observation?.systemHash ?? this.systemHash,
				observation?.toolsHash ?? this.toolsHash,
				observation ? JSON.stringify(observation.messageHashes) : null,
				this.bot.provider,
				this.model.api,
				sessionIdHash,
				this.bot.cacheRetention,
				observation?.fullPayloadHash ?? null,
				observation?.firstDivergentSegment ?? null,
				observation?.firstDivergentMessageIndex ?? null,
				observation?.firstDivergentByteOffset ?? null,
				this.currentTriggerMessageId,
				metrics.visionCalls,
				metrics.imagesAttached,
				this.providerCallsInRun > 1 ? 1 : 0,
				metrics.inputEvents,
				metrics.estimatedTokens,
				metrics.rowsScanned,
				contextBreakdown.system,
				contextBreakdown.tools,
				contextBreakdown.compactedHistory,
				contextBreakdown.messages,
				this.thinkingMs,
			);
		this.lastLlmRunId = Number(res.lastInsertRowid);
		this.pendingInputMetrics = {
			inputEvents: 0,
			estimatedTokens: 0,
			rowsScanned: 0,
			visionCalls: 0,
			imagesAttached: 0,
		};
		const run: UsageRun = {
			id: this.lastLlmRunId,
			botId: this.bot.id,
			ts: now,
			model: this.bot.model,
			epoch: this.epoch,
			contextTokens,
			cacheRead: effectiveCacheRead,
			cacheWrite: usage.cacheWrite,
			cacheMiss: effectiveCacheMiss,
			cacheEstimated: cacheReadEstimated != null,
			outputTokens: usage.output,
			reasoningTokens,
			latencyMs,
			thinkingMs: this.thinkingMs,
			contextBreakdown,
			cost: usage.cost.total,
		};
		this.lastUsageRun = run;
		this.usageSink?.(run);
		this.thinkingMs = 0;
		this.thinkingFinished = false;
	}

	private recordSendDuration(durationMs: number): void {
		if (this.lastLlmRunId == null || !Number.isFinite(durationMs)) return;
		this.db
			.query("UPDATE llm_runs SET send_ms = send_ms + ?, send_samples = send_samples + 1 WHERE id = ?")
			.run(Math.max(0, Math.round(durationMs)), this.lastLlmRunId);
		if (!this.lastUsageRun || this.lastUsageRun.id !== this.lastLlmRunId) return;
		this.lastUsageRun = {
			...this.lastUsageRun,
			sendMs: (this.lastUsageRun.sendMs ?? 0) + Math.max(0, Math.round(durationMs)),
			sendSamples: (this.lastUsageRun.sendSamples ?? 0) + 1,
		};
		this.usageSink?.(this.lastUsageRun);
	}

	private recordCompactionUsage(
		usage: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			reasoning?: number;
			cost: { total: number };
		},
		now: number,
		model: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
	): void {
		const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		const result = this.db
			.query(`
			INSERT INTO llm_runs (
				bot_id, ts, model, epoch, context_tokens, cache_read, cache_write, cache_miss,
				output_tokens, reasoning_tokens, latency_ms, cost, compaction,
				system_hash, tools_hash, provider, api, cache_retention
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, 'none')
		`)
			.run(
				this.bot.id,
				now,
				model.id,
				this.epoch,
				contextTokens,
				usage.cacheRead,
				usage.cacheWrite,
				usage.input,
				usage.output,
				usage.reasoning ?? 0,
				usage.cost.total,
				sha256Short(COMPACTION_SUMMARY_PROMPT),
				sha256Short("[]"),
				model.provider,
				model.api,
			);
		this.usageSink?.({
			id: Number(result.lastInsertRowid),
			botId: this.bot.id,
			ts: now,
			model: model.id,
			epoch: this.epoch,
			contextTokens,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cacheMiss: usage.input,
			outputTokens: usage.output,
			reasoningTokens: usage.reasoning ?? 0,
			latencyMs: null,
			cost: usage.cost.total,
			compaction: true,
		});
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.session?.abortCompaction();
		this.typingLease.stop();
		this.endAssistantStream();
		// Bounded wait for an in-flight flush so the Pi/SQLite context commit can settle;
		// the timeout only guards a wedged provider run.
		if (this.flushPromise) {
			await Promise.race([this.flushPromise.catch(() => {}), new Promise((r) => setTimeout(r, 30_000))]);
		}
		if (this.session) await this.session.dispose();
	}
}
