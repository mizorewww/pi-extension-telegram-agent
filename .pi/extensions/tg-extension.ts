import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { loadConfig, type BotConfig } from "../../src/config.ts";
import type {
	AgentActivity,
	AgentActivityAssistantSection,
	AgentActivityEventSection,
	AgentStreamFrame,
	BotStats,
	EvtItem,
	MsgItem,
	RuntimeControlSnapshot,
	TimelineItem,
} from "../../src/ipc.ts";
import { buildBotStatusView, formatUsdCost, renderBotStatusPlain } from "../../src/observability/status.ts";
import { summarizeBotUsage } from "../../src/observability/usage.ts";
import { sanitize } from "../../src/sanitize.ts";
import {
	itemKey,
	readMediaImage,
	TimelineClient,
	type MediaImage,
	type TimelineEvent,
	type TimelineHooks,
} from "../../src/plugin/timeline.ts";

const ENTRY_TYPE = "telegram-chat";
const FEED_WIDGET_KEY = "telegram-feed";
const STATUS_KEY = "telegram";
const MAX_ACTIVE_STREAMS = 32;
const MAX_ENDED_STREAMS = 64;

const IDENTITY_COLORS = [
	"accent",
	"syntaxFunction",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxKeyword",
	"syntaxVariable",
	"mdLink",
] as const satisfies readonly ThemeColor[];

type TimelineFactory = (filter: string | null, hooks: TimelineHooks) => TimelineClient;
type FeedEntry = { instanceId: string; filter: string | null };
type ToolPresentationHost = { ui: Tui.TUI; cwd: string };
type StatusModel = Pick<NonNullable<ExtensionContext["model"]>, "id" | "provider" | "contextWindow" | "reasoning">;
type StatusBot = Pick<
	BotConfig,
	"id" | "name" | "provider" | "model" | "reasoningEffort" | "routingP" | "samplingCooldownMs"
>;
type StatusHost = {
	modelRegistry: { getAvailable(): readonly StatusModel[] };
	model: StatusModel | undefined;
	thinkingLevel?: ExtensionContext["thinkingLevel"];
};

type TgCommandDispatch = "attach" | "more" | "detach" | "status";

/** Every /tg subcommand; `bot` names its single optional trailing argument. */
const TG_COMMANDS: Record<TgCommandDispatch, { description: string; bot?: "bot" }> = {
	attach: { description: "Open all bots or one bot for chat", bot: "bot" },
	more: { description: "Load one older history page" },
	detach: { description: "Disconnect the live feed" },
	status: { description: "Show detailed usage", bot: "bot" },
};

function formatTgHelp(): string {
	const syntax = Object.entries(TG_COMMANDS).map(([token, command]) =>
		command.bot ? `${token} [${command.bot}]` : token,
	);
	return `usage: /tg ${syntax.join(" | ")}`;
}

function completeTgArguments(
	argumentPrefix: string,
	bots: readonly Pick<BotConfig, "id" | "name">[],
): { value: string; label: string; description?: string }[] | null {
	const tokens = argumentPrefix.trimStart().split(/\s+/);
	const command = tokens.length === 2 ? TG_COMMANDS[tokens[0] as TgCommandDispatch] : undefined;
	const candidates =
		tokens.length === 1
			? Object.entries(TG_COMMANDS).map(([token, { description }]) => ({ token, label: token, description }))
			: command?.bot
				? bots.map((bot) => ({
						token: bot.id,
						label: bot.name === bot.id ? bot.id : `${bot.id} (${bot.name})`,
						description: `Telegram bot ${bot.name}`,
					}))
				: [];
	const partial = tokens.at(-1)!.toLocaleLowerCase("en");
	const matches = candidates.filter((candidate) => candidate.token.toLocaleLowerCase("en").startsWith(partial));
	if (matches.length === 0) return null;
	const prefix = tokens.length === 2 ? `${tokens[0]} ` : "";
	return matches.map(({ token, label, description }) => ({ value: `${prefix}${token}`, label, description }));
}

type ParsedTgCommand =
	| { ok: true; dispatch: TgCommandDispatch; arguments: string[] }
	| { ok: false; reason: "empty" | "unknown" | "extra" };

/** An unknown bot argument is passed through so the handler can name the configured bots. */
function parseTgArguments(input: string): ParsedTgCommand {
	const tokens = input.trim() ? input.trim().split(/\s+/) : [];
	if (tokens.length === 0) return { ok: false, reason: "empty" };
	const dispatch = tokens[0] as TgCommandDispatch;
	const command = Object.hasOwn(TG_COMMANDS, dispatch) ? TG_COMMANDS[dispatch] : undefined;
	if (!command) return { ok: false, reason: "unknown" };
	if (tokens.length > (command.bot ? 2 : 1)) return { ok: false, reason: "extra" };
	return { ok: true, dispatch, arguments: tokens.slice(1) };
}

/** One-line attached-feed chrome. */
function telegramFeedHeaderLine(width: number, theme: Pick<Theme, "fg" | "bold">, scope: string): string {
	if (width <= 0) return "";
	const text =
		`${theme.bold(theme.fg("accent", "Telegram"))}${theme.fg("dim", ` · ${sanitize(scope)} · `)}` +
		`${theme.fg("success", "attached")}${theme.fg("dim", " · /tg more · /tg detach")}`;
	return Tui.truncateToWidth(` ${text}`, width, theme.fg("dim", "..."));
}

function fmtClock(ts: number): string {
	return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}

function fmtDay(ts: number): string {
	const date = new Date(ts);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function identityColor(identity: string): ThemeColor {
	let hash = 0x811c9dc5;
	for (let index = 0; index < identity.length; index++) {
		hash ^= identity.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return IDENTITY_COLORS[(hash >>> 0) % IDENTITY_COLORS.length]!;
}

function resolveStatusModel(
	bot: StatusBot | undefined,
	status: RuntimeControlSnapshot | undefined,
	host: StatusHost,
): StatusModel | undefined {
	if (!bot && !status) return host.model;
	const provider = status?.provider ?? bot?.provider;
	const modelId = status?.model ?? bot?.model;
	const configured = host.modelRegistry
		.getAvailable()
		.find((model) => model.provider === provider && model.id === modelId);
	if (configured) return configured;
	const activeModel = host.model;
	if (activeModel && activeModel.provider === provider && activeModel.id === modelId) return activeModel;
	return {
		id: modelId ?? "unknown",
		provider: provider ?? "unknown",
		contextWindow: status?.contextWindow ?? 0,
		reasoning: (status?.reasoningEffort ?? bot?.reasoningEffort ?? "off") !== "off",
	};
}

export function statsText(
	botId: string,
	stats: BotStats,
	bot: StatusBot | undefined,
	status: RuntimeControlSnapshot | undefined,
	host: StatusHost,
): string {
	const model = resolveStatusModel(bot, status, host);
	const identity: StatusBot = bot ?? {
		id: botId,
		name: botId,
		provider: status?.provider ?? model?.provider ?? "unknown",
		model: status?.model ?? model?.id ?? "unknown",
		reasoningEffort: status?.reasoningEffort ?? host.thinkingLevel ?? "off",
		routingP: status?.routingP ?? 0,
		samplingCooldownMs: status?.samplingCooldownMs ?? 0,
	};
	return renderBotStatusPlain(buildBotStatusView(identity, stats, status, model?.contextWindow ?? 0));
}

function fmtTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

interface TelegramUsage {
	inputTokens: number;
	outputTokens: number;
	cacheHitPercent: number | null;
	cacheEstimated: boolean;
	cost: number;
	contextPercent: number | null;
	contextWindow: number;
	model: string;
	reasoning: boolean;
	reasoningEffort: RuntimeControlSnapshot["reasoningEffort"];
}

/** Telegram telemetry summed over the feed's bots, with the context of the latest one. */
export function telegramUsage(
	filter: string | null,
	statsByBot: Readonly<Record<string, BotStats>>,
	statuses: Readonly<Record<string, RuntimeControlSnapshot>>,
	bots: readonly StatusBot[],
	host: StatusHost,
): TelegramUsage | undefined {
	const configured = new Map(bots.map((bot) => [bot.id, bot]));
	const selected = Object.entries(statsByBot).filter(
		([botId]) => configured.has(botId) && (filter == null || botId === filter),
	);
	if (selected.length === 0) return undefined;

	const totals: BotStats = {
		runs: 0,
		contextTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cacheMiss: 0,
		estimatedCacheRuns: 0,
		outputTokens: 0,
		speedOutputTokens: 0,
		reasoningTokens: 0,
		totalLatencyMs: 0,
		latencySamples: 0,
		totalThinkingMs: 0,
		thinkingSamples: 0,
		totalSendMs: 0,
		sendSamples: 0,
		firstRunTs: null,
		cost: 0,
		epoch: 0,
		lastRunId: 0,
		last: null,
	};
	let currentBotId = filter ?? selected[0]![0];
	for (const [botId, stats] of selected) {
		totals.runs += stats.runs;
		totals.contextTokens += stats.contextTokens;
		totals.cacheRead += stats.cacheRead;
		totals.cacheWrite += stats.cacheWrite;
		totals.cacheMiss += stats.cacheMiss;
		totals.estimatedCacheRuns += stats.estimatedCacheRuns;
		totals.outputTokens += stats.outputTokens;
		totals.cost += stats.cost;
		if (
			stats.last &&
			(!totals.last ||
				stats.last.ts > totals.last.ts ||
				(stats.last.ts === totals.last.ts && stats.last.id > totals.last.id))
		) {
			totals.last = stats.last;
			currentBotId = botId;
		}
	}

	const status = statuses[currentBotId];
	const bot = configured.get(currentBotId);
	const model = resolveStatusModel(bot, status, host);
	// A compaction newer than the shown bot's latest main run means Pi's context is unknown until the
	// next main response (docs/telemetry.md: never fall back to the pre-compaction epoch).
	const shown = statsByBot[currentBotId];
	const compactedSinceLast = shown != null && shown.lastRunId > (shown.last?.id ?? 0);
	// The daemon's window is the clamped effective one (docs/telemetry.md); the catalog value
	// is only a fallback before the runtime snapshot arrives.
	const usage = summarizeBotUsage(
		totals,
		status?.contextWindow ?? model?.contextWindow ?? 0,
		compactedSinceLast ? null : undefined,
	);
	return {
		inputTokens: totals.cacheMiss,
		outputTokens: totals.outputTokens,
		cacheHitPercent: usage.cacheHitPercent,
		cacheEstimated: usage.cacheEstimated,
		cost: totals.cost,
		contextPercent: usage.context.percent,
		contextWindow: usage.context.contextWindow,
		model: model?.id ?? status?.model ?? bot?.model ?? currentBotId,
		reasoning: model?.reasoning ?? false,
		reasoningEffort: status?.reasoningEffort ?? bot?.reasoningEffort ?? "off",
	};
}

/** One Pi status-bar line with the Telegram bots' usage; Pi keeps its own footer. */
export function telegramStatusLine(usage: TelegramUsage): string {
	const approx = usage.cacheEstimated ? "≈" : "";
	const parts = [`TG ↑${approx}${fmtTokens(usage.inputTokens)} ↓${fmtTokens(usage.outputTokens)}`];
	if (usage.cacheHitPercent != null) parts.push(`CH${approx}${usage.cacheHitPercent.toFixed(1)}%`);
	if (usage.cost) parts.push(`$${formatUsdCost(usage.cost)}`);
	parts.push(
		`ctx ${usage.contextPercent == null ? "?" : `${usage.contextPercent.toFixed(1)}%`}/${fmtTokens(usage.contextWindow)}`,
	);
	parts.push(usage.reasoning ? `${usage.model} • ${usage.reasoningEffort}` : usage.model);
	return parts.join(" ");
}

function eventBody(event: EvtItem): string {
	try {
		const payload = JSON.parse(event.payload) as Record<string, unknown>;
		if (event.evtKind === "thinking") return `thinking · ${sanitize(String(payload.text ?? ""))}`;
		if (event.evtKind === "assistant_text") return sanitize(String(payload.text ?? ""));
		if (event.evtKind === "tool_call")
			return `${sanitize(String(payload.tool ?? "tool"))} · ${sanitize(JSON.stringify(payload.args ?? {})).slice(0, 180)}`;
		if (event.evtKind === "note") {
			const label =
				payload.source === "system"
					? "系统"
					: `task ${sanitize(String(payload.task_id ?? ""))} ${sanitize(String(payload.phase ?? ""))}`;
			return `[${label}] ${sanitize(String(payload.text ?? "")).slice(0, 400)}`;
		}
		if (event.evtKind === "tool_result")
			return `${sanitize(String(payload.tool ?? "tool"))} · ${payload.isError ? "error" : "done"}`;
		return `${sanitize(event.evtKind)} · ${sanitize(event.payload).slice(0, 240)}`;
	} catch {
		return sanitize(event.evtKind);
	}
}

function activityEventPayload(section: AgentActivityEventSection): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(section.detail) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function activityEventBody(section: AgentActivityEventSection, payload = activityEventPayload(section)): string {
	if (!payload) return `${sanitize(section.kind)} · ${sanitize(section.detail)}`;
	const tool = sanitize(String(payload.tool ?? "tool"));
	if (section.kind === "tool_call") return `${tool} · ${sanitize(JSON.stringify(payload.args ?? {}))}`;
	if (section.kind === "tool_result") return `${tool} · ${payload.isError ? "error" : "done"}`;
	if (section.kind === "markdown_sent") return `markdown sent · #${sanitize(String(payload.message_id ?? "?"))}`;
	if (section.kind === "plain_fallback") return `plain fallback · #${sanitize(String(payload.message_id ?? "?"))}`;
	if (section.kind === "send") {
		const sent = Array.isArray(payload.sent) ? payload.sent.map((id) => `#${sanitize(String(id))}`).join(", ") : "";
		return `sent${sent ? ` · ${sent}` : ""}`;
	}
	if (section.kind === "send_degraded") return `send degraded · ${sanitize(String(payload.outcome ?? "unknown"))}`;
	return `${sanitize(section.kind.replaceAll("_", " "))} · ${sanitize(section.detail)}`;
}

function nativeAssistantSection(section: AgentActivityAssistantSection, ts: number): AssistantMessageComponent {
	const message = {
		role: "assistant",
		content: section.content.map((content) =>
			content.type === "text"
				? { type: "text" as const, text: sanitize(content.text) }
				: { type: "thinking" as const, thinking: sanitize(content.thinking) },
		),
		api: "openai-completions",
		provider: "telegram",
		model: "telegram-activity",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: section.stopReason,
		timestamp: ts,
	} satisfies AssistantMessage;
	return new AssistantMessageComponent(message, false);
}

/** One Pi-native assistant/tool presentation for an entire daemon agent run. */
export function activityComponent(
	botId: string,
	botName: string,
	activity: AgentActivity,
	theme: Theme,
	status = "Activity",
	toolHost?: ToolPresentationHost,
): Tui.Component {
	const box = new Tui.Box(1, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(
		cardHeader(botName, `bot ${botId} · ${status} · ${fmtClock(activity.startedAt)}`, theme, identityColor(botId)),
	);
	const pendingTools = new Map<string, ToolExecutionComponent[]>();
	for (let index = 0; index < activity.sections.length; index++) {
		const section = activity.sections[index]!;
		if (section.type === "assistant") box.addChild(nativeAssistantSection(section, activity.startedAt));
		else {
			const payload = activityEventPayload(section);
			const tool = payload ? sanitize(String(payload.tool ?? "tool")) : "tool";
			if (toolHost && payload && section.kind === "tool_call") {
				const component = new ToolExecutionComponent(
					tool,
					`${activity.activityId}:${index}`,
					payload.args ?? {},
					{ showImages: false },
					undefined,
					toolHost.ui,
					toolHost.cwd,
				);
				const queue = pendingTools.get(tool) ?? [];
				queue.push(component);
				pendingTools.set(tool, queue);
				box.addChild(component);
				continue;
			}
			if (toolHost && payload && section.kind === "tool_result") {
				const component = pendingTools.get(tool)?.shift();
				if (component) {
					const isError = payload.isError === true;
					component.updateResult({
						content: isError ? [{ type: "text", text: "error" }] : [],
						isError,
					});
					continue;
				}
			}
			const color: ThemeColor =
				section.kind === "send_degraded"
					? "error"
					: section.kind === "send" || section.kind === "markdown_sent" || section.kind === "plain_fallback"
						? "success"
						: "muted";
			box.addChild(new Tui.Text(theme.fg(color, activityEventBody(section, payload)), 0, 0));
		}
	}
	if (activity.truncated) box.addChild(new Tui.Text(theme.fg("warning", "activity display truncated"), 0, 0));
	return box;
}

function parsedActivity(event: EvtItem): AgentActivity | null {
	if (event.evtKind !== "agent_activity") return null;
	try {
		const value = JSON.parse(event.payload) as Partial<AgentActivity>;
		if (value.version !== 1 || typeof value.activityId !== "string" || !Array.isArray(value.sections)) return null;
		return {
			version: 1,
			activityId: value.activityId,
			startedAt: typeof value.startedAt === "number" ? value.startedAt : event.ts,
			sections: value.sections as AgentActivity["sections"],
			truncated: value.truncated === true,
		};
	} catch {
		return null;
	}
}

function cardHeader(identity: string, metadata: string, theme: Theme, color: ThemeColor): Tui.Component {
	const left = theme.bold(theme.fg(color, sanitize(identity))),
		right = theme.fg("dim", metadata);
	return new Tui.HStack(
		[
			{ component: new Tui.TruncatedText(left), basis: Tui.visibleWidth(left), grow: 1, minSize: 8 },
			{ component: new Tui.TruncatedText(right), basis: Tui.visibleWidth(right), minSize: 12 },
		],
		{ gap: 2 },
	);
}

type MediaImageResolver = (item: MsgItem) => MediaImage | null;

export function itemComponent(
	item: TimelineItem,
	theme: Theme,
	resolveMedia: MediaImageResolver = readMediaImage,
	toolHost?: ToolPresentationHost,
): Tui.Component {
	if (item.kind === "evt") {
		const activity = parsedActivity(item);
		if (activity) return activityComponent(item.botId, item.botName, activity, theme, "Activity", toolHost);
	}
	const box = new Tui.Box(1, 0, (text) =>
		theme.bg(item.kind === "msg" && !item.isBot ? "userMessageBg" : "customMessageBg", text),
	);
	if (item.kind === "evt") {
		box.addChild(
			cardHeader(item.botName, `bot ${item.botId} · Local · ${fmtClock(item.ts)}`, theme, identityColor(item.botId)),
		);
		box.addChild(new Tui.Text(theme.fg("customMessageText", eventBody(item)), 0, 0));
		return box;
	}

	const username = item.username?.trim().replace(/^@/, "");
	const normalizedName = item.senderName.trim().toLocaleLowerCase();
	const sender =
		username && normalizedName !== username.toLocaleLowerCase() && normalizedName !== `@${username.toLocaleLowerCase()}`
			? `${item.senderName} · @${username}`
			: item.senderName;
	const metadata = [
		`#${item.messageId}`,
		...(item.botId ? [`bot ${item.botId}`] : []),
		fmtClock(item.ts),
		...(item.edited ? ["edited"] : []),
	].join(" · ");
	box.addChild(cardHeader(sender, metadata, theme, identityColor(username || item.senderName)));
	if (item.replyTo != null)
		box.addChild(new Tui.Text(theme.fg("customMessageLabel", `↪ reply to #${item.replyTo}`), 0, 0));
	if (item.text)
		box.addChild(
			new Tui.Text(theme.fg(item.isBot ? "customMessageText" : "userMessageText", sanitize(item.text)), 0, 0),
		);
	if (item.mediaKind) {
		box.addChild(
			new Tui.Text(
				theme.fg(
					"customMessageLabel",
					`[${sanitize(item.mediaKind)}${item.stickerEmoji ? ` ${sanitize(item.stickerEmoji)}` : ""}]`,
				),
				0,
				0,
			),
		);
		const image = resolveMedia(item);
		const imageBounds =
			item.mediaKind === "sticker"
				? { maxWidthCells: 24, maxHeightCells: 12 }
				: { maxWidthCells: 56, maxHeightCells: 16 };
		if (image)
			box.addChild(
				new Tui.Image(
					image.base64,
					image.mime,
					{ fallbackColor: (text) => theme.fg("muted", text) },
					{ ...imageBounds, filename: basename(image.filename) },
				),
			);
		if (item.mediaDesc?.trim())
			box.addChild(
				new Tui.Text(
					`${theme.bold(theme.fg("customMessageLabel", "Vision"))}${theme.fg("muted", ` · ${sanitize(item.mediaDesc.trim())}`)}`,
					0,
					0,
				),
			);
	}
	return box;
}

function streamComponent(
	stream: Extract<AgentStreamFrame, { phase: "update" }>,
	theme: Theme,
	toolHost?: ToolPresentationHost,
): Tui.Component {
	return activityComponent(stream.botId, stream.botName, stream.activity, theme, "Streaming", toolHost);
}

class TelegramFeed extends Tui.Container {
	readonly client: TimelineClient;
	private readonly content = new Tui.Container();
	private readonly streamContent = new Tui.Container();
	private readonly items: TimelineItem[] = [];
	private readonly itemKeys = new Set<string>();
	private readonly cardSlots = new Map<string, Tui.Container>();
	private readonly streams = new Map<string, Extract<AgentStreamFrame, { phase: "update" }>>();
	private readonly endedStreams = new Set<string>();
	private statsValue: Record<string, BotStats> = {};
	private statusesValue: Record<string, RuntimeControlSnapshot> = {};
	private closed = false;

	constructor(
		readonly filter: string | null,
		private readonly theme: Theme,
		factory: TimelineFactory,
		private readonly changed: (event: TimelineEvent, feed: TelegramFeed) => void,
		private readonly requestRender: () => void,
		private readonly toolHost?: ToolPresentationHost,
	) {
		super();
		this.addChild(this.content);
		this.addChild(this.streamContent);
		this.client = factory(filter, { onEvent: (event) => this.onEvent(event) });
	}

	get stats(): Record<string, BotStats> {
		return this.statsValue;
	}
	get statuses(): Record<string, RuntimeControlSnapshot> {
		return this.statusesValue;
	}
	start(): void {
		void this.client.connect();
	}
	more(): boolean {
		return this.client.requestOlder();
	}

	/** Drop the live socket and ephemeral state; already-rendered history stays. Idempotent. */
	detach(): void {
		if (this.closed) return;
		this.closed = true;
		this.client.dispose();
		this.clearStreams();
	}

	private onEvent(event: TimelineEvent): void {
		if (event.type === "append") {
			const fresh = event.items.filter((item) => this.rememberItem(item));
			this.items.push(...fresh);
			this.appendItems(fresh);
		} else if (event.type === "prepend") {
			const fresh = event.items.filter((item) => this.rememberItem(item));
			if (fresh.length > 0) {
				this.items.unshift(...fresh);
				this.rebuildItems();
			}
		} else if (event.type === "stats") {
			this.statsValue = event.stats;
			this.statusesValue = event.statuses;
		} else if (event.type === "vision") {
			this.patchItems((item) => item.fileUniqueId === event.fileUniqueId && item.mediaDesc !== event.text, {
				mediaDesc: event.text,
			});
		} else if (event.type === "media") {
			this.patchItems((item) => item.fileUniqueId === event.fileUniqueId && item.mediaPath !== event.mediaPath, {
				mediaPath: event.mediaPath,
			});
		} else if (event.type === "stream") {
			this.applyStream(event.stream);
		} else {
			this.clearStreams();
		}
		this.changed(event, this);
	}

	private rememberItem(item: TimelineItem): boolean {
		const key = itemKey(item);
		if (this.itemKeys.has(key)) return false;
		this.itemKeys.add(key);
		return true;
	}

	private appendItems(items: TimelineItem[]): void {
		let previousDay =
			this.items.length > items.length ? fmtDay(this.items[this.items.length - items.length - 1]!.ts) : "";
		for (const item of items) {
			const day = fmtDay(item.ts);
			if (day !== previousDay)
				this.content.addChild(new Tui.Text(this.theme.fg("dim", `──────── ${day} ────────`), 1, 0));
			const slot = new Tui.Container();
			slot.addChild(itemComponent(item, this.theme, readMediaImage, this.toolHost));
			this.cardSlots.set(itemKey(item), slot);
			this.content.addChild(slot);
			this.content.addChild(new Tui.Spacer(1));
			previousDay = day;
		}
	}

	private rebuildItems(): void {
		this.content.clear();
		this.cardSlots.clear();
		this.appendItems(this.items);
	}

	/** Apply `patch` to every matching message and re-render only those cards in place. */
	private patchItems(predicate: (item: MsgItem) => boolean, patch: Partial<MsgItem> = {}): void {
		let refreshed = false;
		for (let index = 0; index < this.items.length; index++) {
			const item = this.items[index]!;
			if (item.kind !== "msg" || !predicate(item)) continue;
			const updated = { ...item, ...patch };
			this.items[index] = updated;
			const slot = this.cardSlots.get(itemKey(updated));
			if (!slot) continue;
			slot.clear();
			slot.addChild(itemComponent(updated, this.theme, readMediaImage, this.toolHost));
			refreshed = true;
		}
		if (refreshed) this.requestRender();
	}

	private applyStream(stream: AgentStreamFrame): void {
		const key = `${stream.botId}:${stream.streamId}`;
		if (stream.phase === "end") {
			this.streams.delete(key);
			this.rememberEnded(key);
			this.rebuildStreams();
			return;
		}
		if (this.endedStreams.has(key)) return;
		if (!this.streams.has(key) && this.streams.size >= MAX_ACTIVE_STREAMS) {
			const oldest = this.streams.keys().next().value as string | undefined;
			if (oldest) this.streams.delete(oldest);
		}
		this.streams.delete(key);
		this.streams.set(
			key,
			stream.phase === "start"
				? {
						...stream,
						phase: "update",
						activity: {
							version: 1,
							activityId: stream.streamId,
							startedAt: stream.ts,
							sections: [],
							truncated: false,
						},
					}
				: stream,
		);
		this.rebuildStreams();
	}

	private rememberEnded(key: string): void {
		this.endedStreams.delete(key);
		this.endedStreams.add(key);
		while (this.endedStreams.size > MAX_ENDED_STREAMS) {
			const oldest = this.endedStreams.keys().next().value as string | undefined;
			if (!oldest) break;
			this.endedStreams.delete(oldest);
		}
	}

	private rebuildStreams(): void {
		this.streamContent.clear();
		for (const stream of this.streams.values()) {
			this.streamContent.addChild(streamComponent(stream, this.theme, this.toolHost));
			this.streamContent.addChild(new Tui.Spacer(1));
		}
	}

	private clearStreams(): void {
		if (this.streams.size === 0) return;
		this.streams.clear();
		this.rebuildStreams();
	}
}

function detachedEntry(data: FeedEntry, theme: Theme): Tui.Component {
	const box = new Tui.Box(1, 0, (text) => theme.bg("customMessageBg", text));
	const scope = data.filter ? `bot ${data.filter}` : "all bots";
	box.addChild(new Tui.Text(theme.bold(theme.fg("accent", `Telegram · ${scope}`)), 0, 0));
	box.addChild(new Tui.Text(theme.fg("dim", "detached · run /tg attach to reconnect"), 0, 0));
	return box;
}

/** `/tg status [bot]`: one short IPC connection reads a fresh stats + runtime snapshot, then disconnects. */
function showTelegramStatus(
	ctx: ExtensionContext,
	filter: string | null,
	factory: TimelineFactory,
	bots: readonly StatusBot[],
): Promise<void> {
	return new Promise<void>((resolve) => {
		let client: TimelineClient;
		let done = false;
		const finish = (text: string, type: "info" | "error") => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			client.dispose();
			ctx.ui.notify(text, type);
			resolve();
		};
		const timer = setTimeout(() => finish("timed out waiting for Telegram telemetry", "error"), 3000);
		client = factory(filter, {
			onEvent: (event) => {
				if (event.type === "stats") {
					const text = Object.entries(event.stats)
						.map(([id, stats]) =>
							statsText(
								id,
								stats,
								bots.find((bot) => bot.id === id),
								event.statuses[id],
								ctx,
							),
						)
						.join("\n\n");
					finish(text || "no telemetry yet", "info");
				} else if (event.type === "disconnected") finish(event.reason, "error");
			},
		});
		void client.connect();
	});
}

export function registerTelegramExtension(pi: ExtensionAPI, rootDir = process.cwd()): void {
	const factory: TimelineFactory = (filter, hooks) =>
		new TimelineClient(join(rootDir, "data", "daemon.sock"), filter, hooks);
	const feeds = new Map<string, TelegramFeed>();
	let pending: { data: FeedEntry; changed: (event: TimelineEvent, feed: TelegramFeed) => void } | null = null;
	let active: TelegramFeed | null = null;
	let lastUi: ExtensionContext["ui"] | null = null;
	let bots: BotConfig[] | undefined;
	let requestHostRender: (() => void) | null = null;
	let toolHost: ToolPresentationHost | undefined;

	/** Startup-validated config, read from disk once per process. Throws on error. */
	const loadBots = (): BotConfig[] => {
		if (!bots) bots = loadConfig(rootDir).bots;
		return bots;
	};
	const configuredBots = (): BotConfig[] => {
		try {
			return loadBots();
		} catch {
			return [];
		}
	};
	const findBot = (id: string, ui: ExtensionContext["ui"]): BotConfig | undefined => {
		try {
			const all = loadBots();
			const bot = all.find((candidate) => candidate.id === id);
			if (bot) return bot;
			ui.notify(
				`unknown bot id "${id}"; configured bots: ${all.map((candidate) => candidate.id).join(", ") || "(none)"}`,
				"error",
			);
		} catch (error) {
			ui.notify(`config error: ${(error as Error).message}`, "error");
		}
		return undefined;
	};
	/** null = all bots, undefined = invalid (already notified). */
	const resolveFilter = (arg: string | undefined, ui: ExtensionContext["ui"]): string | null | undefined =>
		arg ? findBot(arg, ui)?.id : null;

	const clearFeedUi = (ui: ExtensionContext["ui"] | null) => {
		requestHostRender = null;
		toolHost = undefined;
		ui?.setWidget(FEED_WIDGET_KEY, undefined);
		ui?.setStatus(STATUS_KEY, undefined);
	};
	/** The one way a live feed stops: socket closed, widget/footer restored. */
	const teardownFeed = (ui: ExtensionContext["ui"] | null) => {
		active?.detach();
		active = null;
		clearFeedUi(ui);
	};
	const mountFeedUi = (filter: string | null, ctx: ExtensionContext) => {
		const scope = filter ? `bot ${filter}` : "all bots";
		ctx.ui.setWidget(
			FEED_WIDGET_KEY,
			(tui, theme) => {
				requestHostRender = () => tui.requestRender();
				toolHost = { ui: tui, cwd: ctx.cwd };
				return {
					render: (width) => [telegramFeedHeaderLine(width, theme, scope)],
					invalidate() {},
				};
			},
			{ placement: "aboveEditor" },
		);
	};
	const attachFeed = (filter: string | null, ctx: ExtensionContext) => {
		teardownFeed(ctx.ui);
		mountFeedUi(filter, ctx);
		const data = { instanceId: randomUUID(), filter };
		pending = {
			data,
			changed: (event, feed) => {
				requestHostRender?.();
				if (event.type === "stats" && active === feed) {
					const usage = telegramUsage(filter, feed.stats, feed.statuses, configuredBots(), ctx);
					ctx.ui.setStatus(STATUS_KEY, usage ? telegramStatusLine(usage) : undefined);
				}
				if (event.type === "disconnected" && active === feed) {
					teardownFeed(ctx.ui);
					ctx.ui.notify(`Telegram feed disconnected: ${event.reason}`, "error");
				}
			},
		};
		pi.appendEntry<FeedEntry>(ENTRY_TYPE, data);
		if (pending) {
			pending = null;
			clearFeedUi(ctx.ui);
			ctx.ui.notify("Pi did not mount the Telegram transcript entry", "error");
		}
	};

	pi.registerEntryRenderer<FeedEntry>(ENTRY_TYPE, (entry, _renderOptions, theme) => {
		const data = entry.data as FeedEntry | undefined;
		if (!data) return new Tui.Text(theme.fg("error", "invalid Telegram feed entry"), 1, 0);
		const existing = feeds.get(data.instanceId);
		if (existing) return existing;
		if (pending?.data.instanceId !== data.instanceId) return detachedEntry(data, theme);
		const feed = new TelegramFeed(data.filter, theme, factory, pending.changed, () => requestHostRender?.(), toolHost);
		pending = null;
		feeds.set(data.instanceId, feed);
		active = feed;
		feed.start();
		return feed;
	});

	pi.on("session_shutdown", () => {
		teardownFeed(lastUi);
		for (const feed of feeds.values()) feed.detach();
	});

	pi.registerCommand("tg", {
		description: `Telegram: ${formatTgHelp().slice("usage: /tg ".length)}`,
		getArgumentCompletions: (argumentPrefix) => completeTgArguments(argumentPrefix, configuredBots()),
		handler: async (args, ctx) => {
			lastUi = ctx.ui;
			const parsed = parseTgArguments(args);
			if (!parsed.ok) {
				ctx.ui.notify(formatTgHelp(), parsed.reason === "empty" ? "info" : "error");
				return;
			}
			const sub = parsed.dispatch;
			const botArg = parsed.arguments[0];
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Telegram UI requires interactive mode", "error");
				return;
			}
			if (sub === "attach") {
				const filter = resolveFilter(botArg, ctx.ui);
				if (filter === undefined) return;
				attachFeed(filter, ctx);
			} else if (sub === "more") {
				if (!active?.client.isConnected) ctx.ui.notify("no connected Telegram feed; run /tg attach first", "warning");
				else if (!active.more())
					ctx.ui.notify(
						active.client.hasMore ? "Telegram history request already in progress" : "oldest Telegram record reached",
						"info",
					);
			} else if (sub === "detach") {
				if (!active) ctx.ui.notify("no live Telegram feed", "warning");
				else teardownFeed(ctx.ui);
			} else if (sub === "status") {
				const filter = resolveFilter(botArg, ctx.ui);
				if (filter === undefined) return;
				await showTelegramStatus(ctx, filter, factory, configuredBots());
			}
		},
	});
}

export default function telegramExtension(pi: ExtensionAPI): void {
	registerTelegramExtension(pi);
}
