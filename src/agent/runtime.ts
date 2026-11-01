// BotRuntime: one persona bot = one Pi AgentSession + immutable event consumption + visible refs.
// See docs/architecture.md.

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clampThinkingLevel, isContextOverflow, type Api, type Model } from "@earendil-works/pi-ai";
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
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { MIN_COMPACTION_RESERVE, type AppConfig, type BotConfig } from "../config.ts";
import { getBotState, setBotState } from "../db/db.ts";
import {
	addVisibleMessageIds,
	appendNoteEvent,
	commitConsumedContext,
	eventsForBot,
	getConsumedSeq,
	getSessionManifest,
	listRecentMessageEvents,
	listVisibleMessageIds,
	messageEventHighWater,
	replaceVisibleMessageIds,
	setConsumedSeq,
	setSessionManifest,
	type MessageEvent,
	type NotePayload,
} from "../db/message-events.ts";
import {
	createReplyObligation,
	listReplyObligations,
	removeReplyObligations,
	replyObligationCount,
} from "../db/reply-obligations.ts";
import type { AgentStreamFrame, RuntimeControlSnapshot } from "../ipc.ts";
import type { MediaDownloadApi } from "../media/local-cache.ts";
import { createImageRefResolver } from "../media/prepare-images.ts";
import {
	batchStickerCandidates,
	ensureStickerCatalog,
	stickerCatalogPromptBlock,
	stickerCatalogSnapshotHash,
} from "../media/sticker-catalog.ts";
import { ensureVision, type VisionExecutor, type VisionUpdateSink } from "../media/vision.ts";
import type { VisionScheduler } from "../media/vision-scheduler.ts";
import { errorCategory, log } from "../observability/log.ts";
import { WorkBox } from "../sandbox/box.ts";
import type { JobRunner } from "../tasks/jobs.ts";
import { TaskError, type TaskManager } from "../tasks/manager.ts";
import { TelegramTypingLease } from "../telegram/activity.ts";
import { BotApi, groupReactionAllowlist, TelegramApiError } from "../telegram/api.ts";
import { consumedControlMessageIds } from "../telegram/control-command.ts";
import { AssistantActivityStream } from "./activity.ts";
import {
	buildContextFingerprint,
	canResumeContextSession,
	sha256,
	type ContextFingerprintInput,
} from "./context-fingerprint.ts";
import {
	batchMessage,
	contextStateFromEntries,
	reconcileContextStateFromSession,
	steeredVisibleIds,
	TELEGRAM_CONTEXT_COMMIT_TYPE,
} from "./context-state.ts";
import {
	CODEMODE_DECLARATION_TOKENS,
	compactionTextBudget,
	contextImageBytes,
	generateCompactionSummary,
	makeAssistantPersistencePolicyExtension,
	makeCachePayloadObserverExtension,
	makeCodemodeExtension,
	makeTelegramCompactionExtension,
	makeTelegramContextExtension,
	TELEGRAM_CONTEXT_VERSION,
} from "./extensions/index.ts";
import { parsePiModelReference, type PiRequestThinkingLevel } from "./model-ref.ts";
import { classifyPiProviderFailure } from "./model-runtime.ts";
import {
	buildSystemPrompt,
	CACHE_SCHEMA_VERSION,
	COMPACTION_SUMMARY_PROMPT,
	REPLY_RECOVERY_PROMPT,
	SHARED_PROTOCOL,
	sha256Short,
} from "./prompt.ts";
import { guardProviderCall, providerRetryPolicy } from "./provider-guard.ts";
import type { RoutingTrigger, TriggerResult, TriggerSource } from "./router.ts";
import { BotRuntimeTelemetry, emptyInputMetrics, restoreLastCompaction } from "./runtime-telemetry.ts";
import { buildBotRuntimeTools } from "./runtime-tools.ts";
import { TELEGRAM_SERIALIZER_VERSION } from "./serialize.ts";
import { trimSessionBeforeCompaction } from "./session-trim.ts";
import {
	availableSuffixBudget,
	DEFAULT_REASONING_RESERVE,
	DEFAULT_TOOL_FOLLOWUP_RESERVE,
	estimateProviderTokensUpperBound,
	MAX_EVENT_SCAN,
	MAX_OBLIGATION_SCAN,
	packMessageEvents,
	pendingMediaIds,
	scanTurnEventWindow,
	unseenEvents,
} from "./token-packer.ts";
import { toolProtocolHash } from "./tools.ts";

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

export type NewSessionResult =
	| { ok: true; epoch: number }
	| { ok: false; code: "busy" | "stopping" | "unavailable" | "failed" };

export type ManualCompactResult =
	| { ok: true; epoch: number; tokensBefore: number }
	| { ok: false; code: "busy" | "stopping" | "unavailable" | "nothing_to_compact" | "failed" };

const EPOCH_KEY = "context_epoch";
/** Suffix budget for one batch steered into a running turn. */
const STEER_TOKEN_BUDGET = 4_000;
/** How long a turn waits for new media descriptions before replying without them. */
const VISION_WAIT_MS = 2_500;

const delay = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});

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
	private readonly activity: AssistantActivityStream;
	private readonly telemetry: BotRuntimeTelemetry;
	private contextFingerprint = "";
	private staticPrefixTokenEstimate = 0;
	private sendsThisTurn = 0;
	/** The provider turn in flight: new direct addresses are steered into it (steerDirectAddress). */
	private activeTurn: { steeredThrough: number; steering: Promise<void> } | null = null;
	private readonly box: WorkBox | null;
	private readonly tasks: TaskManager | null;
	private jobs: JobRunner | null = null;
	private allowedReactions: ReadonlySet<string> | null = null;
	private currentTriggerMessageId: number | null = null;
	private readonly visionScheduler: VisionScheduler | null;
	private readonly typingLease: TelegramTypingLease;
	private readonly videoTranscoder: boolean;
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
			videoTranscoder: boolean;
			chatActionSender?: (signal: AbortSignal) => Promise<unknown>;
			api?: BotApi;
			botApis?: ReadonlyMap<string, MediaDownloadApi>;
			visionExecutor?: VisionExecutor;
			visionScheduler?: VisionScheduler;
			box?: WorkBox;
			tasks?: TaskManager;
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
		this.tasks = bot.tools.tasks ? (options.tasks ?? null) : null;
		this.activity = new AssistantActivityStream(
			bot,
			() => this.streamSink,
			() => this.streamDemand?.() ?? true,
			(snapshot) => this.telemetry.recordEvent("agent_activity", snapshot),
		);
		this.telemetry = new BotRuntimeTelemetry(
			db,
			bot,
			this.activity,
			() => this.eventSink,
			() => this.usageSink,
		);
		this.box = options.box ?? (bot.tools.sandbox && config.sandbox ? new WorkBox(bot.id, config.sandbox) : null);
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
		this.telemetry.systemHash = sha256Short(systemPrompt);

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

		const { activeTools, scriptTools, declaredTools, jobs } = buildBotRuntimeTools({
			db: this.db,
			bot: this.bot,
			config: this.config,
			api: this.api,
			botApis: this.botApis,
			videoTranscoder: this.videoTranscoder,
			box: this.box,
			tasks: this.tasks,
			allowedReactions: () => this.allowedReactions,
			triggerMessageId: () => this.currentTriggerMessageId,
			sendsThisTurn: () => this.sendsThisTurn,
			onSendPosted: () => {
				this.sendsThisTurn++;
			},
			onSendOutcome: (outcome) => {
				this.turnSendOutcome = outcome;
			},
			onPublicSend: () => this.telemetry.recordPublicSend(),
			onSendDuration: (durationMs) => this.telemetry.recordSendDuration(durationMs),
			onSent: (raw) => this.sentMessageSink?.(raw),
			stopTyping: () => this.typingLease.stop(),
			resetBox: (reason) => this.resetBox(reason),
			markVisible: (ids) => this.markVisible(ids),
			onImageAttached: (count) => {
				this.telemetry.pendingInputMetrics.imagesAttached += count;
			},
			recordEvent: (kind, payload) => this.telemetry.recordEvent(kind, payload),
			recordNote: (note) => this.recordNote(note),
			wakeForTask: (originMessageId, owe) => this.wakeForTask(originMessageId, owe),
		});
		this.jobs = jobs;
		this.telemetry.toolsHash = toolProtocolHash(declaredTools);
		this.staticPrefixTokenEstimate =
			estimateProviderTokensUpperBound(
				`${systemPrompt}\n${JSON.stringify(activeTools.map(({ name, description, parameters }) => ({ name, description, parameters })))}`,
			) + (this.bot.tools.codemode ? CODEMODE_DECLARATION_TOKENS : 0);
		const payloadKey = sha256(
			`telegram-payload-observer:${this.config.routerSecret ?? this.config.dataDir}:${this.bot.id}`,
		);
		this.telemetry.hmacKey = payloadKey;
		const extensions = [
			// Only hybrid mode has images in context: view_image results, resolved at projection.
			makeTelegramContextExtension(
				this.config.media.mode === "hybrid" ? createImageRefResolver(join(this.config.dataDir, "media")) : undefined,
			),
			makeTelegramCompactionExtension((event) => this.handleBeforeCompact(event)),
			makeCachePayloadObserverExtension(payloadKey, (observation) => {
				this.telemetry.pendingObservation = observation;
			}),
			...(this.bot.tools.codemode ? [makeCodemodeExtension()] : []),
			makeAssistantPersistencePolicyExtension(
				(text) => {
					this.telemetry.recordEvent("assistant_text", { text });
				},
				(message) => this.activity.capture(message),
			),
		];
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
			extensionOrder: extensions.map((extension) => extension.name),
			tools: declaredTools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				outputSchema: "outputSchema" in tool ? tool.outputSchema : undefined,
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
				...(this.bot.tools.codemode ? { tools: ["+codemode"] } : {}),
				customTools: [...activeTools, ...scriptTools],
			});
			const streamFunction = session.agent.streamFunction;
			session.agent.streamFunction = (requestModel, context, options) => {
				this.telemetry.pendingObservation = null;
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
		this.reconcileContextState();
		this.subscribeEvents();
		log.info("agent_runtime", "session_ready", {
			bot_id: this.bot.id,
			state: canResume ? "resumed" : "new",
			epoch: this.epoch,
			fingerprint: this.contextFingerprint.slice(0, 12),
			system_hash: this.telemetry.systemHash,
			tools_hash: this.telemetry.toolsHash,
			tools: session.getActiveToolNames().join(","),
			cache_schema: CACHE_SCHEMA_VERSION,
		});
	}

	private reconcileContextState(): void {
		if (!this.session) return;
		this.visibleMessageIds = reconcileContextStateFromSession(
			this.db,
			this.session.sessionManager,
			this.bot.id,
			this.config.groupChatId,
			this.epoch,
		);
	}

	private subscribeEvents(): void {
		if (!this.session) return;
		this.session.subscribe((event) => {
			const now = Date.now();
			switch (event.type) {
				case "agent_start":
					this.activity.begin(now);
					this.running = true;
					this.lastTurnFailed = false;
					this.telemetry.beginRun(now);
					break;
				case "message_start":
				case "message_update":
					if (event.message.role === "assistant") {
						this.telemetry.observeThinking(event.message, now);
						this.activity.update(event.message, now);
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
								category: isContextOverflow(msg)
									? "provider_request_too_large"
									: classifyPiProviderFailure(msg.errorMessage ?? "provider failed"),
							});
						this.telemetry.observeThinking(msg, now, true);
						const thinking = msg.content
							.filter((c) => c.type === "thinking")
							.map((c) => (c as { thinking: string }).thinking)
							.join("\n");
						if (thinking.trim()) this.telemetry.recordEvent("thinking", { text: thinking });
						// Failed attempts carry zero usage; recording them would create empty llm_runs
						// rows, consume this turn's input metrics, and mark the eventual success as a
						// tool follow-up round.
						if (msg.usage && !this.lastTurnFailed)
							this.telemetry.recordUsage(msg.usage, now, {
								model: this.model,
								epoch: this.epoch,
								sessionId: this.session?.sessionId,
								triggerMessageId: this.currentTriggerMessageId,
							});
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
					this.telemetry.recordEvent("tool_call", { tool: event.toolName, args: event.args });
					log.info("agent_tool", "execution_started", {
						bot_id: this.bot.id,
						tool: event.toolName,
						trigger_message_id: this.currentTriggerMessageId,
					});
					break;
				case "tool_execution_end":
					try {
						this.telemetry.recordEvent("tool_result", { tool: event.toolName, isError: event.isError });
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
					this.activity.finish(now);
					break;
				case "compaction_end":
					this.onCompactionEnd(event);
					break;
			}
		});
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
			this.telemetry.recordEvent("error", {
				stage: "compaction",
				reason: event.reason,
				aborted: event.aborted,
				category,
			});
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
		this.telemetry.recordEvent("compaction", { epoch: this.epoch, kept: kept.length });
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
			const gen = await generateCompactionSummary(prep, event.signal, {
				botId: this.bot.id,
				model: this.compactionModel,
				reasoning: this.compactionReasoning,
				modelRuntime: this.modelRuntime,
				mediaDir: join(this.config.dataDir, "media"),
				imageBudgetBytes: this.bot.contextImageBudgetBytes,
				timeoutMs: this.bot.providerTimeoutMs,
				retries: this.bot.providerRetries,
				onUsage: (usage) => this.telemetry.recordCompactionUsage(usage, Date.now(), this.compactionModel, this.epoch),
			});
			if (!("summary" in gen)) {
				// NOTE: the SDK swallows extension handler exceptions and would silently fall back
				// to the default summarizer, so refusal goes through cancel -> compaction_end { aborted: true }.
				this.telemetry.recordEvent("error", { stage: "compaction", error: gen.failure });
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

	/** Lifecycle state used by deterministic scheduling and the Telegram control plane. */
	samplingState(now = this.monotonicNow()): "idle" | "busy" | "cooldown" | "stopping" {
		if (this.stopping) return "stopping";
		if (this.flushing || this.controlCompacting || this.controlChangingModel) return "busy";
		if (now < this.cooldownUntil) return "cooldown";
		return "idle";
	}

	/** Called by the scheduler when this bot gets a response opportunity. */
	trigger(source: TriggerSource = "explicit", routingTrigger?: RoutingTrigger): TriggerResult {
		// SHARED_PROTOCOL: explicit @mention, reply-to-bot, and configured-name keyword are all
		// direct addresses that must reach the provider even when this trigger only coalesces.
		// A `/fire` bot-triggered address is only an opportunity: no durable obligation to answer a bot.
		const isDirectReply =
			routingTrigger != null &&
			!routingTrigger.fromBot &&
			(routingTrigger.reason === "explicit" || routingTrigger.reason === "reply" || routingTrigger.reason === "name");
		let directReplyPending = false;
		let directReplyMessageId: number | null = null;
		if (isDirectReply && this.bot.tools.send && !this.visibleMessageIds.has(routingTrigger.messageId)) {
			const created = createReplyObligation(this.db, this.bot.id, routingTrigger.chatId, routingTrigger.messageId);
			directReplyPending = true;
			directReplyMessageId = routingTrigger.messageId;
			if (created) this.telemetry.recordEvent("reply_obligation_created", { message_id: routingTrigger.messageId });
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
			// A human addressing the bot mid-turn reaches the running turn now instead of waiting.
			if (directReplyPending && this.activeTurn) this.steerDirectAddress();
			// re-entrant trigger while a flush is in flight (e.g. slow media download):
			// coalesce into pendingTrigger; the loop picks it up (burst merge, R1)
			this.pendingTrigger = true;
			this.pendingTriggerMessageId = routingTrigger?.messageId ?? this.pendingTriggerMessageId;
			if (directReplyPending && directReplyMessageId != null) {
				this.telemetry.recordEvent("reply_obligation_coalesced", { message_id: directReplyMessageId });
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
					this.telemetry.recordEvent("error", { stage: "flush", category });
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
		const consumedControl = consumedControlMessageIds(this.db, chatId);
		const obligationIds = new Set(obligations.map((obligation) => obligation.messageId));
		let highWater = messageEventHighWater(this.db, chatId);
		let scanned = scanTurnEventWindow(
			this.db,
			this.bot.id,
			chatId,
			consumedSeq,
			highWater,
			obligationIds,
			consumedControl,
			this.visibleMessageIds,
		);
		let rowsScanned = scanned.rowsScanned;

		this.telemetry.pendingInputMetrics = emptyInputMetrics();
		this.sendsThisTurn = 0;
		// Descriptions get a short head start, then finish in the background and arrive later as
		// media_update events; the reply never waits on a slow vision call (view_image covers it).
		const vision = this.ensureBatchVision([...scanned.mandatory, ...scanned.normal], obligationIds).catch(() => {});
		await Promise.race([vision, delay(VISION_WAIT_MS)]);
		// Vision descriptions land as media_update events mid-scan: pick them up so the
		// same flush already sees the fresh descriptions.
		const postVisionHighWater = messageEventHighWater(this.db, chatId);
		if (postVisionHighWater > highWater) {
			highWater = postVisionHighWater;
			scanned = scanTurnEventWindow(
				this.db,
				this.bot.id,
				chatId,
				consumedSeq,
				highWater,
				obligationIds,
				consumedControl,
				this.visibleMessageIds,
			);
			rowsScanned += scanned.rowsScanned;
		}
		const usage = this.session.getContextUsage();
		const suffixBudget = availableSuffixBudget({
			contextWindow: usage?.contextWindow ?? this.model.contextWindow,
			currentContextTokens: usage?.tokens ?? 0,
			staticPrefixTokens: this.staticPrefixTokenEstimate,
			maxSuffixTokens: this.bot.maxSuffixTokens,
			outputReserve: Math.min(4096, this.model.maxTokens),
			reasoningReserve: this.bot.reasoningEffort === "off" ? 0 : DEFAULT_REASONING_RESERVE,
			toolFollowupReserve: this.bot.tools.search || this.bot.tools.codemode ? DEFAULT_TOOL_FOLLOWUP_RESERVE : 2048,
		});
		const packed = packMessageEvents(
			this.db,
			scanned.mandatory,
			scanned.normal,
			suffixBudget,
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

		const selectedIds = new Set(packed.visibleMessageIds);
		const delivered = obligations.filter((obligation) => selectedIds.has(obligation.messageId));
		this.currentTriggerMessageId ??= delivered[0]?.messageId ?? packed.events.at(-1)?.messageId ?? null;
		this.telemetry.pendingInputMetrics = {
			inputEvents: packed.events.length,
			estimatedTokens: packed.estimatedTokens + boundedStickerCandidateTokens,
			rowsScanned,
			visionCalls: this.telemetry.pendingInputMetrics.visionCalls,
			imagesAttached: 0, // counted by view_image during the turn
		};
		// The batch itself starts the turn: Pi runs the same pre-run threshold compaction check as
		// for a prompt, then persists it as the turn's first message. Packed references become
		// addressable during the turn; durable visibility commits below.
		await this.checkContextImageBudget();
		for (const messageId of packed.visibleMessageIds) this.visibleMessageIds.add(messageId);
		this.activeTurn = { steeredThrough: highWater, steering: Promise.resolve() };
		try {
			// While streaming, Pi would only queue the batch as steering and return at once.
			if (this.session.isStreaming) throw new Error("session is already streaming");
			await this.session.sendCustomMessage(batchMessage(packed, highWater, boundedStickerCandidates), {
				triggerTurn: true,
			});
		} catch (error) {
			await this.endSteering();
			this.reconcileContextState();
			throw error;
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
		await this.endSteering();
		log.info("agent_runtime", "provider_turn_settled", {
			bot_id: this.bot.id,
			trigger_message_id: this.currentTriggerMessageId,
			input_events: packed.events.length,
			provider_calls: this.telemetry.providerCallsInRun,
			send_outcome: this.turnSendOutcome,
		});
		const turnEntries = this.session.sessionManager.buildContextEntries();
		const activeState = contextStateFromEntries(turnEntries, highWater);
		// Batches steered into this turn that actually landed in the session move the cursor and
		// carry their own direct addresses; queued ones that never landed were dropped above.
		const steeredIds = steeredVisibleIds(turnEntries, highWater);
		highWater = activeState.consumedSeq;
		if (steeredIds.size > 0)
			for (const obligation of listReplyObligations(this.db, this.bot.id, chatId, MAX_OBLIGATION_SCAN))
				if (steeredIds.has(obligation.messageId) && !delivered.includes(obligation)) delivered.push(obligation);
		// Provider completion is not Telegram delivery. Unknown/partial commits are terminal;
		// failure or silence without any remote outcome stays owed, without an unbounded loop.
		const replyPending = this.turnSendOutcome === "none";
		const deliveredObligationIds = replyPending ? [] : delivered.map((obligation) => obligation.messageId);
		if (deliveredObligationIds.length > 0) {
			this.session.sessionManager.appendCustomEntry(TELEGRAM_CONTEXT_COMMIT_TYPE, { deliveredObligationIds });
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
		if (replyPending) {
			if (!this.lastTurnFailed)
				log.info("agent_runtime", "model_silence", {
					bot_id: this.bot.id,
					trigger_message_id: this.currentTriggerMessageId,
					obligation_count: delivered.length,
				});
			for (const obligation of delivered) {
				this.telemetry.recordEvent("reply_obligation_retained", { message_id: obligation.messageId });
			}
			// Retry exhaustion or a second silent turn must not loop straight back into the provider.
			return false;
		}
		for (const obligation of delivered) {
			this.telemetry.recordEvent("reply_obligation_delivered", {
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
			this.telemetry.recordEvent("reply_obligation_recovered", { message_id: obligation.messageId });
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
		const chatId = this.config.groupChatId;
		removeReplyObligations(this.db, this.bot.id, [{ chatId, messageId }]);
	}

	/**
	 * Image bytes are the one compaction signal Pi cannot see. Checked before every batch, so it
	 * also covers a failed or restored turn; the compaction then runs before the next request.
	 */
	private async checkContextImageBudget(): Promise<void> {
		if (!this.session || this.config.media.mode !== "hybrid") return;
		const imageBytes = () =>
			contextImageBytes(this.session!.sessionManager.buildContextEntries(), join(this.config.dataDir, "media"));
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
		if (this.config.media.mode === "hybrid" && !catalog.input.includes("image"))
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
			this.telemetry.pendingObservation = null;
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

	/** Lazy vision: bounded per turn, with direct-reply events ordered before ordinary catch-up. */
	private async ensureBatchVision(batch: readonly MessageEvent[], obligationIds: ReadonlySet<number>): Promise<void> {
		if (this.config.media.mode !== "hybrid" || this.config.media.maxPerTurn <= 0) return;
		const described = this.db.query("SELECT vision FROM media WHERE file_unique_id = ?");
		const pending = pendingMediaIds(batch, obligationIds, this.config.media.maxPerTurn, (id) =>
			Boolean((described.get(id) as { vision: string | null } | null)?.vision),
		);
		// The shared VisionScheduler bounds provider concurrency across bots.
		await Promise.all(pending.map((fileUniqueId) => this.ensureOneVision(fileUniqueId)));
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
						this.telemetry.pendingInputMetrics.visionCalls++;
					}
					this.telemetry.recordEvent("vision", telemetry);
				},
				scheduler: this.visionScheduler ?? undefined,
				botApis: this.botApis,
				videoTranscoder: this.videoTranscoder,
			});
		} catch {
			this.telemetry.recordEvent("error", { stage: "vision", category: "request_failed" });
		}
	}

	/**
	 * Steer new direct addresses into the running turn as a regular Telegram batch. Nothing is
	 * committed here: the turn's end reads which steered batches landed in the session (Pi delivers
	 * steering after the current tool calls) and drops the ones still queued.
	 */
	private steerDirectAddress(): void {
		const turn = this.activeTurn;
		if (!turn || !this.session) return;
		turn.steering = turn.steering.then(async () => {
			if (this.activeTurn !== turn || !this.session?.isStreaming) return;
			const chatId = this.config.groupChatId;
			const through = messageEventHighWater(this.db, chatId);
			if (through <= turn.steeredThrough) return;
			const owed = new Set(
				listReplyObligations(this.db, this.bot.id, chatId, MAX_OBLIGATION_SCAN).map((o) => o.messageId),
			);
			const events = unseenEvents(
				eventsForBot(
					listRecentMessageEvents(this.db, chatId, turn.steeredThrough, through, MAX_EVENT_SCAN),
					this.bot.id,
				),
				consumedControlMessageIds(this.db, chatId),
				this.visibleMessageIds,
			);
			if (!events.some((event) => owed.has(event.messageId))) return;
			const packed = packMessageEvents(
				this.db,
				events.filter((event) => owed.has(event.messageId)),
				events.filter((event) => !owed.has(event.messageId)),
				STEER_TOKEN_BUDGET,
				this.bot.maxMessageTokens,
			);
			if (!packed.text.trim()) return;
			// reply_to may target the new messages as soon as the model can see them.
			for (const id of packed.visibleMessageIds) this.visibleMessageIds.add(id);
			await this.session.sendCustomMessage(batchMessage(packed, through, ""), { deliverAs: "steer" });
			turn.steeredThrough = through;
			log.info("agent_runtime", "turn_steered", { bot_id: this.bot.id, input_events: packed.events.length });
		});
	}

	/** Close steering for the turn and drop batches Pi never delivered; the next flush reads them. */
	private async endSteering(): Promise<void> {
		const turn = this.activeTurn;
		if (!turn) return;
		await turn.steering.catch(() => {});
		this.activeTurn = null;
		this.session?.clearQueue();
	}

	taskStatusForControl(): string | null {
		return this.tasks?.describe(this.bot.id) ?? null;
	}

	cancelTaskForControl(taskId: string): { ok: true } | { ok: false; code: "unavailable" | "unknown_task" } {
		if (!this.tasks) return { ok: false, code: "unavailable" };
		try {
			this.tasks.cancel(this.bot.id, taskId);
			return { ok: true };
		} catch (error) {
			if (error instanceof TaskError) return { ok: false, code: "unknown_task" };
			throw error;
		}
	}

	/** Show a note in the local timeline; the provider sees it through the event stream instead. */
	recordNote(note: NotePayload): void {
		this.telemetry.recordEvent("note", {
			source: note.source,
			task_id: note.task_id ?? null,
			phase: note.phase ?? null,
			text: note.text,
		});
	}

	/** A task needs the bot: owe the requester a reply when asked, then wake up. */
	wakeForTask(originMessageId: number, owe: boolean): void {
		if (owe && this.bot.tools.send)
			createReplyObligation(this.db, this.bot.id, this.config.groupChatId, originMessageId);
		this.trigger("explicit");
	}

	/** The bot's work box, when this deployment gives it one. */
	get workBox(): WorkBox | null {
		return this.box;
	}

	async resetBoxForControl(): Promise<{ ok: true } | { ok: false; code: "unavailable" | "failed" }> {
		if (!this.box) return { ok: false, code: "unavailable" };
		try {
			await this.resetBox("admin");
			return { ok: true };
		} catch (error) {
			log.warn("sandbox", "box_reset_failed", { bot_id: this.bot.id, category: errorCategory(error) });
			return { ok: false, code: "failed" };
		}
	}

	/** Destroy the work box; `reason` is telemetry only. */
	async resetBox(reason: "tool" | "weekly" | "admin"): Promise<void> {
		if (!this.box) return;
		await this.box.reset();
		this.telemetry.recordEvent("box_reset", { reason });
		if (reason !== "tool") {
			const note: NotePayload = {
				bot_id: this.bot.id,
				source: "system",
				text: `你的工作区已被清空（${reason === "weekly" ? "每周例行" : "管理员操作"}），/work 里之前的文件都不在了。`,
			};
			appendNoteEvent(this.db, this.config.groupChatId, 0, `box_reset:${this.bot.id}:${Date.now()}`, note);
			this.recordNote(note);
		}
		log.info("sandbox", "box_reset", { bot_id: this.bot.id, reason });
	}

	private markVisible(ids: readonly number[]): void {
		for (const id of ids) this.visibleMessageIds.add(id);
		const chatId = this.config.groupChatId;
		addVisibleMessageIds(this.db, this.bot.id, chatId, this.epoch, ids);
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.jobs?.stopAll();
		this.session?.abortCompaction();
		this.typingLease.stop();
		this.activity.end();
		// Bounded wait for an in-flight flush so the Pi/SQLite context commit can settle;
		// the timeout only guards a wedged provider run.
		if (this.flushPromise) {
			await Promise.race([this.flushPromise.catch(() => {}), new Promise((r) => setTimeout(r, 30_000))]);
		}
		this.session?.dispose();
	}
}
