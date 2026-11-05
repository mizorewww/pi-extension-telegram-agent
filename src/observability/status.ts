import type { BotConfig } from "../config.ts";
import type { RuntimeControlSnapshot } from "./usage.ts";

const integer = (value: number) => value.toLocaleString("en-US");
export const formatUsdCost = (value: number) =>
	value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });

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
		`Pi 累计：prompt ${integer(prompt)} · output ${integer(sum("output"))} · $${formatUsdCost(cost)}`,
		`缓存：${cache} · R ${integer(sum("cacheRead"))} · W ${integer(sum("cacheWrite"))}`,
		`接话：${runtime.decider ? `${runtime.decider.provider}/${runtime.decider.model} ≥ ${runtime.decider.threshold}` : "每条都接"} · 冷却 ${integer(runtime.cooldownMs)} ms`,
		`最近压缩：${runtime.lastCompact ? `${runtime.lastCompact.outcome} · ${new Date(runtime.lastCompact.at).toLocaleString("en-GB")}` : "—"}`,
	].join("\n");
}
