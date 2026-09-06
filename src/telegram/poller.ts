// Long-polling loop for one bot token. Offset persisted in bot_state.
// Reconnects with backoff on network/API errors; honors retry_after.

import type { Database } from "bun:sqlite";
import { errorCategory, log } from "../observability/log.ts";
import { BotApi, TelegramApiError } from "./api.ts";
import { ingestUpdate, type IngestResult } from "./ingest.ts";
import { getBotState, setBotState } from "../db/db.ts";

const POLL_TIMEOUT_SEC = 25;
const OFFSET_KEY = "update_offset";
const INGEST_FAILURE_WARN_THRESHOLD = 5;

export type MessageHandler = (result: IngestResult, update: unknown, botId: string) => void | Promise<void>;

export class Poller {
	private api: BotApi;
	private botId: string;
	private db: Database;
	private groupPeerId: number;
	private onMessage: MessageHandler | null;
	private emitMediaUpdates: boolean;
	private stopped = false;
	private readonly abort = new AbortController();

	constructor(
		db: Database,
		botId: string,
		token: string,
		groupPeerId: number,
		onMessage: MessageHandler | null = null,
		/** Vision mode only: replay persisted media descriptions as media_update events. */
		emitMediaUpdates = true,
	) {
		this.db = db;
		this.botId = botId;
		this.api = new BotApi(token);
		this.groupPeerId = groupPeerId;
		this.onMessage = onMessage;
		this.emitMediaUpdates = emitMediaUpdates;
	}

	private offset(): number {
		return Number(getBotState(this.db, this.botId, OFFSET_KEY) ?? "0");
	}

	stop(): void {
		this.stopped = true;
		this.abort.abort();
	}

	async run(): Promise<void> {
		let backoffMs = 1000;
		let ingestFailures = 0;
		while (!this.stopped) {
			if (!(await this.deliverPending())) {
				await this.sleep(backoffMs);
				backoffMs = Math.min(backoffMs * 2, 60_000);
				continue;
			}
			if (this.stopped) break;
			let updates: unknown[];
			try {
				updates = await this.api.getUpdates(this.offset(), POLL_TIMEOUT_SEC, this.abort.signal);
				backoffMs = 1000;
			} catch (err) {
				// an abort rejection is the normal stop path, not an error
				if (this.stopped) break;
				if (err instanceof TelegramApiError && (err.code === 401 || err.code === 404)) {
					// auth-level failure: token invalid/revoked. Retry would never succeed — fail loudly.
					log.error("telegram_poller", "auth_failed", { bot_id: this.botId, telegram_code: err.code, fatal: true });
					throw err;
				}
				if (err instanceof TelegramApiError && err.retryAfter) {
					await this.sleep(err.retryAfter * 1000);
					continue;
				}
				if (err instanceof TelegramApiError && err.code === 409) {
					log.error("telegram_poller", "poll_conflict", { bot_id: this.botId, telegram_code: 409, retry_ms: 30_000 });
					await this.sleep(30_000);
					continue;
				}
				log.error("telegram_poller", "poll_failed", {
					bot_id: this.botId,
					category: errorCategory(err),
					retry_ms: backoffMs,
				});
				await this.sleep(backoffMs);
				backoffMs = Math.min(backoffMs * 2, 60_000);
				continue;
			}
			// shutdown may have happened while the long poll was in flight
			if (this.stopped) break;
			let batchFailed = false;
			for (const update of updates) {
				if (this.stopped) break;
				const updateId = (update as { update_id: number }).update_id;
				try {
					this.db.transaction(() => {
						const result = ingestUpdate(this.db, this.botId, update, this.groupPeerId, this.emitMediaUpdates);
						if (
							this.onMessage &&
							(result.kind === "inserted" || result.kind === "edited" || result.kind === "enriched")
						) {
							this.db
								.query(`INSERT INTO pending_telegram_dispatch
                                (bot_id, update_id, kind, chat_id, message_id, route_version) VALUES (?, ?, ?, ?, ?, ?)`)
								.run(this.botId, updateId, result.kind, result.chatId!, result.messageId!, result.routeVersion!);
						}
						setBotState(this.db, this.botId, OFFSET_KEY, String(updateId + 1));
					})();
					ingestFailures = 0;
					if (!(await this.deliverPending())) {
						batchFailed = true;
						break;
					}
				} catch (err) {
					ingestFailures++;
					log.error("telegram_poller", "ingest_failed", {
						bot_id: this.botId,
						update_id: updateId,
						consecutive: ingestFailures,
						category: errorCategory(err),
					});
					if (ingestFailures >= INGEST_FAILURE_WARN_THRESHOLD) {
						log.warn("telegram_poller", "ingest_replay_pending", {
							bot_id: this.botId,
							consecutive: ingestFailures,
							offset: this.offset(),
						});
					}
					// do not advance the offset past a failed update; stop this batch so later
					// updates don't skip over it. The whole remainder replays on the next poll.
					batchFailed = true;
					break;
				}
			}
			if (batchFailed) {
				await this.sleep(backoffMs);
				backoffMs = Math.min(backoffMs * 2, 60_000);
			}
		}
	}

	/** Acknowledge only after routing/control accepts the durable handoff. No Telegram refetch required. */
	private async deliverPending(): Promise<boolean> {
		const pending = this.db
			.query(`SELECT p.update_id updateId, p.kind, p.chat_id chatId,
            p.message_id messageId, p.route_version routeVersion, r.json
            FROM pending_telegram_dispatch p JOIN raw_updates r USING (bot_id, update_id)
            WHERE p.bot_id = ?`)
			.get(this.botId) as (IngestResult & { updateId: number; json: string }) | null;
		if (!pending) return true;
		try {
			if (!this.onMessage) throw new Error("routing handler unavailable");
			const { updateId, json, ...result } = pending;
			await this.onMessage(result, JSON.parse(json), this.botId);
			this.db
				.query("DELETE FROM pending_telegram_dispatch WHERE bot_id = ? AND update_id = ?")
				.run(this.botId, updateId);
			return true;
		} catch (error) {
			log.error("telegram_poller", "dispatch_pending", {
				bot_id: this.botId,
				update_id: pending.updateId,
				message_id: pending.messageId,
				category: errorCategory(error),
			});
			return false;
		}
	}

	/** Backoff that aborts early on stop() so shutdown never waits out a sleep. */
	private sleep(ms: number): Promise<void> {
		if (this.abort.signal.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				this.abort.signal.removeEventListener("abort", finish);
				resolve();
			};
			const timer = setTimeout(finish, ms);
			this.abort.signal.addEventListener("abort", finish, { once: true });
		});
	}
}
