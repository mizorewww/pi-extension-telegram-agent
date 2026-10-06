// Local IPC between daemon (server) and TUI (client). Unix socket, JSONL frames.

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
// Protocol:
//   C->S {type:"hello"}                       S->C {type:"snapshot", items: TimelineItem[]}
//   C->S {type:"history", before, limit}      S->C {type:"history", items, hasMore}
//   C->S {type:"send_message", requestId,...} S->C {type:"send_result", requestId, ok,...}
//   (push)                                    S->C {type:"append", item: TimelineItem}
//   (push)                                    S->C {type:"vision_update", fileUniqueId, text}
//   (push)                                    S->C {type:"media_ready", fileUniqueId, mediaPath}
//   (push)                                    S->C {type:"agent_stream", stream: AgentStreamFrame}
//
// Pagination uses a composite cursor (ts, rank, id): rank 0 = agent event (id = agent_events.id),
// rank 1 = chat message (id = message_id). Merged timeline order is by (ts, rank, id), so
// same-second messages/events are never dropped or duplicated across pages (REQ-IPC-0001 R3).

export interface MsgItem {
	kind: "msg";
	ts: number; // unix ms
	chatId: number;
	messageId: number;
	senderName: string;
	username: string | null;
	isBot: boolean;
	botId: string | null; // which of our bots sent it, if any
	text: string | null;
	mediaKind: string | null;
	stickerEmoji: string | null;
	/** local cache path for the media file (same uid as the TUI); absent when not downloaded (REQ-UI-0001 R5). */
	mediaPath?: string | null;
	/** vision description text for the media, if recognized (REQ-UI-0001 R3). */
	mediaDesc?: string | null;
	/** stable Telegram media identity used to merge live vision updates (REQ-UI-0006 R1). */
	fileUniqueId?: string | null;
	replyTo: number | null;
	edited: boolean;
}

export interface EvtItem {
	kind: "evt";
	ts: number;
	/** agent_events.id; live pushes carry the persisted rowid and the same `ts` as the row. */
	evtId: number;
	botId: string;
	botName: string;
	evtKind: string; // assistant_text|thinking|tool_call|tool_result|send|usage|...
	payload: string; // JSON
}

export type TimelineItem = MsgItem | EvtItem;

/** Unified merged-timeline sort key: (ts, rank, id). */
export interface TimelineCursor {
	ts: number;
	id: number;
	rank: 0 | 1;
}

/** One provider run's telemetry: the latest main-conversation run inside BotStats. */
export interface UsageRun {
	id: number; // llm_runs.id — dedupes snapshot/push races
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
	contextBreakdown?: { system: number; tools: number; compactedHistory: number; messages: number };
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

/** Daemon-resolved runtime truth shared by Telegram control and Pi status. */
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

/** Retention-window stats per bot plus the daemon's runtime truth. */
export interface StatsSnapshot {
	bots: Record<string, BotStats>;
	statuses: Record<string, RuntimeControlSnapshot>;
}

/** A newly persisted, non-empty vision description (REQ-UI-0006). */
export interface VisionUpdate {
	fileUniqueId: string;
	text: string;
}

/** A newly installed owner-only local media file (REQ-UI-0014). */
export interface MediaReadyUpdate {
	fileUniqueId: string;
	mediaPath: string;
}

export type AgentActivityContent = { type: "text"; text: string } | { type: "thinking"; thinking: string };

export interface AgentActivityAssistantSection {
	type: "assistant";
	content: AgentActivityContent[];
	stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
}

export interface AgentActivityEventSection {
	type: "event";
	kind: string;
	detail: string;
}

export type AgentActivitySection = AgentActivityAssistantSection | AgentActivityEventSection;

/** Bounded, TUI-only projection of one complete Pi agent run. */
export interface AgentActivity {
	version: 1;
	activityId: string;
	startedAt: number;
	sections: AgentActivitySection[];
	truncated: boolean;
}

interface AgentStreamBase {
	streamId: string;
	botId: string;
	botName: string;
	ts: number;
}

/** Ephemeral assistant display state. It is never persisted or replayed in snapshots. */
export type AgentStreamFrame = AgentStreamBase &
	({ phase: "start" } | { phase: "update"; activity: AgentActivity } | { phase: "end" });

export type SendMessageErrorCode =
	| "invalid_request"
	| "unknown_bot"
	| "too_long"
	| "request_conflict"
	| "busy"
	| "telegram_error"
	| "unknown_outcome"
	| "service_unavailable"
	| "internal_error";

export interface SendMessageSuccess {
	requestId: string;
	botId: string;
	ok: true;
	chatId: number;
	messageId: number;
}

export interface SendMessageFailure {
	requestId: string;
	botId: string;
	ok: false;
	code: SendMessageErrorCode;
	error: string;
}

export type SendMessageResult = SendMessageSuccess | SendMessageFailure;

export interface SendMessageRequest {
	type: "send_message";
	requestId: string;
	botId: string;
	text: string;
}

export type ClientRequest =
	| { type: "hello"; filter?: string } // filter = bot id; absent = global view (REQ-UI-0002)
	| { type: "history"; before?: TimelineCursor; limit: number }
	| SendMessageRequest;

export type ServerMessage =
	| { type: "snapshot"; items: TimelineItem[]; stats?: StatsSnapshot }
	| { type: "history"; items: TimelineItem[]; hasMore: boolean }
	| { type: "append"; item: TimelineItem }
	| { type: "usage"; botId: string; stats: BotStats; status?: RuntimeControlSnapshot }
	| ({ type: "vision_update" } & VisionUpdate)
	| ({ type: "media_ready" } & MediaReadyUpdate)
	| { type: "agent_stream"; stream: AgentStreamFrame }
	| ({ type: "send_result" } & SendMessageResult);

export function encodeFrame(msg: unknown): string {
	return `${JSON.stringify(msg)}\n`;
}

/** Thrown when a client's receive buffer exceeds the bound; caller must disconnect. */
export class FrameOverflowError extends Error {
	constructor() {
		super("ipc frame buffer overflow");
	}
}

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024; // REQ-IPC-0001 R6

/**
 * Incremental JSONL decoder for a socket data stream. Holds ONE streaming TextDecoder:
 * multi-byte characters split across chunk boundaries decode correctly instead of
 * becoming U+FFFD (REQ-IPC-0001 R1). Buffered (complete) bytes are bounded; the decoder
 * itself only ever retains an incomplete multi-byte tail (≤3 bytes).
 */
export class FrameDecoder {
	private decoder = new TextDecoder();
	private buf = "";

	constructor(private maxBufferBytes: number = DEFAULT_MAX_BUFFER) {}

	push(chunk: Uint8Array | string): unknown[] {
		this.buf += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
		if (this.buf.length > this.maxBufferBytes) throw new FrameOverflowError();
		const out: unknown[] = [];
		let idx: number;
		// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic frame-splitting read loop
		while ((idx = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, idx).trim();
			this.buf = this.buf.slice(idx + 1);
			if (line) out.push(JSON.parse(line));
		}
		return out;
	}
}
