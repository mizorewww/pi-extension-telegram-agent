import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import {
	encodeFrame,
	FrameDecoder,
	type BotStats,
	type AgentStreamFrame,
	type MsgItem,
	type SendMessageFailure,
	type SendMessageResult,
	type RuntimeControlSnapshot,
	type ServerMessage,
	type TimelineCursor,
	type TimelineItem,
	type UsageRun,
} from "../ipc.ts";

const MEDIA_MAX_BYTES = 1024 * 1024;
const SEND_ACK_TIMEOUT_MS = 15_000;
const MAX_PENDING_SENDS = 32;
const MAX_MEDIA_UPDATES = 256;
const MEDIA_UPDATE_TTL_MS = 10 * 60 * 1000;
const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

export interface MediaImage {
	base64: string;
	mime: string;
	filename: string;
}

/** Read a daemon-provided local image for Pi's Image component; Pi converts non-PNG for Kitty. */
export function readMediaImage(message: MsgItem): MediaImage | null {
	const mime = IMAGE_MIME[(message.mediaPath?.split(".").pop() ?? "").toLowerCase()];
	if (!message.mediaPath || !mime) return null;
	try {
		const stat = statSync(message.mediaPath);
		if (!stat.isFile() || stat.size <= 0 || stat.size > MEDIA_MAX_BYTES) return null;
		return { base64: readFileSync(message.mediaPath).toString("base64"), mime, filename: message.mediaPath };
	} catch {
		return null;
	}
}

export type TimelineEvent =
	| { type: "append"; items: TimelineItem[] }
	| { type: "prepend"; items: TimelineItem[] }
	| { type: "stats"; stats: Record<string, BotStats>; statuses: Record<string, RuntimeControlSnapshot> }
	| { type: "vision"; fileUniqueId: string; text: string }
	| { type: "media"; fileUniqueId: string; mediaPath: string }
	| { type: "stream"; stream: AgentStreamFrame }
	| { type: "disconnected"; reason: string };

export interface TimelineHooks {
	onEvent(event: TimelineEvent): void;
}

interface PendingSend {
	botId: string;
	resolve(result: SendMessageResult): void;
	timer: ReturnType<typeof setTimeout>;
}

/** Insertion-ordered map with a capacity bound and per-entry TTL; used for out-of-order media updates. */
class BoundedTtlMap<V> {
	private readonly entries = new Map<string, { value: V; expiresAt: number }>();

	constructor(
		private readonly max: number,
		private readonly ttlMs: number,
	) {}

	get(key: string): V | undefined {
		const entry = this.entries.get(key);
		return entry && entry.expiresAt > Date.now() ? entry.value : undefined;
	}

	/** Returns false when the key already holds the same live value. */
	set(key: string, value: V): boolean {
		const now = Date.now();
		for (const [existingKey, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(existingKey);
		const existing = this.entries.get(key);
		if (existing?.value === value) return false;
		if (!existing && this.entries.size >= this.max) {
			const oldest = this.entries.keys().next().value as string | undefined;
			if (oldest) this.entries.delete(oldest);
		}
		this.entries.delete(key);
		this.entries.set(key, { value, expiresAt: now + this.ttlMs });
		return true;
	}

	clear(): void {
		this.entries.clear();
	}
}

/** Dedupe key shared by the timeline client and the feed renderer. */
export function itemKey(item: TimelineItem): string {
	return item.kind === "msg" ? `m:${item.chatId}:${item.messageId}` : `e:${item.evtId}`;
}

function cursorOf(item: TimelineItem): TimelineCursor {
	return item.kind === "msg" ? { ts: item.ts, id: item.messageId, rank: 1 } : { ts: item.ts, id: item.evtId, rank: 0 };
}

function compareCursor(left: TimelineCursor, right: TimelineCursor): number {
	return left.ts - right.ts || left.rank - right.rank || left.id - right.id;
}

function emptyBotStats(): BotStats {
	return {
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
}

/** Fold one live run into a bot's totals (docs/telemetry.md: compaction adds to totals, never replaces `last`). */
function applyRun(stats: BotStats, run: UsageRun): void {
	stats.runs++;
	stats.contextTokens += run.contextTokens;
	stats.cacheRead += run.cacheRead;
	stats.cacheWrite += run.cacheWrite;
	if (run.cacheEstimated) stats.estimatedCacheRuns++;
	stats.cacheMiss += run.cacheMiss;
	stats.outputTokens += run.outputTokens;
	stats.reasoningTokens += run.reasoningTokens;
	if (!run.compaction) {
		stats.speedOutputTokens += run.outputTokens;
		stats.totalThinkingMs += run.thinkingMs ?? 0;
		stats.thinkingSamples++;
		stats.last = run;
	}
	stats.totalSendMs += run.sendMs ?? 0;
	stats.sendSamples += run.sendSamples ?? 0;
	if (run.latencyMs != null) {
		stats.totalLatencyMs += run.latencyMs;
		stats.latencySamples++;
	}
	stats.cost += run.cost;
	stats.epoch = Math.max(stats.epoch, run.epoch);
	stats.lastRunId = Math.max(stats.lastRunId, run.id);
	stats.firstRunTs = stats.firstRunTs == null ? run.ts : Math.min(stats.firstRunTs, run.ts);
}

/** IPC-only timeline client. Presentation belongs to the Pi extension. */
export class TimelineClient {
	private readonly seen = new Set<string>();
	private readonly decoder = new FrameDecoder();
	private stats: Record<string, BotStats> = {};
	private statuses: Record<string, RuntimeControlSnapshot> = {};
	/** Highest llm_runs.id already folded into `stats` (snapshot `lastId` or a later live run). */
	private appliedMaxId = 0;
	private readonly pendingSends = new Map<string, PendingSend>();
	private readonly visionUpdates = new BoundedTtlMap<string>(MAX_MEDIA_UPDATES, MEDIA_UPDATE_TTL_MS);
	private readonly mediaReadyUpdates = new BoundedTtlMap<string>(MAX_MEDIA_UPDATES, MEDIA_UPDATE_TTL_MS);
	private oldestCursorValue: TimelineCursor | null;
	private socket: Socket | null = null;
	private connected = false;
	private more = true;
	private loadingOlder = false;
	private disposed = false;

	constructor(
		private readonly sockPath: string,
		readonly filter: string | null,
		private readonly hooks: TimelineHooks,
		/** Oldest page already shown by the previous client of the same scope (reconnect); null for a fresh feed. */
		oldestCursor: TimelineCursor | null = null,
	) {
		this.oldestCursorValue = oldestCursor;
	}

	get isConnected(): boolean {
		return this.connected;
	}
	get hasMore(): boolean {
		return this.more;
	}
	get oldestCursor(): TimelineCursor | null {
		return this.oldestCursorValue;
	}

	async connect(): Promise<boolean> {
		if (this.disposed) return false;
		if (!existsSync(this.sockPath)) {
			this.hooks.onEvent({
				type: "disconnected",
				reason: "daemon not running (no data/daemon.sock). Start with: bun run src/main.ts start",
			});
			return false;
		}

		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			const socket = createConnection(this.sockPath);
			this.socket = socket;
			socket.once("connect", () => {
				if (this.disposed) {
					socket.destroy();
					finish(false);
					return;
				}
				this.connected = true;
				socket.write(encodeFrame({ type: "hello", ...(this.filter ? { filter: this.filter } : {}) }));
				finish(true);
			});
			socket.on("data", (chunk) => {
				try {
					for (const frame of this.decoder.push(chunk)) this.handleFrame(frame as ServerMessage);
				} catch (error) {
					this.failPendingSends("Telegram daemon IPC failed before acknowledging the send");
					this.hooks.onEvent({ type: "disconnected", reason: `ipc error: ${String(error)}` });
					socket.destroy();
				}
			});
			socket.once("error", (error) => {
				this.connected = false;
				this.failPendingSends("Telegram daemon connection failed before acknowledging the send");
				if (!this.disposed) this.hooks.onEvent({ type: "disconnected", reason: `ipc error: ${error.message}` });
				finish(false);
			});
			socket.once("close", () => {
				this.connected = false;
				this.failPendingSends("Telegram daemon disconnected before acknowledging the send");
				if (!this.disposed) this.hooks.onEvent({ type: "disconnected", reason: "daemon disconnected" });
				finish(false);
			});
		});
	}

	requestOlder(): boolean {
		if (this.loadingOlder || !this.more || !this.connected || !this.socket) return false;
		this.loadingOlder = true;
		const before = this.oldestCursorValue ?? { ts: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER, rank: 1 };
		this.socket.write(encodeFrame({ type: "history", before, limit: 100 }));
		return true;
	}

	sendText(botId: string, text: string, requestId: string): Promise<SendMessageResult> {
		if (this.disposed || !this.connected || !this.socket) {
			return Promise.resolve(
				this.sendFailure(requestId, botId, "service_unavailable", "Telegram daemon is not connected"),
			);
		}
		if (this.pendingSends.has(requestId)) {
			return Promise.resolve(this.sendFailure(requestId, botId, "request_conflict", "request id is already pending"));
		}
		if (this.pendingSends.size >= MAX_PENDING_SENDS) {
			return Promise.resolve(this.sendFailure(requestId, botId, "busy", "too many Telegram sends are pending"));
		}

		return new Promise<SendMessageResult>((resolve) => {
			const timer = setTimeout(() => {
				const pending = this.pendingSends.get(requestId);
				if (!pending) return;
				this.pendingSends.delete(requestId);
				pending.resolve(
					this.sendFailure(
						requestId,
						botId,
						"unknown_outcome",
						"Telegram send acknowledgement timed out; check the group before retrying",
					),
				);
			}, SEND_ACK_TIMEOUT_MS);
			this.pendingSends.set(requestId, { botId, resolve, timer });
			try {
				this.socket!.write(encodeFrame({ type: "send_message", requestId, botId, text }));
			} catch (error) {
				this.finishPendingSend(
					requestId,
					this.sendFailure(
						requestId,
						botId,
						"unknown_outcome",
						`Telegram send write failed with an unknown outcome: ${String(error)}`,
					),
				);
			}
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.connected = false;
		this.failPendingSends("timeline client disposed before Telegram acknowledged the send");
		this.socket?.destroy();
		this.socket = null;
		this.visionUpdates.clear();
		this.mediaReadyUpdates.clear();
	}

	private handleFrame(message: ServerMessage): void {
		if (this.disposed) return;
		if (message.type === "send_result") {
			const { type: _type, ...result } = message;
			this.finishPendingSend(message.requestId, result);
		} else if (message.type === "snapshot") {
			this.emitFresh("append", message.items);
			if (message.stats) {
				this.stats = message.stats.bots;
				this.statuses = message.stats.statuses;
				this.appliedMaxId = message.stats.lastId;
				this.emitStats();
			}
		} else if (message.type === "history") {
			this.more = message.hasMore;
			this.loadingOlder = false;
			this.emitFresh("prepend", message.items);
		} else if (message.type === "append") {
			this.emitFresh("append", [message.item]);
		} else if (message.type === "usage") {
			if (message.run.id <= this.appliedMaxId) return;
			this.appliedMaxId = message.run.id;
			const stats = { ...(this.stats[message.run.botId] ?? emptyBotStats()) };
			applyRun(stats, message.run);
			this.stats = { ...this.stats, [message.run.botId]: stats };
			this.emitStats();
		} else if (message.type === "vision_update") {
			const text = message.text.trim();
			if (message.fileUniqueId && text && this.visionUpdates.set(message.fileUniqueId, text)) {
				this.hooks.onEvent({ type: "vision", fileUniqueId: message.fileUniqueId, text });
			}
		} else if (message.type === "media_ready") {
			const { fileUniqueId, mediaPath } = message;
			if (
				fileUniqueId &&
				mediaPath &&
				!mediaPath.includes("\0") &&
				this.mediaReadyUpdates.set(fileUniqueId, mediaPath)
			) {
				this.hooks.onEvent({ type: "media", fileUniqueId, mediaPath });
			}
		} else if (message.type === "agent_stream") {
			this.hooks.onEvent({ type: "stream", stream: message.stream });
		}
	}

	private finishPendingSend(requestId: string, result: SendMessageResult): void {
		const pending = this.pendingSends.get(requestId);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingSends.delete(requestId);
		pending.resolve(result);
	}

	private failPendingSends(reason: string): void {
		for (const [requestId, pending] of this.pendingSends) {
			this.finishPendingSend(
				requestId,
				this.sendFailure(requestId, pending.botId, "unknown_outcome", `${reason}; check the group before retrying`),
			);
		}
	}

	private sendFailure(
		requestId: string,
		botId: string,
		code: SendMessageFailure["code"],
		error: string,
	): SendMessageFailure {
		return { requestId, botId, ok: false, code, error };
	}

	private emitFresh(type: "append" | "prepend", items: TimelineItem[]): void {
		const fresh = items
			.filter((item) => {
				const key = itemKey(item);
				if (this.seen.has(key)) return false;
				this.seen.add(key);
				const cursor = cursorOf(item);
				if (!this.oldestCursorValue || compareCursor(cursor, this.oldestCursorValue) < 0) {
					this.oldestCursorValue = cursor;
				}
				return true;
			})
			.map((item) => {
				if (item.kind !== "msg" || !item.fileUniqueId) return item;
				const vision = this.visionUpdates.get(item.fileUniqueId);
				const media = this.mediaReadyUpdates.get(item.fileUniqueId);
				return vision || media
					? { ...item, ...(vision ? { mediaDesc: vision } : {}), ...(media ? { mediaPath: media } : {}) }
					: item;
			});
		if (fresh.length > 0) this.hooks.onEvent({ type, items: fresh });
	}

	private emitStats(): void {
		this.hooks.onEvent({ type: "stats", stats: this.stats, statuses: this.statuses });
	}
}
