// BotRuntime: one persona bot = one Pi AgentSession + immutable event consumption + visible refs.
// See docs/architecture.md and docs/research.md.

import type { Database } from "bun:sqlite";
import { readFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
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
import { EFFECTIVE_CONTEXT_WINDOW, MIN_COMPACTION_RESERVE, type AppConfig, type BotConfig } from "../config.ts";
import { getBotState, setBotState } from "../db/db.ts";
import { BotApi, TelegramApiError } from "../telegram/api.ts";
import { TelegramTypingLease } from "../telegram/activity.ts";
import {
	classifyTelegramCreateFailure,
	localFailureCategory,
	persistSentMessageWithRetry,
	retrySqliteBusy,
	sendMarkdownTextAndPersist,
	SentMessagePersistenceError,
	type SentMessageTransport,
} from "../telegram/send.ts";
import { type MessageRow, TELEGRAM_SERIALIZER_VERSION } from "./serialize.ts";
import {
	buildSystemPrompt,
	sha256Short,
	CACHE_SCHEMA_VERSION,
	COMPACTION_SUMMARY_PROMPT,
	SHARED_PROTOCOL,
} from "./prompt.ts";
import {
	degradedSendResult,
	successfulSendResult,
	TOOL_DEFS,
	toolProtocolHash,
	type SendComponentOutcome,
	type SendDegradedOutcome,
	type SendParams,
	type SearchParams,
} from "./tools.ts";
import { runTinyFishTool } from "../tools/search.ts";
import { runJs } from "../tools/run-js.ts";
import {
	createPiVisionExecutor,
	ensureVision,
	fileIdForBot,
	type VisionExecutor,
	type VisionUpdateSink,
} from "../media/vision.ts";
import { isVisionMedia, type MediaDownloadApi } from "../media/local-cache.ts";
import {
	appendStickerCandidateSuffix,
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
	makeAssistantPersistencePolicyExtension,
	makeCachePayloadObserverExtension,
	makeTelegramCompactionExtension,
	makeTelegramContextExtension,
	serializeCompactionMessages,
	TELEGRAM_CONTEXT_TYPE,
	TELEGRAM_CONTEXT_VERSION,
	TELEGRAM_EXTENSION_ORDER,
	isTelegramContextDetails,
	type ProviderPayloadObservation,
	type TelegramContextDetails,
} from "./extensions/index.ts";
import { buildContextFingerprint, canResumeContextSession, sha256 } from "./context-fingerprint.ts";
import { parsePiModelReference, type PiRequestThinkingLevel } from "./model-ref.ts";
import type { VisionScheduler } from "../media/vision-scheduler.ts";
import type { VideoTranscoderAvailability } from "../media/video-frames.ts";
import { log } from "../observability/log.ts";
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

interface SendFailure {
	failed_component: "message" | "sticker";
	failed_outcome: SendComponentOutcome;
	stage: "telegram_create" | "canonical_persist" | "local_effect";
	category: string;
}

function rawTelegramMessageId(raw: Record<string, unknown>): number | null {
	const id = raw.message_id;
	return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

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
	private pendingInputMetrics = { inputEvents: 0, estimatedTokens: 0, rowsScanned: 0, visionCalls: 0 };
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
		const model = { ...catalogModel, contextWindow: Math.min(catalogModel.contextWindow, EFFECTIVE_CONTEXT_WINDOW) };
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
			makeTelegramContextExtension(),
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
			}),
			resourceLoader: loader,
			noTools: "builtin",
			customTools: activeTools,
		});
		this.session = session;
		const streamFunction = session.agent.streamFunction;
		session.agent.streamFunction = (requestModel, context, options) =>
			streamFunction(requestModel, context, { ...options, cacheRetention: this.bot.cacheRetention });
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
		const state = this.contextStateFromEntries(
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
	private contextStateFromEntries(
		entries: readonly SessionEntry[],
		initialConsumedSeq = 0,
	): { consumedSeq: number; visible: Set<number> } {
		let consumedSeq = initialConsumedSeq;
		const visible = new Set<number>();
		for (const entry of entries) {
			if (entry.type === "custom_message" && isTelegramContextDetails(entry.details)) {
				consumedSeq = Math.max(consumedSeq, entry.details.consumedSeq);
				for (const messageId of entry.details.visibleMessageIds) visible.add(messageId);
				continue;
			}
			if (entry.type === "compaction") {
				// Compaction is a replacement boundary. Entries summarized away may remain in the
				// session tree, but their message ids are no longer provider-visible.
				visible.clear();
				const details = entry.details as
					| {
							consumedSeq?: unknown;
							visibleMessageIds?: unknown;
					  }
					| undefined;
				if (Number.isSafeInteger(details?.consumedSeq))
					consumedSeq = Math.max(consumedSeq, details!.consumedSeq as number);
				if (Array.isArray(details?.visibleMessageIds)) {
					for (const messageId of details.visibleMessageIds) {
						if (Number.isSafeInteger(messageId) && (messageId as number) > 0) visible.add(messageId as number);
					}
				}
				continue;
			}
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "send") {
				const sent = (entry.message.details as { sent?: unknown } | undefined)?.sent;
				if (Array.isArray(sent)) {
					for (const messageId of sent) {
						if (Number.isSafeInteger(messageId) && (messageId as number) > 0) visible.add(messageId as number);
					}
				}
			}
		}
		return { consumedSeq, visible };
	}

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
		const prep = event.preparation;
		const gen = await this.generateCompactionSummary(prep);
		if (!("summary" in gen)) {
			// NOTE: the SDK swallows extension handler exceptions and would silently fall back
			// to the default summarizer, so refusal goes through cancel -> compaction_end { aborted: true }.
			this.recordEvent("error", { stage: "compaction", error: gen.failure });
			return { cancel: true };
		}
		const branchEntries = event.branchEntries ?? [];
		const keptIndex = branchEntries.findIndex((entry) => entry.id === prep.firstKeptEntryId);
		const keptEntries = keptIndex >= 0 ? branchEntries.slice(keptIndex) : [];
		const chatId = Number(`-100${this.config.groupPeerId}`);
		const state = this.contextStateFromEntries(keptEntries, getConsumedSeq(this.db, this.bot.id, chatId));
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
	}

	/**
	 * Chat-oriented compaction summary via the aux model; on provider error retries once with the
	 * main model so an unavailable compaction model cannot wedge an overflowed session forever.
	 * Failure names provider error/abort apart from empty text.
	 */
	private async generateCompactionSummary(
		prep: SessionBeforeCompactEvent["preparation"],
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
		const options = { cacheRetention: "none" as const, maxTokens: 4096, reasoning: this.compactionReasoning };
		let model = this.compactionModel;
		let result = await this.modelRuntime.completeSimple(model, request, options);
		if (result.stopReason === "error") {
			// aborted is intentional (shutdown/abort signal), never retried.
			log.warn("agent_runtime", "compaction_fallback", {
				bot_id: this.bot.id,
				category: classifyPiProviderFailure(result.errorMessage ?? "compaction model failed"),
			});
			model = this.model;
			result = await this.modelRuntime.completeSimple(model, request, options);
		}
		this.recordCompactionUsage(result.usage, Date.now(), model);
		if (result.stopReason === "error" || result.stopReason === "aborted") {
			return { failure: `summary generation ${result.stopReason}` };
		}
		const summary = contentText(result.content);
		if (!summary.trim()) return { failure: "empty summary" };
		return { summary, usage: result.usage };
	}

	private async executeSend(params: SendParams) {
		const startedAt = Date.now();
		try {
			return await this.executeSendAttempt(params);
		} finally {
			this.recordSendDuration(Date.now() - startedAt);
		}
	}

	private async executeSendAttempt(params: SendParams) {
		if (!params.message && !params.sticker) {
			log.warn("agent_send", "preflight_failed", {
				bot_id: this.bot.id,
				category: "empty_payload",
				trigger_message_id: this.currentTriggerMessageId,
			});
			throw new Error("send requires at least one of message or sticker");
		}
		if (params.reply_to != null && !this.visibleMessageIds.has(params.reply_to)) {
			log.warn("agent_send", "preflight_failed", {
				bot_id: this.bot.id,
				category: "reply_not_visible",
				reply_to: params.reply_to,
				visible_count: this.visibleMessageIds.size,
				trigger_message_id: this.currentTriggerMessageId,
			});
			throw new Error("messaging.reply_not_visible");
		}
		log.info("agent_send", "started", {
			bot_id: this.bot.id,
			has_message: Boolean(params.message),
			has_sticker: Boolean(params.sticker),
			has_reply: params.reply_to != null,
			trigger_message_id: this.currentTriggerMessageId,
		});
		// Validate everything (incl. sticker resolution) before any network send (R7):
		// a late sticker failure would make the model retry and double-send the text.
		let stickerFileId: string | null = null;
		if (params.sticker) {
			const row = this.db.query("SELECT file_unique_id FROM media WHERE short_id = ?").get(params.sticker) as {
				file_unique_id: string;
			} | null;
			if (!row)
				throw new Error(
					`unknown sticker id: ${params.sticker} (use a short_id from the Sticker 目录 or latest recent-context candidates)`,
				);
			stickerFileId = fileIdForBot(this.db, this.bot.id, row.file_unique_id);
			if (!stickerFileId) {
				this.recordEvent("error", { stage: "send", code: "candidate_invariant", sticker: params.sticker });
				throw new Error(
					`candidate invariant violated: sticker ${params.sticker} is not sendable by this bot (no file_id)`,
				);
			}
		}
		const chatId = Number(`-100${this.config.groupPeerId}`);
		const sentIds: number[] = [];
		const failures: SendFailure[] = [];
		let remoteCommits = 0;
		let sendEventAttempted = false;
		let typingStopAttempted = false;

		const addFailure = (failure: SendFailure): void => {
			// One tool call has at most two remote components and a small fixed set of local effects.
			if (failures.length < 8) failures.push(failure);
		};
		const runLocalEffect = async (
			component: "message" | "sticker",
			category: string,
			effect: () => void,
			retryBusy: boolean,
		): Promise<void> => {
			try {
				if (retryBusy) await retrySqliteBusy(effect);
				else effect();
			} catch (error) {
				const localCategory = localFailureCategory(error);
				addFailure({
					failed_component: component,
					failed_outcome: "committed",
					stage: "local_effect",
					category: localCategory === "local_failure" ? category : localCategory,
				});
			}
		};
		const finishCommittedComponent = async (
			component: "message" | "sticker",
			raw: Record<string, unknown>,
			messageId: number | null,
			transport?: SentMessageTransport,
		): Promise<void> => {
			remoteCommits++;
			await runLocalEffect(component, "telemetry_failed", () => this.recordPublicSend(), true);
			if (messageId != null && !sentIds.includes(messageId)) sentIds.push(messageId);
			if (messageId != null) {
				await runLocalEffect(component, "visibility_failed", () => this.markVisible([messageId]), true);
			}
			await runLocalEffect(component, "broadcast_failed", () => this.sentMessageSink?.(raw), false);
			if (component === "message" && messageId != null && transport) {
				await runLocalEffect(
					component,
					"event_failed",
					() =>
						this.recordEvent(transport === "formatted" ? "markdown_sent" : "plain_fallback", { message_id: messageId }),
					true,
				);
			}
		};
		const finishDegraded = async (outcome: SendDegradedOutcome) => {
			const component = failures[0]?.failed_component ?? (params.sticker && !params.message ? "sticker" : "message");
			if (sentIds.length > 0 && !sendEventAttempted) {
				sendEventAttempted = true;
				await runLocalEffect(
					component,
					"event_failed",
					() =>
						this.recordEvent("send", {
							reply_to: params.reply_to ?? null,
							sticker: params.sticker ?? null,
							sent: sentIds,
						}),
					true,
				);
			}
			if (!typingStopAttempted) {
				typingStopAttempted = true;
				await runLocalEffect(component, "typing_stop_failed", () => this.typingLease.stop(), false);
			}
			const primary = (outcome === "partial"
				? failures.find((failure) => failure.stage === "telegram_create")
				: null) ??
				failures[0] ?? {
					failed_component: component,
					failed_outcome: "unknown" as const,
					stage: "local_effect" as const,
					category: "local_failure",
				};
			const diagnostic = {
				outcome,
				sent: [...sentIds],
				failures: failures.length > 0 ? failures : [primary],
			};
			try {
				await retrySqliteBusy(() => this.recordEvent("send_degraded", diagnostic));
			} catch {
				// The bounded, redacted process log remains available when SQLite/event sinks are unavailable.
			}
			log.warn("agent_send", "degraded", {
				bot_id: this.bot.id,
				outcome,
				component: primary.failed_component,
				stage: primary.stage,
				category: primary.category,
				sent_count: sentIds.length,
				trigger_message_id: this.currentTriggerMessageId,
			});
			return degradedSendResult({ sent: [...sentIds], outcome, ...primary });
		};
		const handleCreateFailure = async (
			component: "message" | "sticker",
			error: unknown,
		): Promise<ReturnType<typeof degradedSendResult>> => {
			const failure = classifyTelegramCreateFailure(error);
			if (failure.outcome === "rejected" && remoteCommits === 0) {
				try {
					this.typingLease.stop();
				} catch {
					// Preserve the actionable pre-commit Telegram rejection.
				}
				throw error;
			}
			addFailure({
				failed_component: component,
				failed_outcome: failure.outcome,
				stage: "telegram_create",
				category: failure.category,
			});
			return await finishDegraded(remoteCommits > 0 ? "partial" : "unknown");
		};

		if (params.message) {
			try {
				const { raw, canonical, transport } = await sendMarkdownTextAndPersist(
					this.db,
					this.api,
					this.bot.id,
					chatId,
					params.message,
					params.reply_to,
				);
				await finishCommittedComponent("message", raw, canonical.message_id, transport);
			} catch (error) {
				if (!(error instanceof SentMessagePersistenceError)) return await handleCreateFailure("message", error);
				addFailure({
					failed_component: "message",
					failed_outcome: "committed",
					stage: "canonical_persist",
					category: localFailureCategory(error.cause),
				});
				await finishCommittedComponent("message", error.raw, rawTelegramMessageId(error.raw), error.transport);
			}
		}
		if (stickerFileId) {
			try {
				const raw = await this.api.sendSticker(chatId, stickerFileId, params.reply_to);
				try {
					const canonical = await persistSentMessageWithRetry(this.db, this.bot.id, raw, "sticker");
					await finishCommittedComponent("sticker", raw, canonical.message_id);
				} catch (error) {
					if (!(error instanceof SentMessagePersistenceError)) throw error;
					addFailure({
						failed_component: "sticker",
						failed_outcome: "committed",
						stage: "canonical_persist",
						category: localFailureCategory(error.cause),
					});
					await finishCommittedComponent("sticker", error.raw, rawTelegramMessageId(error.raw));
				}
			} catch (error) {
				return await handleCreateFailure("sticker", error);
			}
		}
		sendEventAttempted = true;
		typingStopAttempted = true;
		await runLocalEffect(
			params.sticker && !params.message ? "sticker" : "message",
			"event_failed",
			() =>
				this.recordEvent("send", { reply_to: params.reply_to ?? null, sticker: params.sticker ?? null, sent: sentIds }),
			true,
		);
		await runLocalEffect(
			params.sticker && !params.message ? "sticker" : "message",
			"typing_stop_failed",
			() => this.typingLease.stop(),
			false,
		);
		if (failures.length > 0) return await finishDegraded("committed");
		log.info("agent_send", "committed", {
			bot_id: this.bot.id,
			sent_count: sentIds.length,
			trigger_message_id: this.currentTriggerMessageId,
		});
		return successfulSendResult(sentIds);
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
		const isDirectReply = routingTrigger?.reason === "reply";
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
			// re-entrant trigger while a flush is in flight (e.g. slow vision await):
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

		this.pendingInputMetrics = { inputEvents: 0, estimatedTokens: 0, rowsScanned: 0, visionCalls: 0 };
		await this.ensureBatchVision([...mandatory, ...normal], obligationIds);
		const postVisionHighWater = messageEventHighWater(this.db, chatId);
		if (postVisionHighWater > highWater) {
			highWater = postVisionHighWater;
			recent = listRecentMessageEvents(this.db, chatId, consumedSeq, highWater, MAX_EVENT_SCAN);
			obligationEvents = listReplyObligationEvents(this.db, this.bot.id, chatId, MAX_OBLIGATION_SCAN);
			rowsScanned += recent.length + obligationEvents.length;
			mandatory = requiredEvents();
			normal = ordinaryEvents();
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
		const providerText = appendStickerCandidateSuffix(packed.text, boundedStickerCandidates);

		const selectedIds = new Set(packed.visibleMessageIds);
		const delivered = obligations.filter((obligation) => selectedIds.has(obligation.messageId));
		const details: TelegramContextDetails = {
			version: TELEGRAM_CONTEXT_VERSION,
			consumedSeq: highWater,
			providerText: packed.text,
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
			estimatedTokens: estimateProviderTokensUpperBound(providerText),
			rowsScanned,
			visionCalls: this.pendingInputMetrics.visionCalls,
		};
		// sendCustomMessage(triggerTurn) does not resolve until the provider turn, including
		// tool execution, has finished. Make only the fully packed references addressable
		// during that turn; durable visibility still commits after the session submission.
		for (const messageId of packed.visibleMessageIds) this.visibleMessageIds.add(messageId);
		try {
			await this.session.sendCustomMessage(
				{ customType: TELEGRAM_CONTEXT_TYPE, content: providerText, display: false, details },
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
					public_send_count, vision_calls, tool_followup_rounds, input_events,
					input_tokens_estimated, rows_scanned, system_tokens, tools_tokens,
					compacted_history_tokens, message_tokens, thinking_ms
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
		this.pendingInputMetrics = { inputEvents: 0, estimatedTokens: 0, rowsScanned: 0, visionCalls: 0 };
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
