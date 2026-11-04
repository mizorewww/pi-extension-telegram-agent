import type { BotConfig } from "../config.ts";
import type { loadBotStats } from "../db/usage.ts";
import type { RuntimeControlSnapshot } from "./usage.ts";

const integer = (value: number) => value.toLocaleString("en-US");
export const formatUsdCost = (value: number) =>
	value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });

/** One compact view: native live session totals plus retained billed facts. */
export function renderBotStatus(
	bot: BotConfig,
	runtime: RuntimeControlSnapshot,
	retained: ReturnType<typeof loadBotStats>,
): string {
	const states = { idle: "空闲", busy: "生成中", cooldown: "冷却中", stopping: "停止中", compacting: "压缩中" };
	const stats = runtime.stats;
	const cache = retained.prompt > 0 ? `${((retained.cacheRead / retained.prompt) * 100).toFixed(1)}%` : "—";
	return [
		`${bot.id} · ${bot.name}`,
		`状态：${states[runtime.state]} · epoch ${runtime.epoch}`,
		`模型：${runtime.provider}/${runtime.model} · reasoning ${runtime.reasoningEffort}`,
		`当前上下文：${runtime.currentContextTokens == null ? "—" : integer(runtime.currentContextTokens)} / ${integer(runtime.contextWindow)}`,
		`当前会话：${stats ? `↑${integer(stats.tokens.input)} ↓${integer(stats.tokens.output)} R ${integer(stats.tokens.cacheRead)} W ${integer(stats.tokens.cacheWrite)} · $${formatUsdCost(stats.cost)}` : "—"}`,
		`保留期累计：${integer(retained.runs)} 请求 · prompt ${integer(retained.prompt)} · output ${integer(retained.output)} · $${formatUsdCost(retained.cost)}`,
		`缓存：${retained.estimated ? "≈" : ""}${cache} · R ${integer(retained.cacheRead)} · W ${integer(retained.cacheWrite)}`,
		`路由：${runtime.routingP} · 冷却 ${integer(runtime.samplingCooldownMs)} ms`,
		`最近压缩：${runtime.lastCompact ? `${runtime.lastCompact.outcome} · ${new Date(runtime.lastCompact.at).toLocaleString("en-GB")}` : "—"}`,
	].join("\n");
}
