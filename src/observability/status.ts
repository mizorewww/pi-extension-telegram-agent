import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { UsageState } from "@earendil-works/pi-durable";
import type { BotConfig, DeciderConfig } from "../config.ts";

export interface ContextComposition {
	system: number;
	tools: number;
	summary: number;
	messages: number;
}

export interface RuntimeControlSnapshot {
	state: "idle" | "busy" | "cooldown" | "stopping" | "compacting";
	epoch: number;
	provider: string;
	model: string;
	reasoningEffort: ModelThinkingLevel;
	contextWindow: number;
	currentContextTokens?: number | null;
	context: ContextComposition;
	cooldownMs: number;
	decider: DeciderConfig | null;
	lastCompact: { at: number; outcome: "ok" | "failed" } | null;
	usage?: UsageState;
}

const integer = (value: number) => value.toLocaleString("en-US");
export const formatUsdCost = (value: number) =>
	value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });

const BAR_CELLS = 20;
const PARTS = [
	["system", "🟥", "system prompt"],
	["tools", "🟪", "工具声明"],
	["summary", "🟫", "压缩摘要"],
	["messages", "🟦", "消息"],
] as const;

/** One cell per 5% of the window, split by largest remainder so the bar always has BAR_CELLS cells. */
function renderComposition(parts: ContextComposition, window: number): string {
	const used = PARTS.reduce((sum, [key]) => sum + parts[key], 0);
	const values = [...PARTS.map(([key]) => parts[key]), Math.max(0, window - used)];
	const exact = values.map((tokens) => (tokens * BAR_CELLS) / Math.max(window, used));
	const cells = exact.map(Math.floor);
	let remainder = BAR_CELLS - cells.reduce((sum, cell) => sum + cell, 0);
	for (const index of exact.map((_, i) => i).sort((a, b) => (exact[b]! % 1) - (exact[a]! % 1))) {
		if (remainder-- <= 0) break;
		cells[index]!++;
	}
	const squares = [...PARTS.map(([, square]) => square), "⬜"];
	const percent = (tokens: number) => `${((tokens / window) * 100).toFixed(1)}%`;
	return [
		cells.map((count, index) => squares[index]!.repeat(count)).join(""),
		...PARTS.map(([key, square, label]) => `${square} ${label} ${integer(parts[key])} · ${percent(parts[key])}`),
		`⬜ 剩余 ${integer(values.at(-1)!)} · ${percent(values.at(-1)!)}`,
	].join("\n");
}

/** Pi owns the persistent usage ledger; Telegram only formats its counters. */
export function renderBotStatus(bot: BotConfig, runtime: RuntimeControlSnapshot): string {
	const states = { idle: "空闲", busy: "生成中", cooldown: "冷却中", stopping: "停止中", compacting: "压缩中" };
	const usages = [...Object.values(runtime.usage?.models ?? {}), ...Object.values(runtime.usage?.tools ?? {})];
	const sum = (key: "input" | "output" | "cacheRead" | "cacheWrite") =>
		usages.reduce((total, usage) => total + usage[key], 0);
	const prompt = sum("input") + sum("cacheRead") + sum("cacheWrite");
	const cache = prompt > 0 ? `${((sum("cacheRead") / prompt) * 100).toFixed(1)}%` : "—";
	const cost = usages.reduce((total, usage) => total + usage.cost.total, 0);
	return [
		bot.name,
		`状态：${states[runtime.state]} · epoch ${runtime.epoch}`,
		`模型：${runtime.provider}/${runtime.model} · reasoning ${runtime.reasoningEffort}`,
		`当前上下文：${runtime.currentContextTokens == null ? "—" : integer(runtime.currentContextTokens)} / ${integer(runtime.contextWindow)}`,
		`上下文构成：\n${renderComposition(runtime.context, runtime.contextWindow)}`,
		`Pi 累计：prompt ${integer(prompt)} · output ${integer(sum("output"))} · $${formatUsdCost(cost)}`,
		`缓存：${cache} · R ${integer(sum("cacheRead"))} · W ${integer(sum("cacheWrite"))}`,
		`接话：${runtime.decider ? `${runtime.decider.provider}/${runtime.decider.model} ≥ ${runtime.decider.threshold}` : "每条都接"} · 冷却 ${integer(runtime.cooldownMs)} ms`,
		`最近压缩：${runtime.lastCompact ? `${runtime.lastCompact.outcome} · ${new Date(runtime.lastCompact.at).toLocaleString("en-GB")}` : "—"}`,
	].join("\n");
}
