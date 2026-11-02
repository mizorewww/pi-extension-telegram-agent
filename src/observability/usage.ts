import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface ContextBreakdown {
	system: number;
	tools: number;
	compactedHistory: number;
	messages: number;
}

/** One provider run's telemetry: the latest main-conversation run inside BotStats. */
export interface UsageRun {
	id: number; // llm_runs.id
	botId: string;
	ts: number;
	model: string;
	epoch: number;
	contextTokens: number;
	cacheRead: number;
	cacheWrite: number;
	cacheMiss: number;
	/** True when cacheRead/cacheMiss are a local structural prefix estimate. Absent on auxiliary compaction runs. */
	cacheEstimated?: boolean;
	outputTokens: number;
	reasoningTokens: number;
	latencyMs: number | null;
	/** Detail fields; absent on auxiliary compaction runs. */
	thinkingMs?: number;
	/** Populated once the Telegram send for this run completes. */
	sendMs?: number;
	sendSamples?: number;
	contextBreakdown?: ContextBreakdown;
	cost: number;
	/** Auxiliary compaction response: included in totals, never replaces latest conversation context. */
	compaction?: boolean;
}

/** Cumulative stats per bot (full-history aggregation, daemon-side). */
export interface BotStats {
	runs: number;
	contextTokens: number;
	cacheRead: number;
	/** Lifetime cache-write total. */
	cacheWrite: number;
	cacheMiss: number;
	/** Number of retained runs using local structural cache estimates. */
	estimatedCacheRuns: number;
	outputTokens: number;
	/** Main-conversation output used for speed; excludes auxiliary compaction. */
	speedOutputTokens: number;
	/** Lifetime detail totals. */
	reasoningTokens: number;
	totalLatencyMs: number;
	latencySamples: number;
	totalThinkingMs: number;
	thinkingSamples: number;
	totalSendMs: number;
	sendSamples: number;
	firstRunTs: number | null;
	cost: number;
	epoch: number;
	/** Newest retained run of any kind (`MAX(llm_runs.id)`), 0 when none; `> last.id` means a compaction is newer. */
	lastRunId: number;
	/** Latest main-conversation response (`compaction = 0`). */
	last: UsageRun | null;
}

export type RuntimeControlState = "idle" | "busy" | "cooldown" | "stopping" | "compacting";

/** Daemon-resolved runtime truth for Telegram /status. */
export interface RuntimeControlSnapshot {
	state: RuntimeControlState;
	epoch: number;
	provider: string;
	model: string;
	reasoningEffort: ThinkingLevel;
	contextWindow: number;
	/** Live Pi session usage; null immediately after compaction until the next provider response. */
	currentContextTokens?: number | null;
	routingP: number;
	samplingCooldownMs: number;
	lastCompact: { at: number; outcome: "ok" | "failed" } | null;
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

/** Derived usage metrics for Telegram /status. */
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
