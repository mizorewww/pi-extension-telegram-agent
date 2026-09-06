import type { Database } from "bun:sqlite";
import type { LogRecord } from "./log.ts";

const MAX_CLAIMS = 20;
const MAX_RUNS = 20;
const MAX_EVENTS = 50;
const MAX_LOGS = 100;

export interface DebugReportInput {
	botIds: readonly string[];
	chatId: number;
	sinceMs: number;
	now?: number;
	logs?: readonly LogRecord[];
	daemon?: { pid: number | null; alive: boolean; socket: boolean };
	modelReasoning?: readonly DebugModelReasoning[];
	videoTranscoder?: { required: boolean; ffmpeg: boolean; ffprobe: boolean };
}

export interface DebugModelReasoning {
	bot_id: string;
	scope: "main" | "compaction" | "vision";
	provider: string;
	model: string;
	requested: string;
	effective: string;
	supported: string[];
	valid: boolean;
}

export interface DebugFinding {
	code:
		| "unsupported_reasoning_effort"
		| "video_transcoder_unavailable"
		| "pending_telegram_dispatch"
		| "cursor_backlog"
		| "pending_reply_obligation"
		| "route_without_run"
		| "model_silence"
		| "tool_preflight_failed"
		| "send_degraded";
	bot_id: string;
	message_id?: number;
	count?: number;
	category?: string;
	outcome?: string;
	scope?: DebugModelReasoning["scope"];
	requested?: string;
	effective?: string;
	supported?: string[];
	impact?: "video_recognition_disabled";
	action?: "install_ffmpeg_and_restart";
}

interface SafeEvent {
	id: number;
	ts: number;
	kind: string;
	stage?: string;
	category?: string;
	tool?: string;
	is_error?: boolean;
	outcome?: string;
	message_id?: number;
	sent_count?: number;
	epoch?: number;
	kept?: number;
}

function safeInt(value: unknown): number | undefined {
	return Number.isSafeInteger(value) ? (value as number) : undefined;
}

function safeEvent(row: { id: number; ts: number; kind: string; payload: string }): SafeEvent {
	const event: SafeEvent = { id: row.id, ts: row.ts, kind: row.kind };
	let payload: Record<string, unknown> = {};
	try {
		payload = JSON.parse(row.payload) as Record<string, unknown>;
	} catch {
		/* malformed historical payload */
	}
	if (typeof payload.stage === "string") event.stage = payload.stage.slice(0, 64);
	if (typeof payload.category === "string") event.category = payload.category.slice(0, 64);
	if (typeof payload.code === "string" && event.category == null) event.category = payload.code.slice(0, 64);
	if (typeof payload.tool === "string") event.tool = payload.tool.slice(0, 32);
	if (typeof payload.isError === "boolean") event.is_error = payload.isError;
	if (typeof payload.outcome === "string") event.outcome = payload.outcome.slice(0, 32);
	const firstFailure =
		Array.isArray(payload.failures) && payload.failures[0] && typeof payload.failures[0] === "object"
			? (payload.failures[0] as Record<string, unknown>)
			: null;
	if (event.stage == null && typeof firstFailure?.stage === "string") event.stage = firstFailure.stage.slice(0, 64);
	if (event.category == null && typeof firstFailure?.category === "string")
		event.category = firstFailure.category.slice(0, 64);
	const messageId = safeInt(payload.message_id);
	if (messageId != null) event.message_id = messageId;
	const sent = Array.isArray(payload.sent) ? payload.sent.filter((id) => Number.isSafeInteger(id)) : [];
	if (sent.length > 0 || row.kind === "send") event.sent_count = Math.min(sent.length, 8);
	const epoch = safeInt(payload.epoch);
	if (epoch != null) event.epoch = epoch;
	const kept = safeInt(payload.kept);
	if (kept != null) event.kept = kept;
	return event;
}

function logMatchesBot(record: LogRecord, botId: string): boolean {
	return record.fields?.bot_id == null || record.fields.bot_id === botId;
}

export function buildDebugReport(db: Database, input: DebugReportInput) {
	const now = input.now ?? Date.now();
	const since = now - input.sinceMs;
	const highWater = (
		db.query("SELECT COALESCE(MAX(ingest_seq), 0) value FROM message_events WHERE chat_id = ?").get(input.chatId) as {
			value: number;
		}
	).value;
	const bots = input.botIds.map((botId) => {
		const cursor =
			(
				db
					.query("SELECT consumed_seq value FROM bot_cursors WHERE bot_id = ? AND chat_id = ?")
					.get(botId, input.chatId) as { value: number } | null
			)?.value ?? 0;
		const obligationCount = (
			db
				.query("SELECT COUNT(*) value FROM reply_obligations WHERE bot_id = ? AND chat_id = ?")
				.get(botId, input.chatId) as { value: number }
		).value;
		const claims = db
			.query(`
			SELECT message_id, route_version, reason, status, created_at, updated_at
			  FROM routing_claims
			 WHERE bot_id = ? AND chat_id = ? AND updated_at >= ?
			 ORDER BY updated_at DESC, message_id DESC LIMIT ?
		`)
			.all(botId, input.chatId, since, MAX_CLAIMS) as Array<Record<string, string | number>>;
		const runs = db
			.query(`
			SELECT id, ts, epoch, trigger_message_id, public_send_count, tool_followup_rounds,
			       input_events, input_tokens_estimated, rows_scanned, latency_ms,
			       context_tokens, cache_read, cache_write, cache_read_estimated, cache_miss, output_tokens,
			       reasoning_tokens, vision_calls, images_attached, system_tokens, tools_tokens,
			       compacted_history_tokens, message_tokens, thinking_ms, send_ms, send_samples
			  FROM llm_runs WHERE bot_id = ? AND ts >= ?
			 ORDER BY id DESC LIMIT ?
		`)
			.all(botId, since, MAX_RUNS) as Array<Record<string, number | null>>;
		const rawEvents = db
			.query(`
			SELECT id, ts, kind, payload FROM agent_events
			 WHERE bot_id = ? AND ts >= ? ORDER BY id DESC LIMIT ?
		`)
			.all(botId, since, MAX_EVENTS) as Array<{ id: number; ts: number; kind: string; payload: string }>;
		const events = rawEvents.map(safeEvent);
		const logs = (input.logs ?? [])
			.filter((record) => Date.parse(record.ts) >= since && logMatchesBot(record, botId))
			.slice(-MAX_LOGS)
			.map((record) => ({
				ts: record.ts,
				level: record.level,
				component: record.component,
				event: record.event,
				fields: record.fields,
			}));
		return {
			bot_id: botId,
			context: {
				consumed_seq: cursor,
				high_water: highWater,
				backlog: Math.max(0, highWater - cursor),
				pending_reply_obligations: obligationCount,
			},
			pending_dispatch: db
				.query("SELECT update_id, message_id, kind FROM pending_telegram_dispatch WHERE bot_id = ?")
				.get(botId) as { update_id: number; message_id: number; kind: string } | null,
			claims,
			runs,
			events,
			logs,
		};
	});

	const findings: DebugFinding[] = [];
	if (input.videoTranscoder?.required && (!input.videoTranscoder.ffmpeg || !input.videoTranscoder.ffprobe)) {
		findings.push({
			code: "video_transcoder_unavailable",
			bot_id: "deployment",
			impact: "video_recognition_disabled",
			action: "install_ffmpeg_and_restart",
		});
	}
	for (const diagnostic of input.modelReasoning ?? []) {
		if (diagnostic.valid) continue;
		findings.push({
			code: "unsupported_reasoning_effort",
			bot_id: diagnostic.bot_id,
			scope: diagnostic.scope,
			requested: diagnostic.requested,
			effective: diagnostic.effective,
			supported: diagnostic.supported,
		});
	}
	for (const bot of bots) {
		if (bot.pending_dispatch)
			findings.push({
				code: "pending_telegram_dispatch",
				bot_id: bot.bot_id,
				message_id: bot.pending_dispatch.message_id,
			});
		if (bot.context.backlog > 0)
			findings.push({ code: "cursor_backlog", bot_id: bot.bot_id, count: bot.context.backlog });
		if (bot.context.pending_reply_obligations > 0)
			findings.push({
				code: "pending_reply_obligation",
				bot_id: bot.bot_id,
				count: bot.context.pending_reply_obligations,
			});
		for (const claim of bot.claims) {
			if (claim.status !== "started" || Number(claim.updated_at) > now - 120_000) continue;
			if (!bot.runs.some((run) => run.trigger_message_id === claim.message_id)) {
				findings.push({ code: "route_without_run", bot_id: bot.bot_id, message_id: Number(claim.message_id) });
			}
		}
		for (const run of bot.runs) {
			if (run.public_send_count !== 0) continue;
			const silent = bot.events.some(
				(event) => event.kind === "assistant_text" && Math.abs(event.ts - Number(run.ts)) <= 120_000,
			);
			if (silent)
				findings.push({
					code: "model_silence",
					bot_id: bot.bot_id,
					...(safeInt(run.trigger_message_id) == null ? {} : { message_id: run.trigger_message_id as number }),
				});
		}
		for (const record of bot.logs) {
			if (record.component === "agent_send" && record.event === "preflight_failed") {
				findings.push({
					code: "tool_preflight_failed",
					bot_id: bot.bot_id,
					...(safeInt(record.fields?.trigger_message_id) == null
						? {}
						: { message_id: record.fields!.trigger_message_id as number }),
					category: typeof record.fields?.category === "string" ? record.fields.category : "unknown",
				});
			}
		}
		for (const event of bot.events) {
			if (event.kind === "send_degraded")
				findings.push({ code: "send_degraded", bot_id: bot.bot_id, category: event.category, outcome: event.outcome });
		}
	}

	return {
		schema: 1,
		generated_at: new Date(now).toISOString(),
		window_ms: input.sinceMs,
		daemon: input.daemon ?? null,
		limits: { claims_per_bot: MAX_CLAIMS, runs_per_bot: MAX_RUNS, events_per_bot: MAX_EVENTS, logs_per_bot: MAX_LOGS },
		model_reasoning_available: input.modelReasoning !== undefined,
		model_reasoning: input.modelReasoning ?? null,
		video_transcoder: input.videoTranscoder ?? null,
		bots,
		findings: findings.slice(0, 100),
	};
}

export function parseDebugDuration(input: string): number | null {
	const match = /^(\d+)(s|m|h|d)$/.exec(input.trim().toLowerCase());
	if (!match) return null;
	const count = Number(match[1]);
	const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
	const value = count * unit;
	return Number.isSafeInteger(value) && value >= 1_000 && value <= 7 * 86_400_000 ? value : null;
}
