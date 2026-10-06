import type { BotStats, UsageRun } from "../ipc.ts";

export interface ContextBreakdown {
	system: number;
	tools: number;
	compactedHistory: number;
	messages: number;
}

/** Scale adapter-shape estimates to the provider's authoritative total token count. */
export function fitContextBreakdown(estimate: ContextBreakdown, total: number): ContextBreakdown {
	const keys = ["system", "tools", "compactedHistory", "messages"] as const;
	const estimateTotal = keys.reduce((sum, key) => sum + Math.max(0, estimate[key]), 0);
	if (estimateTotal === 0 || total <= 0) return { system: 0, tools: 0, compactedHistory: 0, messages: total };
	const exact = keys.map((key) => ({ key, value: (Math.max(0, estimate[key]) * total) / estimateTotal }));
	const result: ContextBreakdown = { system: 0, tools: 0, compactedHistory: 0, messages: 0 };
	for (const item of exact) result[item.key] = Math.floor(item.value);
	let remainder = total - keys.reduce((sum, key) => sum + result[key], 0);
	for (const item of [...exact].sort((a, b) => (b.value % 1) - (a.value % 1))) {
		if (remainder-- <= 0) break;
		result[item.key]++;
	}
	return result;
}

export interface UsageContextSummary {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface BotUsageSummary {
	cacheWrite: number;
	reasoningTokens: number;
	cacheHitPercent: number | null;
	cacheEstimated: boolean;
	averageLatencyMs: number | null;
	averageThinkingMs: number | null;
	averageSendMs: number | null;
	averageTokensPerSecond: number | null;
	context: UsageContextSummary;
}

function summarizeUsageContext(
	last: UsageRun | null,
	contextWindow: number,
	currentTokens?: number | null,
): UsageContextSummary {
	const normalizedWindow = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;
	const tokens = currentTokens === undefined ? (last?.contextTokens ?? null) : currentTokens;
	return {
		tokens,
		contextWindow: normalizedWindow,
		percent: tokens != null && normalizedWindow > 0 ? (tokens / normalizedWindow) * 100 : null,
	};
}

/** Shared derived values for Pi and Telegram status. */
export function summarizeBotUsage(
	stats: BotStats,
	contextWindow: number,
	currentContextTokens?: number | null,
): BotUsageSummary {
	const average = (total: number, samples: number) => (samples > 0 ? total / samples : null);
	const cacheDenominator = stats.cacheMiss + stats.cacheRead + stats.cacheWrite;
	const hasCacheSample = stats.cacheRead > 0 || stats.cacheWrite > 0;
	return {
		cacheWrite: stats.cacheWrite,
		cacheEstimated: stats.estimatedCacheRuns > 0,
		reasoningTokens: stats.reasoningTokens,
		cacheHitPercent: hasCacheSample && cacheDenominator > 0 ? (stats.cacheRead / cacheDenominator) * 100 : null,
		averageLatencyMs: average(stats.totalLatencyMs, stats.latencySamples),
		averageThinkingMs: average(stats.totalThinkingMs, stats.thinkingSamples),
		averageSendMs: average(stats.totalSendMs, stats.sendSamples),
		averageTokensPerSecond: stats.totalLatencyMs > 0 ? (stats.speedOutputTokens * 1000) / stats.totalLatencyMs : null,
		context: summarizeUsageContext(stats.last, contextWindow, currentContextTokens),
	};
}
