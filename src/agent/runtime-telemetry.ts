// Per-bot runtime telemetry: thinking timer, strict-prefix cache estimate, and llm_runs / agent_events persistence.

import type { Database } from "bun:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { BotConfig } from "../config.ts";
import type { RuntimeControlSnapshot } from "../ipc.ts";
import { fitContextBreakdown } from "../observability/usage.ts";
import type { AssistantActivityStream } from "./activity.ts";
import { sha256 } from "./context-fingerprint.ts";
import {
	estimateCacheReadFromPrefix,
	type PreviousProviderPayloadFingerprint,
	type ProviderPayloadObservation,
} from "./extensions/index.ts";
import { COMPACTION_SUMMARY_PROMPT, sha256Short } from "./prompt.ts";

export interface InputMetrics {
	inputEvents: number;
	estimatedTokens: number;
	rowsScanned: number;
	visionCalls: number;
	imagesAttached: number;
}

export function emptyInputMetrics(): InputMetrics {
	return { inputEvents: 0, estimatedTokens: 0, rowsScanned: 0, visionCalls: 0, imagesAttached: 0 };
}

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

export interface ProviderUsageSample {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	cost: { total: number };
}

export class BotRuntimeTelemetry {
	systemHash = "";
	toolsHash = "";
	hmacKey = "";
	pendingObservation: ProviderPayloadObservation | null = null;
	pendingInputMetrics: InputMetrics = emptyInputMetrics();
	providerCallsInRun = 0;
	private runStartTs = 0;
	private lastLlmRunId: number | null = null;
	private thinkingStartedAt = 0;
	private thinkingMs = 0;
	private thinkingFinished = false;
	private previousRequest: (PreviousProviderPayloadFingerprint & { cohort: string }) | null = null;

	constructor(
		private readonly db: Database,
		private readonly bot: BotConfig,
		private readonly activity: AssistantActivityStream,
		private readonly eventSink: () =>
			| ((event: { id: number; ts: number; kind: string; payload: unknown }) => void)
			| null,
		private readonly usageSink: () => (() => void) | null,
	) {}

	beginRun(now: number): void {
		this.runStartTs = now;
		this.providerCallsInRun = 0;
		this.lastLlmRunId = null;
		this.thinkingStartedAt = 0;
		this.thinkingMs = 0;
		this.thinkingFinished = false;
		this.pendingObservation = null;
	}

	observeThinking(message: Extract<AgentMessage, { role: "assistant" }>, now: number, ended = false): void {
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

	recordEvent(kind: string, payload: unknown): void {
		const { stored, grouped } = this.activity.group(kind, payload);
		const ts = Date.now();
		const inserted = this.db
			.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (?, ?, ?, ?)")
			.run(this.bot.id, ts, kind, JSON.stringify(stored));
		if (grouped) this.activity.emit(ts);
		else this.eventSink()?.({ id: Number(inserted.lastInsertRowid), ts, kind, payload });
	}

	recordPublicSend(): void {
		if (this.lastLlmRunId == null) return;
		this.db.query("UPDATE llm_runs SET public_send_count = public_send_count + 1 WHERE id = ?").run(this.lastLlmRunId);
	}

	recordSendDuration(durationMs: number): void {
		if (this.lastLlmRunId == null || !Number.isFinite(durationMs)) return;
		this.db
			.query("UPDATE llm_runs SET send_ms = send_ms + ?, send_samples = send_samples + 1 WHERE id = ?")
			.run(Math.max(0, Math.round(durationMs)), this.lastLlmRunId);
		this.usageSink()?.();
	}

	recordUsage(
		usage: ProviderUsageSample,
		now: number,
		context: {
			model: Model<Api>;
			epoch: number;
			sessionId: string | undefined;
			triggerMessageId: number | null;
		},
	): void {
		this.providerCallsInRun++;
		const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		const reasoningTokens = usage.reasoning ?? 0;
		const latencyMs = this.runStartTs ? now - this.runStartTs : null;
		const observation = this.pendingObservation;
		const contextBreakdown = fitContextBreakdown(
			observation?.tokenEstimate ?? { system: 0, tools: 0, compactedHistory: 0, messages: contextTokens },
			contextTokens,
		);
		const metrics = this.pendingInputMetrics;
		const sessionIdHash = context.sessionId ? sha256(`${this.hmacKey}:${context.sessionId}`) : null;
		// The previous main request of the same cache cohort lives in memory only; after a restart
		// the first request simply has no estimate.
		const cohort = `${this.bot.provider}|${context.model.api}|${this.bot.model}|${context.epoch}|${sessionIdHash}|${this.bot.cacheRetention}`;
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
			epoch: context.epoch,
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
			api: context.model.api,
			session_id_hash: sessionIdHash,
			cache_retention: this.bot.cacheRetention,
			full_payload_hash: observation?.fullPayloadHash ?? null,
			first_divergent_segment: observation?.firstDivergentSegment ?? null,
			first_divergent_message_index: observation?.firstDivergentMessageIndex ?? null,
			first_divergent_byte_offset: observation?.firstDivergentByteOffset ?? null,
			trigger_message_id: context.triggerMessageId,
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
		this.usageSink()?.();
		this.thinkingMs = 0;
		this.thinkingFinished = false;
	}

	recordCompactionUsage(usage: ProviderUsageSample, now: number, model: Model<Api>, epoch: number): void {
		const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (contextTokens + usage.output + (usage.reasoning ?? 0) === 0 && usage.cost.total === 0) return;
		insertRow(this.db, "llm_runs", {
			bot_id: this.bot.id,
			ts: now,
			model: model.id,
			epoch,
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
		this.usageSink()?.();
	}
}
