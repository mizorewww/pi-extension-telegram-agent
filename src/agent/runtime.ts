// Telegram admission and delivery policy. Pi owns sessions, queues, runs, tools and recovery.
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, type Context } from "@earendil-works/chord/context";
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { clampThinkingLevel, contentText, type Message } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	Harness,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	GenerationTask,
	hook,
	InboxDoc,
	LiveDoc,
	ProviderDoc,
	UsageDoc,
	type Conversation,
	type EntryRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AppConfig, BotConfig } from "../config.ts";
import type { Database } from "../db/db.ts";
import {
	groupMessage,
	listRecentMessageEvents,
	messageEventHighWater,
	appendNoteEvent,
	type MessageEvent,
} from "../db/message-events.ts";
import {
	ensureStickerCatalog,
	stickerCatalogSnapshot,
	type StickerCatalogSnapshot,
	batchStickerCandidates,
	projectStickerNotes,
} from "../media/sticker-catalog.ts";
import { prepareMediaImages } from "../media/prepare-images.ts";
import { ensureVision, type VisionExecutor } from "../media/vision.ts";
import type { VisionScheduler } from "../media/vision-scheduler.ts";
import type { SemanticIndex } from "../tools/semantic.ts";
import { log } from "../observability/log.ts";
import type { ContextComposition, RuntimeControlSnapshot } from "../observability/usage.ts";
import { WorkBox } from "../sandbox/box.ts";
import type { TaskManager } from "../tasks/manager.ts";
import { TelegramTypingLease } from "../telegram/activity.ts";
import { type BotApi, groupReactionAllowlist } from "../telegram/api.ts";
import { buildSystemPrompt, CACHE_SCHEMA_VERSION, REPLY_RECOVERY_PROMPT, sha256Short } from "./prompt.ts";
import { PromptCacheWarmer } from "./cache-warmer.ts";
import { guardModels } from "./provider-guard.ts";
import { buildBotRuntimeTools } from "./runtime-tools.ts";
import { boundedText, serializeMessageEvents, serializeMessageSegments, type MessageRow } from "./serialize.ts";
import type { RoutingTrigger, TriggerResult, TriggerSource } from "./router.ts";
import type { Decider, DeciderMedia, DeciderSlice } from "./decider.ts";

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
				| "context_window_too_small"
				| "config_write_failed"
				| "failed";
	  };
export type NewSessionResult =
	| { ok: true; epoch: number }
	| { ok: false; code: "busy" | "stopping" | "unavailable" | "failed" };
export type ManualCompactResult =
	| { ok: true; epoch: number; tokensBefore: number }
	| { ok: false; code: "busy" | "stopping" | "unavailable" | "nothing_to_compact" | "failed" };

// Only Telegram-specific state belongs here. Cursor means admitted to Pi, never "model saw it".
export const TelegramState = defineDoc<{
	admittedSeq: number;
	epoch: number;
	fingerprint: string;
	pending: Record<string, string>;
	taskSeen: number;
	/** Frozen with the context so a later description backfill cannot change the system prompt. */
	stickerCatalog: StickerCatalogSnapshot | null;
}>({
	kind: "telegram.state",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ admittedSeq: 0, epoch: 1, fingerprint: "", pending: {}, taskSeen: 0, stickerCatalog: null }),
	checkpointWhen: () => false,
});
const MAX_INPUT_CHARS = 32_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_PENDING = 64;
/** Per decider field; the decider reads only recent lines, never the bot's context. */
const DECIDER_SLICE_CHARS = 6_000;
/** Newest media of the recent lines a multimodal decider sees, and how long it may wait for them. */
const DECIDER_MAX_MEDIA = 4;
const DECIDER_MEDIA_WAIT_MS = 3_000;
const total = (parts: ContextComposition) => parts.system + parts.tools + parts.summary + parts.messages;
function pendingInput(pending: Record<string, string>, budget: number) {
	let text = "";
	const required: number[] = [];
	const entries = Object.entries(pending);
	for (const [id, value] of entries.slice(0, MAX_PENDING)) {
		const addition = `${text ? "\n" : ""}${value}`;
		if (text.length + addition.length > budget) break;
		text += addition;
		required.push(Number(id));
	}
	return { text, required };
}
const metadata = (entry: EntryRecord) =>
	entry.data as { messageId?: number; required?: number[]; phase?: string } | undefined;

export class BotRuntime {
	private harness!: Harness;
	private conversation!: Conversation;
	private tasks: TaskManager | null = null;
	private warmer: PromptCacheWarmer | null = null;
	private lastRequestMessages: readonly Message[] | null = null;
	private persona = "";
	private prompt = "";
	private toolFingerprint = "";
	private toolTokens = 0;
	/** Provider prompt tokens per locally estimated token, measured on the latest main request. */
	private tokenScale: number | null = null;
	private requestEstimate = 0;
	private stopping = false;
	private changing = false;
	private completedAt = 0;
	/** The newest ambient message still waiting for a decision. */
	private ambientPending: RoutingTrigger | null = null;
	private deciding = false;
	private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
	private lastCompact: RuntimeControlSnapshot["lastCompact"] = null;
	private reactions: ReadonlySet<string> | null = null;
	private readonly typing: TelegramTypingLease;
	readonly workBox: WorkBox | null;

	constructor(
		private readonly db: Database,
		readonly bot: BotConfig,
		private readonly config: AppConfig,
		private readonly models: ModelRuntime,
		private readonly deps: {
			api: BotApi;
			decider: Decider | null;
			videoTranscoder: boolean;
			visionExecutor?: VisionExecutor;
			visionScheduler?: VisionScheduler;
			semantic?: SemanticIndex;
		},
	) {
		this.workBox = bot.tools.sandbox && config.sandbox ? new WorkBox(config.sandbox) : null;
		this.typing = new TelegramTypingLease((signal) => deps.api.sendChatAction(config.groupChatId, signal));
	}

	async init(): Promise<void> {
		if (this.contextWindow() <= 16_384) throw new Error("main model context window must exceed 16384 tokens");
		await this.workBox?.ensure();
		await ensureStickerCatalog(this.db, this.deps.api, this.bot.stickerSets);
		this.reactions = await this.deps.api
			.getChat(this.config.groupChatId)
			.then(groupReactionAllowlist)
			.catch(() => null);
		const registry = createRegistry();
		const tools = await buildBotRuntimeTools({
			db: this.db,
			bot: this.bot,
			config: this.config,
			...this.deps,
			box: this.workBox,
			harness: () => this.harness,
			conversation: () => this.conversation,
			allowedReactions: () => this.reactions,
			currentMessage: (_api, ctx) => this.currentMessage(ctx),
			recordSend: (ctx) => this.recordSend(ctx),
			recordEvent: (kind) => log.info("agent", kind),
			resetBox: (reason) => this.resetBox(reason),
		});
		this.tasks = tools.tasks;
		for (const extension of tools.extensions) registry.install(extension);
		registry.install(
			defineExtension({
				name: "telegram-policy",
				hooks: [
					hook(GenerationTask, {
						beforeRequest: async (request, api, ctx) => {
							if (api.conversationId !== this.conversation.id) return;
							this.warmer?.stop();
							this.typing.start();
							await this.admitTaskReplies(ctx);
							const { entries } = await this.conversation.context(ctx);
							this.requestEstimate = total(this.estimateComposition(entries));
							const messages = projectStickerNotes(request.messages, entries);
							this.lastRequestMessages = messages;
							return { messages };
						},
						afterResponse: async (message, api, ctx) => {
							if (api.conversationId !== this.conversation.id) return;
							const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
							if (message.stopReason === "error" || message.stopReason === "aborted") {
								this.typing.stop();
							} else {
								if (this.requestEstimate) this.tokenScale = promptTokens / this.requestEstimate;
								const model = this.models.getModel(message.provider, message.model);
								if (model && this.lastRequestMessages) {
									const sessionId = (await this.harness.snapshot(ProviderDoc, this.conversation.id, ctx))?.sessionId;
									this.warmer?.start({
										model,
										messages: this.lastRequestMessages,
										promptTokens,
										options: {
											cacheRetention: this.bot.cacheRetention,
											timeoutMs: this.bot.providerTimeoutMs,
											...(this.bot.reasoningEffort === "off" ? {} : { reasoning: this.bot.reasoningEffort }),
											...(sessionId ? { sessionId } : {}),
										},
									});
								}
							}
							log.info("agent", "response", {
								outcome: message.stopReason,
								input_tokens: message.usage.input,
								output_tokens: message.usage.output,
								cache_read: message.usage.cacheRead,
							});
						},
						onYield: (_answer, api, ctx) =>
							api.conversationId === this.conversation.id ? this.repairReply(ctx) : undefined,
						afterRun: (_run, api) => {
							if (api.conversationId === this.conversation.id) {
								this.typing.stop();
								this.completedAt = Date.now();
								this.wakeAmbient();
							}
							return undefined;
						},
					}),
				],
			}),
		);
		const directory = join(this.config.dataDir, "pi");
		mkdirSync(directory, { recursive: true });
		const guardedModels = guardModels(this.models, () => ({
			timeoutMs: this.bot.providerTimeoutMs,
			contextWindow: this.contextWindow(),
		}));
		this.warmer = new PromptCacheWarmer({
			models: guardedModels,
			phase: async () => {
				if (this.stopping || this.changing) return undefined;
				const live = await this.harness.snapshot(LiveDoc, this.conversation.id, context);
				if (live?.compactions?.length) return undefined;
				return live?.run ? "streaming" : "idle";
			},
			recordUsage: async (message) => {
				await this.conversation.commit(async (tx) => {
					const usage = await tx.doc(UsageDoc, this.conversation.id);
					const key = `${message.provider}/${message.model}`;
					const current = usage.models[key];
					if (!current) {
						usage.models[key] = { ...message.usage, cost: { ...message.usage.cost } };
						return;
					}
					current.input += message.usage.input;
					current.output += message.usage.output;
					current.cacheRead += message.usage.cacheRead;
					current.cacheWrite += message.usage.cacheWrite;
					current.totalTokens += message.usage.totalTokens;
					current.cost.input += message.usage.cost.input;
					current.cost.output += message.usage.cost.output;
					current.cost.cacheRead += message.usage.cost.cacheRead;
					current.cost.cacheWrite += message.usage.cost.cacheWrite;
					current.cost.total += message.usage.cost.total;
				}, context);
			},
		});
		this.harness = await Harness.open(
			await openNodeSqliteStorage(join(directory, "agent.sqlite")),
			{
				models: guardedModels,
				registry,
				env: () => this.workBox?.env,
				settings: () => ({
					stream: { cacheRetention: this.bot.cacheRetention, timeoutMs: this.bot.providerTimeoutMs, maxRetries: 0 },
					retry: { enabled: this.bot.providerRetries > 0, maxRetries: this.bot.providerRetries, baseDelayMs: 10_000 },
					compaction: {
						enabled: true,
						reserveTokens: 16_384,
						keepRecentTokens: Math.min(this.bot.compactionKeepRecent, Math.floor((this.contextWindow() - 16_384) / 2)),
						backgroundTokens: 0,
					},
					afterFailedRun: "continue",
					steeringMode: "all",
					followUpMode: "all",
				}),
				onReport: () => log.error("agent", "pi_runtime_failure"),
			},
			context,
		);
		this.conversation = await this.harness.root(context);
		if (!(await this.state())) {
			await this.conversation.commit(async (tx) => {
				const state = await tx.doc(TelegramState, this.conversation.id);
				state.admittedSeq = messageEventHighWater(this.db, this.config.groupChatId);
			}, context);
		}
		this.persona = readFileSync(this.bot.personaPath, "utf8");
		await this.refreshPrompt(false);
		const toolDeclarations = JSON.stringify(
			registry
				.snapshot()
				.tools()
				.map(({ tool }) => [tool.name, tool.description, tool.parameters]),
		);
		this.toolFingerprint = sha256Short(toolDeclarations);
		this.toolTokens = estimateTextTokens(toolDeclarations);
		const fingerprint = this.contextFingerprint(this.bot);
		const state = (await this.state())!;
		if (state.fingerprint && state.fingerprint !== fingerprint) await this.reset(false);
		await this.configureModel(this.bot);
		this.harness.resume();
	}

	/** Catalog descriptions refresh only when the context restarts anyway; otherwise a restart would reset it. */
	private async refreshPrompt(force: boolean): Promise<void> {
		const current = stickerCatalogSnapshot(this.db, this.bot.stickerSets);
		const catalog = await this.conversation.commit(async (tx) => {
			const state = await tx.doc(TelegramState, this.conversation.id);
			if (force || state.stickerCatalog?.ids !== current.ids) state.stickerCatalog = current;
			return state.stickerCatalog!.block;
		}, context);
		this.prompt = buildSystemPrompt(this.persona, this.bot.tools, catalog);
	}

	private state() {
		return this.harness.snapshot(TelegramState, this.conversation.id, context);
	}
	private contextWindow() {
		return Math.min(
			this.models.getModel(this.bot.provider, this.bot.model)?.contextWindow ?? this.config.contextWindow,
			this.config.contextWindow,
			this.bot.compactionThreshold + 16_384,
		);
	}
	private contextFingerprint(selection: ModelControlSelection): string {
		return sha256Short(
			JSON.stringify([
				CACHE_SCHEMA_VERSION,
				"pi-1.5.2",
				selection.provider,
				selection.model,
				selection.reasoningEffort,
				this.bot.name,
				this.bot.cacheRetention,
				this.config.media.mode,
				this.bot.tools,
				this.config.tasks,
				this.config.sandbox,
				this.prompt,
				this.toolFingerprint,
			]),
		);
	}
	private async configureModel(selection: ModelControlSelection): Promise<void> {
		await this.conversation.commit(async (tx) => {
			await configure(tx, this.conversation.id, {
				model: { provider: selection.provider, modelId: selection.model },
				thinkingLevel: selection.reasoningEffort,
				instructions: this.prompt,
				cwd: "/work",
			});
			(await tx.doc(TelegramState, this.conversation.id)).fingerprint = this.contextFingerprint(selection);
		}, context);
	}
	async admittedThrough(): Promise<number> {
		return (await this.state())!.admittedSeq;
	}

	async samplingState(): Promise<RuntimeControlSnapshot["state"]> {
		if (this.stopping) return "stopping";
		const live = await this.harness.snapshot(LiveDoc, this.conversation.id, context);
		if (this.changing || live?.run) return "busy";
		if (live?.compactions?.length) return "compacting";
		return Date.now() - this.completedAt < this.bot.cooldownMs ? "cooldown" : "idle";
	}

	/** Re-judge the newest ambient message once the turn or the cooldown it waited for is over. */
	private wakeAmbient(): void {
		const pending = this.ambientPending;
		if (!pending) return;
		this.ambientPending = null;
		void this.trigger("ambient", pending).catch(() =>
			log.warn("routing", "ambient_retry_failed", { category: "local_failure" }),
		);
	}

	/** Ambient messages wait out a running turn, its cooldown and an in-flight decision. */
	private async ambientGate(trigger: RoutingTrigger): Promise<TriggerResult | null> {
		const status = await this.samplingState();
		if (status === "stopping") return "skipped_stopping";
		if (status !== "idle" || this.deciding) {
			this.ambientPending = trigger;
			if (status === "cooldown" && !this.cooldownTimer) {
				this.cooldownTimer = setTimeout(
					() => {
						this.cooldownTimer = null;
						this.wakeAmbient();
					},
					this.bot.cooldownMs - (Date.now() - this.completedAt),
				);
				this.cooldownTimer.unref();
			}
			return status === "cooldown" ? "skipped_cooldown" : "skipped_busy";
		}
		if (!this.deps.decider) return null;
		this.deciding = true;
		let probability: number | null;
		try {
			probability = await this.deps.decider.decide(await this.deciderSlice(this.deps.decider.seesImages));
		} finally {
			this.deciding = false;
		}
		log.info("routing", "decider", { message_id: trigger.messageId, probability });
		// A failed decision answers like no decider at all: the message gets its turn.
		if (probability == null || probability >= this.bot.decider!.threshold) return null;
		// Messages that arrived during the decision were not part of the slice.
		this.wakeAmbient();
		return "declined";
	}

	/** The unadmitted lines, after a few admitted ones for context; images of recent media on request. */
	private async deciderSlice(withMedia: boolean): Promise<DeciderSlice> {
		const admitted = (await this.state())!.admittedSeq;
		const high = messageEventHighWater(this.db, this.config.groupChatId);
		const events = (from: number, through: number, limit: number) =>
			listRecentMessageEvents(this.db, this.config.groupChatId, from, through, limit).filter(
				(event) => event.kind === "message" && !this.isControl(event.messageId),
			);
		// The newest lines matter most, so an oversized slice keeps its tail.
		const render = (list: MessageEvent[]) =>
			serializeMessageEvents(this.db, list, MAX_MESSAGE_CHARS).slice(-DECIDER_SLICE_CHARS);
		const recent = events(admitted, high, 40);
		return {
			earlier: render(events(0, admitted, 6)),
			recent: render(recent),
			media: withMedia ? await this.deciderMedia(recent) : [],
		};
	}

	/** Images the decider can use within a short wait; media that is not ready stays a text placeholder. */
	private async deciderMedia(events: MessageEvent[]): Promise<DeciderMedia[]> {
		const wanted = events
			.flatMap((event) => {
				const media = (event.payload as MessageRow).media;
				if (!media) return [];
				const parsed = JSON.parse(media) as { kind?: string; file_unique_id?: unknown };
				return parsed.file_unique_id
					? [{ messageId: event.messageId, kind: parsed.kind ?? "media", id: String(parsed.file_unique_id) }]
					: [];
			})
			.slice(-DECIDER_MAX_MEDIA);
		if (wanted.length === 0) return [];
		const signal = AbortSignal.timeout(DECIDER_MEDIA_WAIT_MS);
		const options = {
			cacheDir: join(this.config.dataDir, "media"),
			videoTranscoder: this.deps.videoTranscoder,
			signal,
		};
		const late = new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }));
		const settled = await Promise.all(
			wanted.map((item) =>
				Promise.race([prepareMediaImages(this.db, this.deps.api, item.id, options).catch(() => null), late]),
			),
		);
		return wanted.flatMap((item, index) => {
			const prepared = settled[index];
			if (!prepared?.ok) return [];
			return [{ messageId: item.messageId, kind: item.kind, images: prepared.images }];
		});
	}

	async trigger(source: TriggerSource, trigger: RoutingTrigger): Promise<TriggerResult> {
		if (this.stopping || this.changing) return "skipped_stopping";
		if (source === "ambient") {
			const gated = await this.ambientGate(trigger);
			if (gated) return gated;
		}
		if (this.stopping || this.changing) return "skipped_stopping";
		const epoch = (await this.state())!.epoch;
		await this.prepareVision();
		const requestId = `telegram:${trigger.chatId}:${trigger.messageId}`;
		const result = await this.conversation.commit(async (tx): Promise<TriggerResult> => {
			const state = await tx.doc(TelegramState, this.conversation.id);
			if (this.stopping || this.changing || state.epoch !== epoch) return "skipped_stopping";
			const live = await tx.doc(LiveDoc, this.conversation.id);
			// A turn started while the decider ran; this message waits for it to finish.
			if (source === "ambient" && (live.run || live.compactions?.length)) {
				this.ambientPending = trigger;
				return "skipped_busy";
			}
			const accepted = live.run ? "coalesced" : "started";
			if (await tx.submissionByRequest(this.conversation.id, requestId)) return accepted;
			const high = messageEventHighWater(this.db, this.config.groupChatId);
			const events = listRecentMessageEvents(this.db, this.config.groupChatId, state.admittedSeq, high, 256).filter(
				(event) => !this.isControl(event.messageId),
			);
			const row = groupMessage(this.db, this.config.groupChatId, trigger.messageId);
			if (!row) return "skipped_stopping";
			const current: MessageEvent = {
				ingestSeq: high,
				chatId: trigger.chatId,
				messageId: trigger.messageId,
				revision: 0,
				kind: "message",
				eventDate: row.date,
				payload: row,
			};
			const currentSize = serializeMessageEvents(this.db, [current], MAX_MESSAGE_CHARS).length;
			const currentIsPending =
				state.pending[String(trigger.messageId)] != null || (this.bot.tools.send && source === "direct");
			const pending = pendingInput(
				Object.fromEntries(Object.entries(state.pending).filter(([id]) => Number(id) !== trigger.messageId)),
				MAX_INPUT_CHARS - currentSize - 16,
			);
			const required = currentIsPending ? [trigger.messageId, ...pending.required] : pending.required;
			const owed = pending.text ? `〔待回应〕\n${pending.text}` : "";
			const selected = [current];
			let remaining = MAX_INPUT_CHARS - currentSize - owed.length - 2;
			const included = new Set([trigger.messageId, ...required]);
			for (const event of [...events].reverse()) {
				if (event.kind === "message" && included.has(event.messageId)) continue;
				const size = serializeMessageEvents(this.db, [event], MAX_MESSAGE_CHARS).length;
				if (size + 1 > remaining) continue;
				selected.unshift(event);
				remaining -= size + 1;
				if (event.kind === "message") included.add(event.messageId);
			}
			// Serialize the admitted batch once: parent visibility and date separators span every event.
			const segments = serializeMessageSegments(this.db, selected, MAX_MESSAGE_CHARS);
			if (currentIsPending) state.pending[String(trigger.messageId)] = segments.at(-1)!.text;
			const content = [segments.map((segment) => segment.text).join("\n"), owed].filter(Boolean).join("\n\n");
			const stickerNote = boundedText(
				batchStickerCandidates(
					this.db,
					this.config.groupChatId,
					[
						...new Set([
							...selected
								.filter((event) => event.kind === "message" || event.kind === "edit")
								.map((event) => event.messageId),
							...required,
						]),
					],
					this.bot.stickerSets,
				),
				Math.min(MAX_MESSAGE_CHARS, MAX_INPUT_CHARS - content.length),
			);
			await this.conversation.submit(tx, {
				type: "input",
				requestId,
				content,
				whenBusy: "steer",
				entry: {
					kind: "telegram.input",
					data: { messageId: trigger.messageId, required, through: high, stickerNote },
				},
			});
			state.admittedSeq = high;
			return accepted;
		}, context);
		// The admitted batch already carries every message up to this one.
		if ((result === "started" || result === "coalesced") && (this.ambientPending?.messageId ?? 0) <= trigger.messageId)
			this.ambientPending = null;
		return result;
	}

	private isControl(id: number): boolean {
		return !!this.db
			.prepare("SELECT 1 FROM telegram_control_messages WHERE chat_id = ? AND message_id = ?")
			.get(this.config.groupChatId, id);
	}

	private async prepareVision(): Promise<void> {
		if (!this.deps.visionExecutor || this.config.media.maxPerTurn === 0) return;
		const high = messageEventHighWater(this.db, this.config.groupChatId);
		const events = listRecentMessageEvents(
			this.db,
			this.config.groupChatId,
			(await this.state())!.admittedSeq,
			high,
			256,
		);
		const ids = [
			...new Set(
				events
					.flatMap((event) => {
						const media = (event.payload as MessageRow).media;
						return media ? [String(JSON.parse(media).file_unique_id ?? "")] : [];
					})
					.filter(Boolean),
			),
		].slice(-this.config.media.maxPerTurn);
		const work = Promise.allSettled(
			ids.map((id) =>
				ensureVision(this.db, this.deps.api, id, this.deps.visionExecutor!, {
					cacheDir: join(this.config.dataDir, "media"),
					videoTranscoder: this.deps.videoTranscoder,
					scheduler: this.deps.visionScheduler,
				}),
			),
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			work,
			new Promise((resolve) => {
				timer = setTimeout(resolve, 2500);
			}),
		]);
		clearTimeout(timer);
	}

	private async currentMessage(ctx: Context): Promise<number | null> {
		const entries = (await this.conversation.context(ctx)).entries;
		return (
			[...entries]
				.reverse()
				.map((entry) => metadata(entry)?.messageId)
				.find((id) => id != null) ?? null
		);
	}

	private async admitTaskReplies(ctx: Context): Promise<void> {
		const entries = (await this.conversation.context(ctx)).entries;
		await this.conversation.commit(async (tx) => {
			const state = await tx.doc(TelegramState, this.conversation.id);
			for (const entry of entries) {
				if (entry.kind !== "telegram.task" || entry.id <= state.taskSeen) continue;
				state.taskSeen = entry.id;
				const data = metadata(entry);
				if (!data?.messageId || data.phase === "progress") continue;
				const message = entry.model?.[0];
				const text = message ? contentText(message.content) : "";
				state.pending[String(data.messageId)] = boundedText(text, MAX_MESSAGE_CHARS);
			}
		}, ctx);
	}

	private async recordSend(ctx: Context): Promise<void> {
		await this.conversation.commit(async (tx) => {
			const state = await tx.doc(TelegramState, this.conversation.id);
			const inbox = await tx.doc(InboxDoc, this.conversation.id);
			const queued = new Set(
				inbox.items.flatMap((item) => {
					if (item.mode === "write") return [];
					const id = (item.entry?.data as { messageId?: number } | undefined)?.messageId;
					return id == null ? [] : [String(id)];
				}),
			);
			for (const id of Object.keys(state.pending)) {
				if (!queued.has(id)) delete state.pending[id];
			}
		}, ctx);
	}

	private async repairReply(ctx: Context) {
		if (!this.bot.tools.send) return;
		const entries = (await this.conversation.context(ctx)).entries;
		const input = entries.findLastIndex((entry) => entry.kind.startsWith("telegram."));
		if (
			input < 0 ||
			entries
				.slice(input + 1)
				.some(
					(entry) =>
						entry.kind === "pi.user" &&
						entry.model?.some((message) => contentText(message.content).startsWith(REPLY_RECOVERY_PROMPT)),
				)
		)
			return;
		const pending = pendingInput((await this.state())!.pending, MAX_INPUT_CHARS - REPLY_RECOVERY_PROMPT.length - 1);
		if (pending.text) return { continue: `${REPLY_RECOVERY_PROMPT}\n${pending.text}` };
	}

	async controlSnapshot(): Promise<RuntimeControlSnapshot> {
		const state = (await this.state())!;
		const view = await this.conversation.context(context);
		return {
			state: await this.samplingState(),
			epoch: state.epoch,
			provider: this.bot.provider,
			model: this.bot.model,
			reasoningEffort: this.bot.reasoningEffort,
			contextWindow: this.contextWindow(),
			currentContextTokens: estimateContextTokens(view.messages).tokens,
			context: this.contextComposition(view.entries),
			cooldownMs: this.bot.cooldownMs,
			decider: this.bot.decider,
			lastCompact: this.lastCompact,
			usage: await this.harness.usage(context),
		};
	}

	/** Local estimates per part, calibrated by the provider's count once a request has reported one. */
	private contextComposition(entries: readonly EntryRecord[]): ContextComposition {
		const parts = this.estimateComposition(entries);
		const scale = this.tokenScale ?? 1;
		return {
			system: Math.round(parts.system * scale),
			tools: Math.round(parts.tools * scale),
			summary: Math.round(parts.summary * scale),
			messages: Math.round(parts.messages * scale),
		};
	}

	private estimateComposition(entries: readonly EntryRecord[]): ContextComposition {
		const parts: ContextComposition = { system: 0, tools: this.toolTokens, summary: 0, messages: 0 };
		for (const entry of entries)
			for (const message of entry.model ?? []) {
				const tokens = estimateMessageTokens(message);
				if (message.role === "system") parts.system += tokens;
				else if (entry.kind === "pi.compaction") parts.summary += tokens;
				else parts.messages += tokens;
			}
		return parts;
	}

	async compactForControl(): Promise<ManualCompactResult> {
		if (this.stopping || this.changing) return { ok: false, code: "stopping" };
		const live = await this.harness.snapshot(LiveDoc, this.conversation.id, context);
		if (live?.run || live?.compactions?.length) return { ok: false, code: "busy" };
		const tokensBefore = estimateContextTokens((await this.conversation.context(context)).messages).tokens;
		const result = await this.harness.waitForTask(await this.conversation.compact(undefined, context), context);
		const outcome = result.state.outcome;
		const summary = outcome.status === "completed" ? outcome.result : undefined;
		if (summary && summary.entryId == null && summary.submissionId == null)
			return { ok: false, code: "nothing_to_compact" };
		const placement =
			summary?.submissionId == null
				? undefined
				: await (await this.harness.submission(summary.submissionId, context))!.wait(context);
		const ok = summary?.entryId != null || placement?.status === "done";
		this.lastCompact = { at: Date.now(), outcome: ok ? "ok" : "failed" };
		return ok ? { ok: true, epoch: (await this.state())!.epoch, tokensBefore } : { ok: false, code: "failed" };
	}

	private async reset(workspace: boolean): Promise<number> {
		this.warmer?.stop();
		this.lastRequestMessages = null;
		await this.conversation.abort(context, { background: true });
		await this.tasks?.clear();
		this.typing.stop();
		await this.conversation.reset(undefined, context);
		this.tokenScale = null; // the next model may tokenize differently
		const epoch = await this.conversation.commit(async (tx) => {
			const state = await tx.doc(TelegramState, this.conversation.id);
			state.epoch++;
			state.pending = {};
			state.admittedSeq = messageEventHighWater(this.db, this.config.groupChatId);
			return state.epoch;
		}, context);
		await this.refreshPrompt(true);
		if (workspace) await this.workBox?.reset();
		return epoch;
	}

	async newSessionForControl(): Promise<NewSessionResult> {
		if (this.stopping) return { ok: false, code: "stopping" };
		if (this.changing) return { ok: false, code: "busy" };
		this.changing = true;
		try {
			const epoch = await this.reset(true);
			await this.configureModel(this.bot);
			return { ok: true, epoch };
		} catch {
			return { ok: false, code: "failed" };
		} finally {
			this.changing = false;
		}
	}

	async changeModelForControl(
		provider: string,
		modelId: string,
		persist: (selection: ModelControlSelection) => { finalize(): void; rollback(): void },
	): Promise<ModelControlResult> {
		if (this.stopping) return { ok: false, code: "stopping" };
		if (this.changing) return { ok: false, code: "busy" };
		const model = this.models.getModel(provider, modelId);
		if (!model) return { ok: false, code: "unknown_model" };
		if (model.contextWindow <= 16_384) return { ok: false, code: "context_window_too_small" };
		if (!this.models.hasConfiguredAuth(provider)) return { ok: false, code: "unauthenticated_provider" };
		if (this.config.media.mode === "hybrid" && !model.input.includes("image"))
			return { ok: false, code: "image_input_unsupported" };
		const selection = {
			provider,
			model: modelId,
			reasoningEffort: clampThinkingLevel(model, this.bot.reasoningEffort),
		};
		const previous = { provider: this.bot.provider, model: this.bot.model, reasoningEffort: this.bot.reasoningEffort };
		this.changing = true;
		let write: ReturnType<typeof persist> | undefined;
		let configured = false;
		try {
			const live = await this.harness.snapshot(LiveDoc, this.conversation.id, context);
			if (live?.run || live?.compactions?.length) return { ok: false, code: "busy" };
			write = persist(selection);
			const epoch = await this.reset(false);
			await this.configureModel(selection);
			configured = true;
			write.finalize();
			Object.assign(this.bot, selection);
			return { ok: true, epoch, reasoningEffort: selection.reasoningEffort };
		} catch {
			try {
				write?.rollback();
			} finally {
				if (configured) await this.configureModel(previous);
			}
			return { ok: false, code: write ? "failed" : "config_write_failed" };
		} finally {
			this.changing = false;
		}
	}

	async taskStatusForControl(): Promise<string | null> {
		return this.tasks?.describe() ?? null;
	}
	async cancelTaskForControl(id: string): Promise<{ ok: true } | { ok: false; code: "unavailable" | "unknown_task" }> {
		return this.tasks && (await this.tasks.cancel(id))
			? { ok: true }
			: { ok: false, code: this.tasks ? "unknown_task" : "unavailable" };
	}
	async tasksBusy(): Promise<boolean> {
		return this.tasks?.busy() ?? false;
	}
	async resetBoxForControl(): Promise<{ ok: true } | { ok: false; code: "unavailable" | "failed" }> {
		if (!this.workBox) return { ok: false, code: "unavailable" };
		try {
			await this.resetBox("admin");
			return { ok: true };
		} catch {
			return { ok: false, code: "failed" };
		}
	}
	async resetBox(reason: "tool" | "weekly" | "admin"): Promise<void> {
		if (!this.workBox) return;
		if (reason !== "tool" && this.changing) throw new Error("session change in progress");
		if (reason !== "tool") this.changing = true;
		try {
			if (reason !== "tool") {
				await this.conversation.abort(context, { background: true });
				await this.tasks?.clear();
			}
			await this.workBox.reset();
			appendNoteEvent(this.db, this.config.groupChatId, 0, `box:${Date.now()}`, {
				source: "system",
				text: "工作区已清空。",
			});
		} finally {
			if (reason !== "tool") this.changing = false;
		}
	}
	async stop(): Promise<void> {
		this.stopping = true;
		this.warmer?.stop();
		this.typing.stop();
		if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
		try {
			await this.harness?.close(context);
		} finally {
			await this.workBox?.interrupt();
		}
	}
}
