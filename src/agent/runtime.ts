// BotRuntime: one persona bot = one Pi AgentSession + immutable event consumption + visible refs.
// See docs/architecture.md and docs/research.md.

import type { Database } from "bun:sqlite";
import { readFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, contentText, retryAssistantCall, type Api, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	resizeImage,
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
import { BotApi, groupReactionAllowlist, TelegramApiError } from "../telegram/api.ts";
import { TelegramTypingLease } from "../telegram/activity.ts";
import { executeAgentSend } from "./send.ts";
import { type MessageRow, TELEGRAM_SERIALIZER_VERSION } from "./serialize.ts";
import {
	buildSystemPrompt,
	sha256Short,
	CACHE_SCHEMA_VERSION,
	COMPACTION_SUMMARY_PROMPT,
	TELEGRAM_TURN_PROMPT,
	REPLY_RECOVERY_PROMPT,
	SHARED_PROTOCOL,
} from "./prompt.ts";
import { TOOL_DEFS, toolProtocolHash, type SendParams, type SearchParams } from "./tools.ts";
import { runTinyFishTool } from "../tools/search.ts";
import { runJs } from "../tools/run-js.ts";
import { contextMediaRefs, createContextImageResolver, ensureContextMedia } from "../media/context-media.ts";
import { isVisionMedia, type MediaDownloadApi } from "../media/local-cache.ts";
import { ensureVision, type VisionExecutor, type VisionUpdateSink } from "../media/vision.ts";
import type { VisionScheduler } from "../media/vision-scheduler.ts";
import {
	ensureStickerCatalog,
	batchStickerCandidates,
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
import type { AgentStreamFrame, RuntimeControlSnapshot } from "../ipc.ts";
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
import {
	availableSuffixBudget,
	CONTEXT_IMAGE_TOKEN_ESTIMATE,
	DEFAULT_REASONING_RESERVE,
	DEFAULT_TOOL_FOLLOWUP_RESERVE,
	estimateProviderTokensUpperBound,
	packMessageEvents,
} from "./token-packer.ts";
import {
	estimateCacheReadFromPrefix,
	buildTelegramContextBlocks,
	compactionTextBudget,
	buildCompactionContent,
	isTelegramContextDetails,
	makeAssistantPersistencePolicyExtension,
	makeCachePayloadObserverExtension,
	makeTelegramCompactionExtension,
	makeTelegramContextExtension,
	TELEGRAM_CONTEXT_VERSION,
	TELEGRAM_EXTENSION_ORDER,
	contextImageBytes,
	type PreviousProviderPayloadFingerprint,
	type ProviderPayloadObservation,
	type TelegramContextDetails,
} from "./extensions/index.ts";
import {
	buildContextFingerprint,
	canResumeContextSession,
	sha256,
	type ContextFingerprintInput,
} from "./context-fingerprint.ts";
import { contextStateFromEntries } from "./context-state.ts";
import { trimSessionBeforeCompaction } from "./session-trim.ts";
import { parsePiModelReference, type PiRequestThinkingLevel } from "./model-ref.ts";
import type { VideoTranscoderAvailability } from "../media/video-frames.ts";
import { errorCategory, log } from "../observability/log.ts";
import { fitContextBreakdown } from "../observability/usage.ts";
import { AgentActivityCollector } from "./activity.ts";

export type ModelControlSelection = Pick<BotConfig, "provider" | "model" | "reasoningEffort">;
export type ModelControlResult =
	| { ok: true; epoch: number; reasoningEffort: BotConfig["reasoningEffort"] }
	| {
			ok: false;
			code:
				| "busy"
				| "stopping"
				| "unavailable"
				| "unknown_model"
				| "unauthenticated_provider"
				| "image_input_unsupported"
				| "config_write_failed"
				| "failed";
	  };

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

export type NewSessionResult =
	| { ok: true; epoch: number }
	| { ok: false; code: "busy" | "stopping" | "unavailable" | "failed" };

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

/** Insert one row from column names; returns its rowid. */
function insertRow(db: Database, table: string, row: Record<string, string | number | null>): number {
	const columns = Object.keys(row);
	return Number(
		db
			.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
			.run(...Object.values(row)).lastInsertRowid,
	);
}

function emptyInputMetrics() {
	return { inputEvents: 0, estimatedTokens: 0, rowsScanned: 0, visionCalls: 0, imagesAttached: 0 };
}

/** Distinct preparable media identities in a batch, direct-reply events first, newest first. */
function pendingMediaIds(
	batch: readonly MessageEvent[],
	obligationIds: ReadonlySet<number>,
	limit: number,
	prepared: (fileUniqueId: string) => boolean,
	/** Vision mode also describes media carried by edit/metadata revisions. */
	includeRevisions = false,
): string[] {
	const pending: string[] = [];
	const seen = new Set<string>();
	const prioritized = [...batch].sort(
		(left, right) =>
			Number(obligationIds.has(right.messageId)) - Number(obligationIds.has(left.messageId)) ||
			right.ingestSeq - left.ingestSeq,
	);
	for (const event of prioritized) {
		if (pending.length >= limit) break;
		if (event.kind === "media_update" || (!includeRevisions && event.kind !== "message")) continue;
		const row = event.payload as MessageRow;
		if (!row.media) continue;
		const media = JSON.parse(row.media) as { kind: string; mime?: string; file_unique_id?: string };
		if (!media.file_unique_id || !isVisionMedia(media.kind, media.mime) || seen.has(media.file_unique_id)) continue;
		seen.add(media.file_unique_id);
		if (!prepared(media.file_unique_id)) pending.push(media.file_unique_id);
	}
	return pending;
}

/** Run `work` over `items` with at most `concurrency` in flight. */
async function forEachConcurrent<T>(items: readonly T[], concurrency: number, work: (item: T) => Promise<void>) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (next < items.length) await work(items[next++]!);
		}),
	);
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
	private pendingTriggerMessageId: number | null = null;
	private stopping = false;
	private flushPromise: Promise<void> | null = null;
	private cooldownUntil = 0;
	private cooldownAfterFlush = false;
	private controlCompacting = false;
	private controlChangingModel = false;
	private contextFingerprintInput!: ContextFingerprintInput;
	private createModelSession!: (
		model: Model<Api>,
		thinking: BotConfig["reasoningEffort"],
		manager: SessionManager,
	) => Promise<AgentSession>;
	/** Last assistant message ended in error/abort; auto-compaction waits for a healthy turn. */
	private lastTurnFailed = false;
	/** Set by the irreversible send boundary, not by provider health or usage telemetry. */
	private turnSendOutcome: "none" | "sent" | "unknown" = "none";
	private lastControlCompact: RuntimeControlSnapshot["lastCompact"] = null;
	private readonly monotonicNow = () => performance.now();
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
	private pendingPayloadObservation: ProviderPayloadObservation | null = null;
	private allowedReactions: ReadonlySet<string> | null = null;
	private previousRequest: (PreviousProviderPayloadFingerprint & { cohort: string }) | null = null;
	private pendingTurnContext: TelegramContextDetails | null = null;
	private currentTriggerMessageId: number | null = null;
	private pendingInputMetrics = emptyInputMetrics();
	private providerCallsInRun = 0;
	private lastLlmRunId: number | null = null;
	private thinkingStartedAt = 0;
	private thinkingMs = 0;
	private thinkingFinished = false;
	private readonly visionScheduler: VisionScheduler | null;
	private readonly typingLease: TelegramTypingLease;
	private readonly videoTranscoder: VideoTranscoderAvailability;
	/** Optional sink for TUI/live broadcasting of agent events. */
	eventSink: ((event: { id: number; ts: number; kind: string; payload: unknown }) => void) | null = null;
	/** Optional sink for messages this bot sent (poller echo dedupes them, so TUI needs this path). */
	sentMessageSink: ((rawMsg: unknown) => void) | null = null;
	/** Notified after each persisted llm_runs change so live views reload this bot's stats. */
	usageSink: (() => void) | null = null;
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
			/** Startup probe result; both media modes sample video frames through it. */
			videoTranscoder: VideoTranscoderAvailability;
			chatActionSender?: (signal: AbortSignal) => Promise<unknown>;
			api?: BotApi;
			botApis?: ReadonlyMap<string, MediaDownloadApi>;
			visionExecutor?: VisionExecutor;
			visionScheduler?: VisionScheduler;
		},
	) {
		this.db = db;
		this.bot = bot;
		this.config = config;
		this.modelRuntime = modelRuntime;
		this.visionExecutor = options.visionExecutor ?? null;
		this.visionScheduler = options.visionScheduler ?? null;
		this.videoTranscoder = options.videoTranscoder;
		this.api = options.api ?? new BotApi(bot.token);
		this.botApis = options.botApis ?? new Map([[bot.id, this.api]]);
		const chatId = config.groupChatId;
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
		const chatId = this.config.groupChatId;
		try {
			this.allowedReactions = groupReactionAllowlist(await this.api.getChat(chatId));
		} catch {
			// Unknown restrictions degrade to the standard set; Telegram still rejects the rest.
			log.warn("agent_runtime", "reaction_allowlist_unavailable", { bot_id: this.bot.id, category: "request_failed" });
		}
		// Catalog identity + format is pinned into the stable system prefix below.
		if (this.bot.stickerSets.length > 0) {
			await ensureStickerCatalog(this.db, this.api, this.bot.id, this.bot.stickerSets);
		}
		const stickerCatalog =
			this.bot.stickerSets.length > 0 ? stickerCatalogPromptBlock(this.db, this.bot.id, this.bot.stickerSets) : "";
		const systemPrompt = buildSystemPrompt(persona, this.bot.tools, stickerCatalog);
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
		this.contextFingerprintInput = {
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
		};
		this.contextFingerprint = buildContextFingerprint(this.contextFingerprintInput);

		const sessionsDir = join(this.config.dataDir, "sessions", this.bot.id);
		mkdirSync(sessionsDir, { recursive: true });
		const manifest = getSessionManifest(this.db, this.bot.id);
		const hasAnySession = readdirSync(sessionsDir).some((file) => file.endsWith(".jsonl"));
		const canResume = canResumeContextSession(
			manifest,
			this.contextFingerprint,
			manifest != null && existsSync(manifest.sessionFile),
		);
		if (canResume) {
			try {
				if (trimSessionBeforeCompaction(manifest!.sessionFile, sessionsDir, this.config.dataDir))
					log.info("agent_runtime", "session_trimmed", { bot_id: this.bot.id });
			} catch (error) {
				log.warn("agent_runtime", "session_trim_failed", { bot_id: this.bot.id, category: errorCategory(error) });
			}
		}
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
				() => this.pendingTurnContext,
				this.config.media.mode === "context"
					? createContextImageResolver(join(this.config.dataDir, "media"))
					: undefined,
			),
			makeTelegramCompactionExtension((event) => this.handleBeforeCompact(event)),
			makeCachePayloadObserverExtension(payloadKey, (observation) => {
				this.pendingPayloadObservation = observation;
			}),
			makeAssistantPersistencePolicyExtension(
				(text) => {
					this.recordEvent("assistant_text", { text });
				},
				(message) => this.captureAssistantActivity(message),
			),
		];
		this.createModelSession = async (selectedModel, thinking, manager) => {
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
				model: selectedModel,
				thinkingLevel: thinking,
				modelRuntime: this.modelRuntime,
				sessionManager: manager,
				settingsManager: SettingsManager.inMemory({
					cacheWarming: "off",
					compaction: {
						enabled: true,
						reserveTokens: Math.max(MIN_COMPACTION_RESERVE, selectedModel.contextWindow - this.bot.compactionThreshold),
						keepRecentTokens: this.bot.compactionKeepRecent,
					},
					retry: { ...providerRetryPolicy(this.bot.providerRetries), provider: { maxRetries: 0 } },
				}),
				resourceLoader: loader,
				noTools: "builtin",
				customTools: activeTools,
			});
			const streamFunction = session.agent.streamFunction;
			session.agent.streamFunction = (requestModel, context, options) => {
				this.pendingPayloadObservation = null;
				return guardProviderCall(
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
			};
			return session;
		};
		const session = await this.createModelSession(model, this.bot.reasoningEffort, sessionManager);
		this.session = session;
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
		const chatId = this.config.groupChatId;
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
					this.lastTurnFailed = false;
					this.providerCallsInRun = 0;
					this.lastLlmRunId = null;
					this.thinkingStartedAt = 0;
					this.thinkingMs = 0;
					this.thinkingFinished = false;
					this.pendingPayloadObservation = null;
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
						this.lastTurnFailed = msg.stopReason === "error" || msg.stopReason === "aborted";
						if (this.lastTurnFailed)
							log.warn("agent_runtime", "provider_attempt_failed", {
								bot_id: this.bot.id,
								trigger_message_id: this.currentTriggerMessageId,
								category: classifyPiProviderFailure(msg.errorMessage ?? "provider failed"),
							});
						this.observeThinking(msg, now, true);
						const thinking = msg.content
							.filter((c) => c.type === "thinking")
							.map((c) => (c as { thinking: string }).thinking)
							.join("\n");
						if (thinking.trim()) this.recordEvent("thinking", { text: thinking });
						// Failed attempts carry zero usage; recording them would create empty llm_runs
						// rows, consume this turn's input metrics, and mark the eventual success as a
						// tool follow-up round.
						if (msg.usage && !this.lastTurnFailed) this.recordUsage(msg.usage, now);
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
				case "tool_execution_start":
					this.recordEvent("tool_call", { tool: event.toolName, args: event.args });
					log.info("agent_tool", "execution_started", {
						bot_id: this.bot.id,
						tool: event.toolName,
						trigger_message_id: this.currentTriggerMessageId,
					});
					break;
				case "tool_execution_end":
					try {
						this.recordEvent("tool_result", { tool: event.toolName, isError: event.isError });
					} catch {
						// A committed send must stay terminal even when its local record fails.
						log.warn("agent_tool", "result_persist_failed", {
							bot_id: this.bot.id,
							tool: event.toolName,
							category: "local_failure",
						});
					}
					log.info("agent_tool", "execution_finished", {
						bot_id: this.bot.id,
						tool: event.toolName,
						is_error: event.isError,
						trigger_message_id: this.currentTriggerMessageId,
					});
					break;
				case "agent_end":
					// All messages are persisted now; Pi's native compaction preparation runs next.
					this.refreshCompactionBudget();
					break;
				case "agent_settled":
					this.session?.settingsManager.applyOverrides({
						compaction: { keepRecentTokens: this.bot.compactionKeepRecent },
					});
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
		if (event.aborted && this.skipFailedThresholdCompaction(event.reason)) {
			log.info("agent_runtime", "auto_compact_skipped", {
				bot_id: this.bot.id,
				reason: event.reason,
				last_turn_failed: true,
			});
			return;
		}
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
		const chatId = this.config.groupChatId;
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

	/** Pi also checks thresholds before a new prompt, so inspect the persisted last response. */
	private skipFailedThresholdCompaction(reason: SessionBeforeCompactEvent["reason"]): boolean {
		if (reason !== "threshold") return false;
		const last = this.session?.messages.findLast((message) => message.role === "assistant");
		return last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted");
	}

	/** session_before_compact handler: empty summary is refused via cancel, never persisted. */
	private async handleBeforeCompact(
		event: SessionBeforeCompactEvent,
	): Promise<{ cancel: true } | { compaction: CompactionResult }> {
		// Preserve Pi's overflow recovery and explicit compaction; other failed turns must
		// not multiply an outage into repeated chat + summary provider attempts.
		if (this.skipFailedThresholdCompaction(event.reason)) return { cancel: true };
		try {
			const branchEntries = event.branchEntries;
			const prep = event.preparation;
			const gen = await this.generateCompactionSummary(prep, event.signal);
			if (!("summary" in gen)) {
				// NOTE: the SDK swallows extension handler exceptions and would silently fall back
				// to the default summarizer, so refusal goes through cancel -> compaction_end { aborted: true }.
				this.recordEvent("error", { stage: "compaction", error: gen.failure });
				return { cancel: true };
			}
			const keptIndex = branchEntries.findIndex((entry) => entry.id === prep.firstKeptEntryId);
			const keptEntries = keptIndex >= 0 ? branchEntries.slice(keptIndex) : [];
			const chatId = this.config.groupChatId;
			const state = contextStateFromEntries(keptEntries, getConsumedSeq(this.db, this.bot.id, chatId));
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
		const model = this.compactionModel;
		const messages = [...prep.messagesToSummarize, ...prep.turnPrefixMessages];
		const imageReferences = messages.reduce(
			(count, message) =>
				count +
				(message.role === "custom" && isTelegramContextDetails(message.details)
					? message.details.blocks.filter((block) => block.type === "image").length
					: 0),
			0,
		);
		const content = buildCompactionContent(
			messages,
			prep.previousSummary,
			model.input.includes("image") ? createContextImageResolver(join(this.config.dataDir, "media")) : undefined,
		);
		const imagesAttached = typeof content === "string" ? 0 : content.filter((block) => block.type === "image").length;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("");
		const inputTokens =
			estimateProviderTokensUpperBound(COMPACTION_SUMMARY_PROMPT + text) +
			imagesAttached * CONTEXT_IMAGE_TOKEN_ESTIMATE;
		const maxTokens = Math.min(4096, model.maxTokens);
		log.info("agent_runtime", "compaction_input", {
			bot_id: this.bot.id,
			vision_supported: model.input.includes("image"),
			images_attached: imagesAttached,
			images_unavailable: imageReferences - imagesAttached,
			input_tokens_estimated: inputTokens,
		});
		if (inputTokens + maxTokens + 2048 > model.contextWindow) {
			log.warn("agent_runtime", "compaction_input_rejected", {
				bot_id: this.bot.id,
				category: "model_window_exceeded",
			});
			return { failure: "summary input exceeds model window" };
		}
		// Recovery must not send the same oversized image payload to the summary model.
		// Resize only this uncached summary request; stored files and chat prefixes stay intact.
		if (Array.isArray(content)) {
			const images = content.filter((block) => block.type === "image");
			const imageBytes = images.reduce((sum, image) => sum + Buffer.from(image.data, "base64").length, 0);
			if (imageBytes > this.bot.contextImageBudgetBytes) {
				const maxBytes = Math.floor(this.bot.contextImageBudgetBytes / images.length);
				const resized = new Map<string, Awaited<ReturnType<typeof resizeImage>>>();
				for (const image of images) {
					signal.throwIfAborted();
					const bytes = Buffer.from(image.data, "base64");
					if (bytes.length <= maxBytes) continue;
					const key = `${image.mimeType}:${image.data}`;
					if (!resized.has(key))
						resized.set(
							key,
							maxBytes > 0
								? await resizeImage(bytes, image.mimeType, { maxBytes: Math.floor(maxBytes / 3) * 4 })
								: null,
						);
					const result = resized.get(key);
					if (!result || Buffer.from(result.data, "base64").length > maxBytes) {
						log.warn("agent_runtime", "compaction_input_rejected", {
							bot_id: this.bot.id,
							category: "image_budget_exceeded",
						});
						return { failure: "summary images exceed transport budget" };
					}
					image.data = result.data;
					image.mimeType = result.mimeType;
				}
			}
		}
		const request = {
			systemPrompt: COMPACTION_SUMMARY_PROMPT,
			messages: [{ role: "user" as const, content, timestamp: Date.now() }],
		};
		const result = await retryAssistantCall(
			async () => {
				const response = await guardProviderCall(
					(attemptSignal) =>
						this.modelRuntime.streamSimple(model, request, {
							cacheRetention: "none",
							maxTokens,
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

	private async executeSend(params: SendParams) {
		const result = await executeAgentSend(params, {
			db: this.db,
			api: this.api,
			botId: this.bot.id,
			chatId: this.config.groupChatId,
			emitMediaUpdates: this.config.media.mode === "vision",
			visibleMessageIds: this.visibleMessageIds,
			allowedReactions: this.allowedReactions,
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
		// Both successful sends and degraded terminal outcomes forbid an automatic resend.
		// A reaction-only turn created no message, so a direct address is still owed a reply.
		if ("outcome" in result.details) {
			this.turnSendOutcome = result.details.outcome === "unknown" ? "unknown" : "sent";
		} else if (result.details.sent.length > 0) {
			this.turnSendOutcome = "sent";
		}
		return result;
	}

	/** Lifecycle state used by deterministic scheduling and the Telegram control plane. */
	samplingState(now = this.monotonicNow()): "idle" | "busy" | "cooldown" | "stopping" {
		if (this.stopping) return "stopping";
		if (this.flushing || this.controlCompacting || this.controlChangingModel) return "busy";
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
		if (isDirectReply && this.bot.tools.send && !this.visibleMessageIds.has(routingTrigger.messageId)) {
			const created = createReplyObligation(this.db, this.bot.id, routingTrigger.chatId, routingTrigger.messageId);
			directReplyPending = true;
			directReplyMessageId = routingTrigger.messageId;
			if (created) this.recordEvent("reply_obligation_created", { message_id: routingTrigger.messageId });
		}
		const state = this.samplingState();
		if (state === "stopping") return "skipped_stopping";
		if (source === "probability" && state !== "idle") {
			return state === "busy" ? "skipped_busy" : "skipped_cooldown";
		}
		if (this.controlCompacting || this.controlChangingModel) {
			this.pendingTrigger = true;
			this.pendingTriggerMessageId = routingTrigger?.messageId ?? this.pendingTriggerMessageId;
			return "coalesced";
		}
		if (this.flushing) {
			// re-entrant trigger while a flush is in flight (e.g. slow media download):
			// coalesce into pendingTrigger; the loop picks it up (burst merge, R1)
			this.pendingTrigger = true;
			this.pendingTriggerMessageId = routingTrigger?.messageId ?? this.pendingTriggerMessageId;
			if (directReplyPending && directReplyMessageId != null) {
				this.recordEvent("reply_obligation_coalesced", { message_id: directReplyMessageId });
			}
			return "coalesced";
		}
		if (source === "probability") this.cooldownAfterFlush = true;
		this.currentTriggerMessageId = routingTrigger?.messageId ?? this.pendingTriggerMessageId;
		this.pendingTriggerMessageId = null;
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
				// Flush failures are local (SQLite/session) — provider errors never reject the turn.
				const category = errorCategory(err);
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
				this.rearmPendingTrigger();
			});
		return "started";
	}

	private async flushLoop(): Promise<void> {
		try {
			let moreReplies = false;
			do {
				if (this.pendingTriggerMessageId != null) this.currentTriggerMessageId = this.pendingTriggerMessageId;
				this.pendingTriggerMessageId = null;
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
		this.turnSendOutcome = "none";
		this.lastTurnFailed = false;
		const chatId = this.config.groupChatId;
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

		this.pendingInputMetrics = emptyInputMetrics();
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
			reasoningReserve: this.bot.reasoningEffort === "off" ? 0 : DEFAULT_REASONING_RESERVE,
			toolFollowupReserve: this.bot.tools.search || this.bot.tools.runJs ? DEFAULT_TOOL_FOLLOWUP_RESERVE : 2048,
		});
		const packed = packMessageEvents(
			this.db,
			mandatory,
			normal,
			suffixBudget,
			// Native prompt preflight may compact the old window after packing. References
			// can omit their body only when the parent is included in this same new batch.
			{ visibleIds: new Set() },
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
		const stickerCandidates = batchStickerCandidates(
			this.db,
			this.bot.id,
			chatId,
			packed.visibleMessageIds,
			this.bot.stickerSets,
		);
		const stickerCandidateTokens = stickerCandidates ? estimateProviderTokensUpperBound(`\n\n${stickerCandidates}`) : 0;
		const boundedStickerCandidates =
			stickerCandidates && packed.estimatedTokens + stickerCandidateTokens <= suffixBudget ? stickerCandidates : "";
		const boundedStickerCandidateTokens = boundedStickerCandidates
			? estimateProviderTokensUpperBound(`\n\n${boundedStickerCandidates}`)
			: 0;

		// Persisted content is pure message bytes. The batch's sticker note lives only in
		// details.stickerCandidates and reaches the provider as a separate projected message after
		// this batch; compaction reads persisted content directly and never sees it.
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
		this.currentTriggerMessageId ??= delivered[0]?.messageId ?? packed.events.at(-1)?.messageId ?? null;
		this.pendingInputMetrics = {
			inputEvents: packed.events.length,
			estimatedTokens: packed.estimatedTokens + boundedStickerCandidateTokens,
			rowsScanned,
			visionCalls: this.pendingInputMetrics.visionCalls,
			imagesAttached: packed.imagesAttached,
		};
		// Native prompt preflight installs system/tools even on the first request; the
		// before_agent_start extension appends this batch as a persistent custom message.
		// Make packed references addressable during the turn; durable visibility commits below.
		await this.checkContextImageBudget(details);
		for (const messageId of packed.visibleMessageIds) this.visibleMessageIds.add(messageId);
		this.pendingTurnContext = details;
		try {
			await this.session.prompt(TELEGRAM_TURN_PROMPT, { expandPromptTemplates: false });
		} catch (error) {
			this.reconcileContextStateFromSession();
			throw error;
		} finally {
			this.pendingTurnContext = null;
		}
		if (
			!this.lastTurnFailed &&
			this.turnSendOutcome === "none" &&
			this.bot.tools.send &&
			delivered.length > 0 &&
			delivered.every((obligation) => this.visibleMessageIds.has(obligation.messageId)) &&
			!this.stopping
		) {
			log.info("agent_runtime", "reply_repair_started", {
				bot_id: this.bot.id,
				trigger_message_id: this.currentTriggerMessageId,
				obligation_count: delivered.length,
			});
			this.typingLease.start();
			await this.session.prompt(
				`${REPLY_RECOVERY_PROMPT}${delivered.map((obligation) => `#${obligation.messageId}`).join(", ")}`,
			);
		}
		log.info("agent_runtime", "provider_turn_settled", {
			bot_id: this.bot.id,
			trigger_message_id: this.currentTriggerMessageId,
			input_events: packed.events.length,
			provider_calls: this.providerCallsInRun,
			send_outcome: this.turnSendOutcome,
		});
		const activeState = contextStateFromEntries(this.session.sessionManager.buildContextEntries(), highWater);
		// Provider completion is not Telegram delivery. Unknown/partial commits are terminal;
		// failure or silence without any remote outcome stays owed, without an unbounded loop.
		const replyPending = this.turnSendOutcome === "none";
		const deliveredObligationIds = replyPending ? [] : delivered.map((obligation) => obligation.messageId);
		if (deliveredObligationIds.length > 0) {
			this.session.sessionManager.appendCustomEntry(TELEGRAM_CONTEXT_COMMIT_TYPE, {
				consumedSeq: highWater,
				deliveredObligationIds,
				outcome: this.turnSendOutcome,
			});
		}
		commitConsumedContext(this.db, {
			botId: this.bot.id,
			chatId,
			consumedSeq: highWater,
			epoch: this.epoch,
			visibleMessageIds: [...activeState.visible],
			deliveredObligationIds,
		});
		this.visibleMessageIds = activeState.visible;
		await this.maybeAutoCompact();
		if (replyPending) {
			if (!this.lastTurnFailed)
				log.info("agent_runtime", "model_silence", {
					bot_id: this.bot.id,
					trigger_message_id: this.currentTriggerMessageId,
					obligation_count: delivered.length,
				});
			for (const obligation of delivered) {
				this.recordEvent("reply_obligation_retained", { message_id: obligation.messageId });
			}
			// Retry exhaustion or a second silent turn must not loop straight back into the provider.
			return false;
		}
		for (const obligation of delivered) {
			this.recordEvent("reply_obligation_delivered", {
				message_id: obligation.messageId,
				outcome: this.turnSendOutcome,
			});
		}
		return replyObligationCount(this.db, this.bot.id, chatId) > 0;
	}

	/** Schedule persisted direct replies after startup; committed rows reconcile idempotently. */
	recoverReplyObligations(): TriggerResult | null {
		const chatId = this.config.groupChatId;
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
		const chatId = this.config.groupChatId;
		removeReplyObligations(this.db, this.bot.id, [{ chatId, messageId }]);
	}

	/** Check before appending the batch, including after a failed or restored turn. */
	private async checkContextImageBudget(pending: TelegramContextDetails): Promise<void> {
		if (!this.session || this.config.media.mode !== "context") return;
		const imageBytes = () =>
			contextImageBytes(
				this.session!.sessionManager.buildContextEntries(),
				join(this.config.dataDir, "media"),
				pending,
			);
		const bytes = imageBytes();
		if (bytes <= this.bot.contextImageBudgetBytes) return;
		log.info("agent_runtime", "auto_compact_triggered", {
			bot_id: this.bot.id,
			stage: "preflight",
			image_bytes: bytes,
			image_budget: this.bot.contextImageBudgetBytes,
		});
		try {
			await this.compactSession();
		} catch (error) {
			log.warn("agent_runtime", "context_input_rejected", { bot_id: this.bot.id, category: "compaction_failed" });
			throw error;
		}
		if (imageBytes() > this.bot.contextImageBudgetBytes) {
			log.warn("agent_runtime", "context_input_rejected", { bot_id: this.bot.id, category: "image_budget_exceeded" });
			throw new Error("context image budget exceeded after compaction");
		}
	}

	/** Enforce image transport pressure after the durable batch commit; lifecycle owns file deletion. */
	private async maybeAutoCompact(): Promise<void> {
		if (this.stopping || !this.session) return;
		// The provider turn has settled, but flush still owns its state until this returns.
		// A turn that just failed at the provider makes the summary request just as likely to
		// fail (and to burn its retry budget), so wait for the next successful turn.
		if (this.controlCompacting || this.session.isStreaming || this.lastTurnFailed) {
			log.warn("agent_runtime", "auto_compact_skipped", {
				bot_id: this.bot.id,
				control_compacting: this.controlCompacting,
				is_streaming: this.session.isStreaming,
				last_turn_failed: this.lastTurnFailed,
			});
			return;
		}
		try {
			// Pi already ran its token-threshold compaction inside the turn; the only signal it
			// cannot see is image transport bytes.
			const entries = this.session.sessionManager.buildContextEntries();
			const imageBytes = contextImageBytes(entries, join(this.config.dataDir, "media"));
			if (imageBytes <= this.bot.contextImageBudgetBytes) return;
			log.info("agent_runtime", "auto_compact_triggered", {
				bot_id: this.bot.id,
				image_bytes: imageBytes,
				image_budget: this.bot.contextImageBudgetBytes,
			});
			await this.compactSession();
		} catch (error) {
			// Estimation or compaction failure must never break the settled flush.
			log.warn("agent_runtime", "auto_compact_failed", {
				bot_id: this.bot.id,
				category: errorCategory(error),
			});
		}
	}

	private refreshCompactionBudget(): void {
		if (!this.session) return;
		const keepRecentTokens = compactionTextBudget(
			this.session.sessionManager.getBranch(),
			this.bot.compactionKeepRecent,
		);
		this.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens } });
	}

	/** Manual/image-pressure paths need the same pre-preparation accounting as native auto-compaction. */
	private async compactSession(): Promise<CompactionResult> {
		const session = this.session!;
		this.refreshCompactionBudget();
		try {
			return await session.compact();
		} finally {
			session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: this.bot.compactionKeepRecent } });
		}
	}

	/** Manual compact that never passes instructions and never aborts an active response. */
	async compactForControl(): Promise<ManualCompactResult> {
		const blocked = this.controlBlocked();
		if (blocked) return { ok: false, code: blocked };
		const session = this.session!;
		// Pi's prepareCompaction returns nothing when the branch already ends in a compaction or
		// has no discardable turn; check the structure instead of matching its error text.
		const branch = session.sessionManager.getBranch();
		if (branch.at(-1)?.type === "compaction" || !branch.some((entry) => entry.type === "message")) {
			return { ok: false, code: "nothing_to_compact" };
		}
		this.controlCompacting = true;
		try {
			const result = await this.compactSession();
			this.lastControlCompact = { at: Date.now(), outcome: "ok" };
			return { ok: true, epoch: this.epoch, tokensBefore: result.tokensBefore };
		} catch {
			this.lastControlCompact = { at: Date.now(), outcome: "failed" };
			return { ok: false, code: "failed" };
		} finally {
			this.controlCompacting = false;
			this.rearmPendingTrigger();
		}
	}

	/** Prepare a fresh Pi session before committing config; existing session bytes remain untouched. */
	async changeModelForControl(
		provider: string,
		modelId: string,
		persist: (selection: ModelControlSelection) => { finalize(): void; rollback(): void },
	): Promise<ModelControlResult> {
		const blocked = this.controlBlocked();
		if (blocked) return { ok: false, code: blocked };
		const catalog = this.modelRuntime.getModel(provider, modelId);
		if (!catalog) return { ok: false, code: "unknown_model" };
		if (!this.modelRuntime.hasConfiguredAuth(provider)) return { ok: false, code: "unauthenticated_provider" };
		if (this.config.media.mode === "context" && !catalog.input.includes("image"))
			return { ok: false, code: "image_input_unsupported" };
		const reasoningEffort = clampThinkingLevel(catalog, this.bot.reasoningEffort);
		if (provider === this.bot.provider && modelId === this.bot.model && reasoningEffort === this.bot.reasoningEffort)
			return { ok: true, epoch: this.epoch, reasoningEffort };
		const nextModel = { ...catalog, contextWindow: Math.min(catalog.contextWindow, this.config.contextWindow) };
		let write: ReturnType<typeof persist> | undefined;
		let stage: "failed" | "config_write_failed" = "failed";
		const result = await this.replaceSessionForControl(nextModel, reasoningEffort, {
			beforeCommit: () => {
				stage = "config_write_failed";
				write = persist({ provider, model: modelId, reasoningEffort });
				stage = "failed";
			},
			afterCommit: () => {
				write!.finalize();
				write = undefined;
				Object.assign(this.bot, { provider, model: modelId, reasoningEffort });
			},
		});
		if (result.ok) {
			log.info("agent_runtime", "model_changed", {
				bot_id: this.bot.id,
				provider,
				model: modelId,
				reasoning: reasoningEffort,
				epoch: result.epoch,
			});
			return { ok: true, epoch: result.epoch, reasoningEffort };
		}
		write?.rollback();
		if (result.code !== "failed") return { ok: false, code: result.code };
		log.warn("agent_runtime", "model_change_failed", { bot_id: this.bot.id, category: stage });
		return { ok: false, code: stage };
	}

	/** Start an empty Pi session with the current model; the old session file stays on disk. */
	async newSessionForControl(): Promise<NewSessionResult> {
		const blocked = this.controlBlocked();
		if (blocked) return { ok: false, code: blocked };
		const result = await this.replaceSessionForControl(this.model, this.bot.reasoningEffort);
		if (result.ok) log.info("agent_runtime", "session_reset", { bot_id: this.bot.id, epoch: result.epoch });
		else if (result.code === "failed")
			log.warn("agent_runtime", "session_reset_failed", { bot_id: this.bot.id, category: "failed" });
		return result;
	}

	private controlBlocked(): "stopping" | "unavailable" | "busy" | null {
		if (this.stopping) return "stopping";
		if (!this.session) return "unavailable";
		if (
			this.flushing ||
			this.running ||
			this.controlCompacting ||
			this.controlChangingModel ||
			this.session.isStreaming
		)
			return "busy";
		return null;
	}

	/** Swap in a fresh session and epoch atomically; a failure leaves the current session in place. */
	private async replaceSessionForControl(
		nextModel: Model<Api>,
		reasoningEffort: BotConfig["reasoningEffort"],
		hooks: { beforeCommit?: () => void; afterCommit?: () => void } = {},
	): Promise<{ ok: true; epoch: number } | { ok: false; code: "stopping" | "failed" }> {
		this.controlChangingModel = true;
		let nextSession: AgentSession | null = null;
		try {
			const identity = {
				...this.contextFingerprintInput,
				provider: nextModel.provider,
				model: nextModel.id,
				api: nextModel.api,
				contextWindow: nextModel.contextWindow,
				reasoningEffort,
			};
			const fingerprint = buildContextFingerprint(identity);
			nextSession = await this.createModelSession(
				nextModel,
				reasoningEffort,
				SessionManager.create(this.config.dataDir, join(this.config.dataDir, "sessions", this.bot.id)),
			);
			if (this.stopping) return { ok: false, code: "stopping" };
			if (!nextSession.sessionFile) throw new Error("persistent session unavailable");
			hooks.beforeCommit?.();
			const epoch = this.epoch + 1;
			const committed = nextSession;
			this.db.transaction(() => {
				setBotState(this.db, this.bot.id, EPOCH_KEY, String(epoch));
				replaceVisibleMessageIds(this.db, this.bot.id, this.config.groupChatId, epoch, []);
				setSessionManifest(this.db, {
					botId: this.bot.id,
					sessionId: committed.sessionId,
					sessionFile: committed.sessionFile!,
					contextFingerprint: fingerprint,
					createdAt: Date.now(),
				});
			})();
			hooks.afterCommit?.();
			const previous = this.session!;
			this.session = committed;
			nextSession = null;
			this.model = nextModel;
			this.contextFingerprintInput = identity;
			this.contextFingerprint = fingerprint;
			this.epoch = epoch;
			this.visibleMessageIds.clear();
			this.lastTurnFailed = false;
			this.pendingPayloadObservation = null;
			this.subscribeEvents();
			// Disposal cannot undo an already committed session.
			try {
				previous.dispose();
			} catch {
				log.warn("agent_runtime", "previous_session_dispose_failed", {
					bot_id: this.bot.id,
					category: "local_failure",
				});
			}
			return { ok: true, epoch };
		} catch {
			return { ok: false, code: "failed" };
		} finally {
			// An uncommitted, empty session owns no work.
			try {
				nextSession?.dispose();
			} catch {}
			this.controlChangingModel = false;
			this.rearmPendingTrigger();
		}
	}

	/** A trigger coalesced while busy must run once the blocking operation releases the bot. */
	private rearmPendingTrigger(): void {
		if (this.pendingTrigger && !this.stopping) {
			this.pendingTrigger = false;
			this.trigger("explicit");
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
		const pending = pendingMediaIds(batch, obligationIds, this.config.media.maxImagesPerTurn, (id) =>
			Boolean(contextMediaRefs(this.db, id)),
		);
		await forEachConcurrent(pending, this.config.media.downloadConcurrency, async (fileUniqueId) => {
			try {
				const prepared = await ensureContextMedia(this.db, this.api, this.bot.id, fileUniqueId, {
					cacheDir: join(this.config.dataDir, "media"),
					botApis: this.botApis,
					videoTranscoder: this.videoTranscoder,
				});
				if (!prepared.ok) {
					this.recordEvent("error", { stage: "context_media", category: prepared.outcome });
					log.warn("context_media", "prepare_failed", { bot_id: this.bot.id, category: prepared.outcome });
				}
			} catch {
				this.recordEvent("error", { stage: "context_media", category: "request_failed" });
			}
		});
	}

	/** Lazy vision: bounded per turn, with direct-reply events ordered before ordinary catch-up. */
	private async ensureBatchVision(batch: readonly MessageEvent[], obligationIds: ReadonlySet<number>): Promise<void> {
		if (!this.config.vision.enabled || this.config.vision.foregroundMediaLimit <= 0) return;
		const described = this.db.query("SELECT vision FROM media WHERE file_unique_id = ?");
		const pending = pendingMediaIds(
			batch,
			obligationIds,
			this.config.vision.foregroundMediaLimit,
			(id) => Boolean((described.get(id) as { vision: string | null } | null)?.vision),
			true,
		);
		await forEachConcurrent(pending, VISION_BATCH_CONCURRENCY, (fileUniqueId) => this.ensureOneVision(fileUniqueId));
	}

	private async ensureOneVision(fileUniqueId: string): Promise<void> {
		// The daemon constructs and readiness-checks (assertPiVisionExecutorReady) the shared executor
		// before Telegram starts; a missing executor here is a wiring bug, never a runtime fallback.
		if (!this.visionExecutor) throw new Error("vision executor is required when vision is enabled");
		try {
			await ensureVision(this.db, this.api, this.bot.id, fileUniqueId, this.visionExecutor, {
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

	private markVisible(ids: readonly number[]): void {
		for (const id of ids) this.visibleMessageIds.add(id);
		const chatId = this.config.groupChatId;
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
		const ts = Date.now();
		const inserted = this.db
			.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (?, ?, ?, ?)")
			.run(this.bot.id, ts, kind, JSON.stringify(storedPayload));
		if (grouped) this.emitAssistantActivity(ts);
		else this.eventSink?.({ id: Number(inserted.lastInsertRowid), ts, kind, payload });
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
		const observation = this.pendingPayloadObservation;
		const contextBreakdown = fitContextBreakdown(
			observation?.tokenEstimate ?? { system: 0, tools: 0, compactedHistory: 0, messages: contextTokens },
			contextTokens,
		);
		const metrics = this.pendingInputMetrics;
		const sessionIdHash = this.session ? sha256(`${this.telemetryHmacKey}:${this.session.sessionId}`) : null;
		// The previous main request of the same cache cohort lives in memory only; after a restart
		// the first request simply has no estimate.
		const cohort = `${this.bot.provider}|${this.model.api}|${this.bot.model}|${this.epoch}|${sessionIdHash}|${this.bot.cacheRetention}`;
		const previous = this.previousRequest?.cohort === cohort ? this.previousRequest : null;
		const cacheReadEstimated =
			observation && previous && usage.cacheRead === 0 && usage.cacheWrite === 0 && this.bot.cacheRetention !== "none"
				? estimateCacheReadFromPrefix(observation, previous, contextTokens)
				: null;
		this.previousRequest = observation
			? {
					cohort,
					systemHash: observation.systemHash,
					toolsHash: observation.toolsHash,
					messageHashes: observation.messageHashes,
					contextTokens,
				}
			: null;
		this.lastLlmRunId = insertRow(this.db, "llm_runs", {
			bot_id: this.bot.id,
			ts: now,
			model: this.bot.model,
			epoch: this.epoch,
			context_tokens: contextTokens,
			cache_read: usage.cacheRead,
			cache_write: usage.cacheWrite,
			cache_read_estimated: cacheReadEstimated,
			cache_miss: usage.input,
			output_tokens: usage.output,
			reasoning_tokens: reasoningTokens,
			latency_ms: latencyMs,
			cost: usage.cost.total,
			compaction: 0,
			system_hash: observation?.systemHash ?? this.systemHash,
			tools_hash: observation?.toolsHash ?? this.toolsHash,
			provider: this.bot.provider,
			api: this.model.api,
			session_id_hash: sessionIdHash,
			cache_retention: this.bot.cacheRetention,
			full_payload_hash: observation?.fullPayloadHash ?? null,
			first_divergent_segment: observation?.firstDivergentSegment ?? null,
			first_divergent_message_index: observation?.firstDivergentMessageIndex ?? null,
			first_divergent_byte_offset: observation?.firstDivergentByteOffset ?? null,
			trigger_message_id: this.currentTriggerMessageId,
			public_send_count: 0,
			vision_calls: metrics.visionCalls,
			images_attached: metrics.imagesAttached,
			tool_followup_rounds: this.providerCallsInRun > 1 ? 1 : 0,
			input_events: metrics.inputEvents,
			input_tokens_estimated: metrics.estimatedTokens,
			rows_scanned: metrics.rowsScanned,
			system_tokens: contextBreakdown.system,
			tools_tokens: contextBreakdown.tools,
			compacted_history_tokens: contextBreakdown.compactedHistory,
			message_tokens: contextBreakdown.messages,
			thinking_ms: this.thinkingMs,
		});
		this.pendingInputMetrics = emptyInputMetrics();
		this.usageSink?.();
		this.thinkingMs = 0;
		this.thinkingFinished = false;
	}

	private recordSendDuration(durationMs: number): void {
		if (this.lastLlmRunId == null || !Number.isFinite(durationMs)) return;
		this.db
			.query("UPDATE llm_runs SET send_ms = send_ms + ?, send_samples = send_samples + 1 WHERE id = ?")
			.run(Math.max(0, Math.round(durationMs)), this.lastLlmRunId);
		this.usageSink?.();
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
		if (contextTokens + usage.output + (usage.reasoning ?? 0) === 0 && usage.cost.total === 0) return;
		const id = insertRow(this.db, "llm_runs", {
			bot_id: this.bot.id,
			ts: now,
			model: model.id,
			epoch: this.epoch,
			context_tokens: contextTokens,
			cache_read: usage.cacheRead,
			cache_write: usage.cacheWrite,
			cache_miss: usage.input,
			output_tokens: usage.output,
			reasoning_tokens: usage.reasoning ?? 0,
			latency_ms: null,
			cost: usage.cost.total,
			compaction: 1,
			system_hash: sha256Short(COMPACTION_SUMMARY_PROMPT),
			tools_hash: sha256Short("[]"),
			provider: model.provider,
			api: model.api,
			cache_retention: "none",
		});
		this.usageSink?.();
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
		this.session?.dispose();
	}
}
