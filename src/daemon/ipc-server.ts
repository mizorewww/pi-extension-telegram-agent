// IPC server inside the daemon: serves snapshots/history from SQLite and broadcasts live items.

import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { errorCategory, log } from "../observability/log.ts";
import { rmSync, existsSync, chmodSync } from "node:fs";
import type {
	TimelineItem,
	MsgItem,
	EvtItem,
	ClientRequest,
	ServerMessage,
	TimelineCursor,
	StatsSnapshot,
	VisionUpdate,
	MediaReadyUpdate,
	AgentStreamFrame,
	SendMessageRequest,
	SendMessageResult,
	RuntimeControlSnapshot,
} from "../ipc.ts";
import { encodeFrame, FrameDecoder, FrameOverflowError } from "../ipc.ts";
import type { MessageRow } from "../agent/serialize.ts";
import { isDisplayReadyPath, resolveMediaCachePath } from "../media/local-cache.ts";
import { loadBotStats } from "../db/usage.ts";

const SNAPSHOT_LIMIT = 100;
const HISTORY_LIMIT = 100;
const HISTORY_LIMIT_MAX = 500; // REQ-IPC-0001 R4: server-side clamp
const QUEUE_MAX_BYTES = 1024 * 1024; // R2: outbound queue bound; overflow kicks the listener

interface SocketLike {
	write: (d: string | Uint8Array, byteOffset?: number) => number;
	end: () => void;
}

interface OutQueue {
	chunks: Uint8Array[];
	total: number;
}

export type ManualSendHandler = (request: SendMessageRequest) => Promise<SendMessageResult>;
export type RuntimeSnapshotProvider = (botId: string) => RuntimeControlSnapshot | undefined;

export class IpcServer {
	private db: Database;
	private sockPath: string;
	private botNames: Map<string, string>;
	private botUserIds: Map<string, number>;
	private mediaDir: string;
	private listeners = new Set<SocketLike>();
	private decoders = new Map<object, FrameDecoder>();
	private outQueues = new Map<object, OutQueue>();
	/** Per-listener bot filter from hello (REQ-UI-0002); null = global view. */
	private filters = new Map<object, string | null>();
	private encoder = new TextEncoder();
	private server: ReturnType<typeof Bun.listen> | null = null;

	constructor(
		db: Database,
		sockPath: string,
		botNames: Map<string, string>,
		botUserIds: Map<string, number>,
		private readonly manualSend: ManualSendHandler,
		private readonly runtimeSnapshot: RuntimeSnapshotProvider,
	) {
		this.db = db;
		this.sockPath = sockPath;
		this.mediaDir = join(dirname(sockPath), "media");
		this.botNames = botNames;
		this.botUserIds = botUserIds;
	}

	/** Remove a listener: drop its queue and close the socket. Idempotent. */
	private kick(socket: SocketLike, reason: string): void {
		if (!this.listeners.has(socket)) return;
		log.warn("ipc", "listener_disconnected", { reason });
		this.listeners.delete(socket);
		this.decoders.delete(socket);
		this.outQueues.delete(socket);
		this.filters.delete(socket);
		try {
			socket.end();
		} catch {
			// already closed
		}
	}

	/**
	 * Bun socket.write is unbuffered, byte-oriented, and may accept only part of a frame;
	 * queue the rest for drain. A negative return means the socket is closed — dropping the
	 * frame silently would wedge the queue forever (subarray(-1) bug), so we kick the listener.
	 * The queue is bounded: a stalled listener (Ctrl+Z'd TUI) gets disconnected instead of
	 * growing daemon memory unboundedly.
	 */
	private writeFrame(socket: SocketLike, frame: string): void {
		const bytes = this.encoder.encode(frame);
		const queue = this.outQueues.get(socket) ?? { chunks: [], total: 0 };
		if (queue.chunks.length > 0) {
			queue.chunks.push(bytes);
			queue.total += bytes.length;
			if (queue.total > QUEUE_MAX_BYTES) this.kick(socket, "outbound queue overflow");
			return;
		}
		const n = socket.write(bytes);
		if (n < 0) {
			this.kick(socket, "socket write failed");
			return;
		}
		if (n < bytes.length) {
			queue.chunks.push(bytes.subarray(n));
			queue.total = bytes.length - n;
		}
		this.outQueues.set(socket, queue);
	}

	private flushQueue(socket: SocketLike): void {
		const queue = this.outQueues.get(socket);
		if (!queue) return;
		while (queue.chunks.length > 0) {
			const head = queue.chunks[0];
			const n = socket.write(head);
			if (n < 0) {
				this.kick(socket, "socket write failed during drain");
				return;
			}
			if (n < head.length) {
				queue.chunks[0] = head.subarray(n);
				queue.total -= n;
				return;
			}
			queue.total -= head.length;
			queue.chunks.shift();
		}
	}

	start(): void {
		if (existsSync(this.sockPath)) rmSync(this.sockPath);
		this.server = Bun.listen({
			unix: this.sockPath,
			socket: {
				open: (socket) => {
					log.info("ipc", "client_connected");
					this.listeners.add(socket);
					this.decoders.set(socket, new FrameDecoder());
					this.outQueues.set(socket, { chunks: [], total: 0 });
				},
				data: (socket, chunk) => {
					try {
						const decoder = this.decoders.get(socket);
						if (!decoder) return;
						for (const frame of decoder.push(chunk)) {
							this.handleRequest(socket, frame as ClientRequest);
						}
					} catch (err) {
						if (err instanceof FrameOverflowError) {
							this.kick(socket, "receive buffer overflow");
							return;
						}
						log.error("ipc", "request_failed", { category: errorCategory(err) });
					}
				},
				drain: (socket) => {
					this.flushQueue(socket);
				},
				close: (socket) => {
					this.listeners.delete(socket);
					this.outQueues.delete(socket);
					this.decoders.delete(socket);
					this.filters.delete(socket);
				},
				error: (_socket, err) => {
					log.error("ipc", "socket_failed", { category: errorCategory(err) });
				},
			},
		});
		// Local socket is unauthenticated: restrict to the daemon's owner (REQ-IPC-0001 R4).
		chmodSync(this.sockPath, 0o600);
		log.info("ipc", "listening", { socket_ready: true });
	}

	stop(): void {
		this.server?.stop(true);
		if (existsSync(this.sockPath)) rmSync(this.sockPath);
	}

	/**
	 * Listeners that completed hello and observe `botId` (null = bot-agnostic frame). A global
	 * listener sees every bot; a filtered listener only its own.
	 */
	private listenersFor(botId: string | null): SocketLike[] {
		const targets: SocketLike[] = [];
		for (const socket of this.listeners) {
			if (!this.filters.has(socket)) continue;
			const filter = this.filters.get(socket) ?? null;
			if (botId == null || !filter || filter === botId) targets.push(socket);
		}
		return targets;
	}

	private broadcastTo(botId: string | null, message: ServerMessage): void {
		const targets = this.listenersFor(botId);
		if (targets.length === 0) return;
		const frame = encodeFrame(message);
		for (const socket of targets) this.writeFrame(socket, frame);
	}

	/** Push a live item to attached TUIs; group messages are shared, agent events follow the bot filter. */
	broadcast(item: TimelineItem): void {
		this.broadcastTo(item.kind === "evt" ? item.botId : null, { type: "append", item });
	}

	/** Push one bot's freshly aggregated stats; listeners never re-aggregate runs themselves. */
	broadcastUsage(botId: string): void {
		if (this.listenersFor(botId).length === 0) return;
		const status = this.runtimeSnapshot(botId);
		this.broadcastTo(botId, {
			type: "usage",
			botId,
			stats: loadBotStats(this.db, botId),
			...(status ? { status } : {}),
		});
	}

	/** Push one shared media description to every live transcript (REQ-UI-0006). */
	broadcastVision(update: VisionUpdate): void {
		this.broadcastTo(null, { type: "vision_update", ...update });
	}

	/** Push one owner-only local media path to every live transcript (REQ-UI-0014). */
	broadcastMediaReady(update: MediaReadyUpdate): void {
		this.broadcastTo(null, { type: "media_ready", ...update });
	}

	/** Push an ephemeral assistant snapshot only to listeners observing its bot. */
	broadcastStream(stream: AgentStreamFrame): void {
		this.broadcastTo(stream.botId, { type: "agent_stream", stream });
	}

	hasStreamListener(botId: string): boolean {
		return this.listenersFor(botId).length > 0;
	}

	private handleRequest(socket: SocketLike, req: ClientRequest): void {
		if (req.type !== "hello" && !this.filters.has(socket)) {
			this.kick(socket, "hello required");
			return;
		}
		if (req.type === "hello") {
			const filter = typeof req.filter === "string" && this.botNames.has(req.filter) ? req.filter : null;
			if (req.filter && !filter) {
				log.warn("ipc", "unknown_filter", { filter: req.filter });
				this.kick(socket, "unknown bot filter");
				return;
			}
			this.filters.set(socket, filter);
			const frame = encodeFrame({
				type: "snapshot",
				items: this.loadTimeline(null, SNAPSHOT_LIMIT, filter),
				stats: this.loadStats(filter),
			} satisfies ServerMessage);
			this.writeFrame(socket, frame);
		} else if (req.type === "history") {
			// R4: clamp the limit server-side; a crafted 1e9 must not read the whole table.
			const limit = Math.min(Math.max(1, Math.floor(req.limit) || HISTORY_LIMIT), HISTORY_LIMIT_MAX);
			const cursor: TimelineCursor | null = req.before ?? null;
			const items = this.loadTimeline(cursor, limit, this.filters.get(socket) ?? null);
			this.writeFrame(
				socket,
				encodeFrame({ type: "history", items, hasMore: items.length >= limit } satisfies ServerMessage),
			);
		} else if (req.type === "send_message") {
			void this.handleManualSend(socket, req);
		}
	}

	private async handleManualSend(socket: SocketLike, request: SendMessageRequest): Promise<void> {
		let result: SendMessageResult;
		try {
			result = await this.manualSend(request);
		} catch (error) {
			log.error("ipc", "manual_send_failed", { category: errorCategory(error) });
			result = {
				requestId: typeof request.requestId === "string" ? request.requestId : "",
				botId: typeof request.botId === "string" ? request.botId : "",
				ok: false,
				code: "internal_error",
				error: "manual Telegram send failed internally",
			};
		}
		// The request may finish after the client disconnects. Persistence/broadcast remains
		// valid, but there is no ACK destination and the client must treat that as unknown.
		if (!this.listeners.has(socket)) return;
		this.writeFrame(socket, encodeFrame({ type: "send_result", ...result } satisfies ServerMessage));
	}

	/**
	 * Merged timeline (messages + agent events) strictly before `cursor` (or the newest items
	 * when cursor is null), ascending. Order key is (ts, rank, id): rank 0 = events, 1 = messages.
	 * Each table is queried with the cursor bound and its newest `limit` rows taken; the union's
	 * newest `limit` must lie within them, so the merge is lossless (R3).
	 */
	private loadTimeline(cursor: TimelineCursor | null, limit: number, filter: string | null = null): TimelineItem[] {
		const ts = cursor?.ts ?? Number.MAX_SAFE_INTEGER;
		const id = cursor?.id ?? Number.MAX_SAFE_INTEGER;
		const rank = cursor?.rank ?? 1;
		const msgs = this.db
			.query(
				`SELECT * FROM messages
				 WHERE (date * 1000 < ?1) OR (?2 = 1 AND date * 1000 = ?1 AND message_id < ?3)
				 ORDER BY date DESC, message_id DESC LIMIT ?4`,
			)
			.all(ts, rank, id, limit) as MessageRow[];
		const evts = (
			filter
				? this.db
						.query(
							`SELECT * FROM agent_events
							 WHERE bot_id = ?5
							   AND (kind = 'agent_activity' OR json_extract(payload, '$.activity_id') IS NULL)
							   AND ((ts < ?1) OR (?2 = 0 AND ts = ?1 AND id < ?3) OR (?2 = 1 AND ts = ?1))
							 ORDER BY ts DESC, id DESC LIMIT ?4`,
						)
						.all(ts, rank, id, limit, filter)
				: this.db
						.query(
							`SELECT * FROM agent_events
							 WHERE (kind = 'agent_activity' OR json_extract(payload, '$.activity_id') IS NULL)
							   AND ((ts < ?1) OR (?2 = 0 AND ts = ?1 AND id < ?3) OR (?2 = 1 AND ts = ?1))
							 ORDER BY ts DESC, id DESC LIMIT ?4`,
						)
						.all(ts, rank, id, limit)
		) as { id: number; bot_id: string; ts: number; kind: string; payload: string }[];

		const items: TimelineItem[] = [...msgs.map((m) => this.msgToItem(m)), ...evts.map((e) => this.evtToItem(e))];
		items.sort((a, b) => keyOf(a) - keyOf(b) || rankOf(a) - rankOf(b) || idOf(a) - idOf(b));
		return items.slice(-limit);
	}

	msgToItem(m: MessageRow): MsgItem {
		let botId: string | null = null;
		if (m.is_bot) {
			for (const [id, userId] of this.botUserIds) {
				if (m.sender_id === userId) botId = id;
			}
		}
		let mediaKind: string | null = null;
		let stickerEmoji: string | null = null;
		let mediaPath: string | null = null;
		let mediaDesc: string | null = null;
		let fileUniqueId: string | null = null;
		if (m.media) {
			const media = JSON.parse(m.media) as { kind: string; sticker_emoji?: string; file_unique_id?: string };
			mediaKind = media.kind;
			stickerEmoji = media.sticker_emoji ?? null;
			if (media.file_unique_id) {
				fileUniqueId = media.file_unique_id;
				const row = this.db
					.query("SELECT local_path, vision FROM media WHERE file_unique_id = ?")
					.get(media.file_unique_id) as { local_path: string | null; vision: string | null } | null;
				if (row) {
					const resolved = resolveMediaCachePath(this.mediaDir, row.local_path);
					mediaPath = isDisplayReadyPath(resolved) ? resolved : null;
					if (row.vision) {
						const v = JSON.parse(row.vision) as { text: string | null };
						mediaDesc = v.text?.trim() || null;
					}
				}
			}
		}
		return {
			kind: "msg",
			ts: m.date * 1000,
			chatId: m.chat_id,
			messageId: m.message_id,
			senderName: m.display_name ?? "?",
			username: m.username,
			isBot: Boolean(m.is_bot),
			botId,
			text: m.text ?? m.caption,
			mediaKind,
			stickerEmoji,
			mediaPath,
			mediaDesc,
			fileUniqueId,
			replyTo: m.reply_to_message_id,
			edited: m.edit_date != null,
		};
	}

	/** Full-history cumulative stats per bot (REQ-UI-0003 R2/R3: daemon-side aggregation). */
	private loadStats(filter: string | null): StatsSnapshot {
		const bots = filter ? [filter] : [...this.botNames.keys()];
		const out: StatsSnapshot = { bots: {}, statuses: {} };
		for (const botId of bots) {
			out.bots[botId] = loadBotStats(this.db, botId);
			const status = this.runtimeSnapshot(botId);
			if (status) out.statuses[botId] = status;
		}
		return out;
	}

	evtToItem(e: { id: number; bot_id: string; ts: number; kind: string; payload: string }): EvtItem {
		return {
			kind: "evt",
			ts: e.ts,
			evtId: e.id,
			botId: e.bot_id,
			botName: this.botNames.get(e.bot_id) ?? e.bot_id,
			evtKind: e.kind,
			payload: e.payload,
		};
	}
}

function keyOf(i: TimelineItem): number {
	return i.ts;
}
function rankOf(i: TimelineItem): number {
	return i.kind === "evt" ? 0 : 1;
}
function idOf(i: TimelineItem): number {
	return i.kind === "evt" ? (i.evtId ?? 0) : i.messageId;
}
