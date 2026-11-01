import { basename } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import type { BotConfig } from "../../src/config.ts";
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
import { readMediaImage, type MediaImage } from "../../src/plugin/timeline.ts";
import { sanitize } from "../../src/sanitize.ts";

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

export type FeedEntry = { instanceId: string; filter: string | null };
export type ToolPresentationHost = { ui: Tui.TUI; cwd: string };
export type StatusModel = Pick<
	NonNullable<ExtensionContext["model"]>,
	"id" | "provider" | "contextWindow" | "reasoning"
>;
export type StatusBot = Pick<
	BotConfig,
	"id" | "name" | "provider" | "model" | "reasoningEffort" | "routingP" | "samplingCooldownMs"
>;
export type StatusHost = {
	modelRegistry: { getAvailable(): readonly StatusModel[] };
	model: StatusModel | undefined;
	thinkingLevel?: ExtensionContext["thinkingLevel"];
};

/** One-line attached-feed chrome. */
export function telegramFeedHeaderLine(width: number, theme: Pick<Theme, "fg" | "bold">, scope: string): string {
	if (width <= 0) return "";
	const text =
		`${theme.bold(theme.fg("accent", "Telegram"))}${theme.fg("dim", ` · ${sanitize(scope)} · `)}` +
		`${theme.fg("success", "attached")}${theme.fg("dim", " · /tg more · /tg detach")}`;
	return Tui.truncateToWidth(` ${text}`, width, theme.fg("dim", "..."));
}

function fmtClock(ts: number): string {
	return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}

export function fmtDay(ts: number): string {
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

export interface TelegramUsage {
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

export function streamComponent(
	stream: Extract<AgentStreamFrame, { phase: "update" }>,
	theme: Theme,
	toolHost?: ToolPresentationHost,
): Tui.Component {
	return activityComponent(stream.botId, stream.botName, stream.activity, theme, "Streaming", toolHost);
}

export function detachedEntry(data: FeedEntry, theme: Theme): Tui.Component {
	const box = new Tui.Box(1, 0, (text) => theme.bg("customMessageBg", text));
	const scope = data.filter ? `bot ${data.filter}` : "all bots";
	box.addChild(new Tui.Text(theme.bold(theme.fg("accent", `Telegram · ${scope}`)), 0, 0));
	box.addChild(new Tui.Text(theme.fg("dim", "detached · run /tg attach to reconnect"), 0, 0));
	return box;
}
