import { transaction as atomic } from "../db/db.ts";
// Long-polling loop for the bot token. Offset persisted in daemon_state.
// Reconnects with backoff on network/API errors; honors retry_after.

import type { DatabaseSync as Database } from "node:sqlite";
import { errorCategory, log } from "../observability/log.ts";
import { type BotApi, TelegramApiError } from "./api.ts";
import { ingestUpdate, type IngestResult } from "./ingest.ts";
import { getDaemonState, setDaemonState } from "../db/db.ts";

const POLL_TIMEOUT_SEC = 25;
const OFFSET_KEY = "update_offset";
const INGEST_FAILURE_WARN_THRESHOLD = 5;

export type MessageHandler = (result: IngestResult, update: unknown) => void | Promise<void>;
export type CallbackHandler = (update: unknown) => Promise<void>;

export class Poller {
	private db: Database;
	private groupChatId: number;
	private onMessage: MessageHandler;
	private stopped = false;
	private readonly abort = new AbortController();

	constructor(
		db: Database,
		private readonly api: BotApi,
		groupChatId: number,
		onMessage: MessageHandler,
		/** Inline-button presses (/set, /model menus). */
		private readonly onCallback?: CallbackHandler,
	) {
		this.db = db;
		this.groupChatId = groupChatId;
		this.onMessage = onMessage;
	}

	private offset(): number {
		return Number(getDaemonState(this.db, OFFSET_KEY) ?? "0");
	}

	stop(): void {
		this.stopped = true;
		this.abort.abort();
	}

	async run(): Promise<void> {
		let backoffMs = 1000;
		let ingestFailures = 0;
		let connected = false;
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
				if (!connected) {
					connected = true;
					log.info("telegram_poller", "connected", { pid: process.pid });
				}
				backoffMs = 1000;
			} catch (err) {
				// an abort rejection is the normal stop path, not an error
				if (this.stopped) break;
				if (err instanceof TelegramApiError && (err.code === 401 || err.code === 404)) {
					// auth-level failure: token invalid/revoked. Retry would never succeed — fail loudly.
					log.error("telegram_poller", "auth_failed", { telegram_code: err.code, fatal: true });
					throw err;
				}
				if (err instanceof TelegramApiError && err.retryAfter) {
					await this.sleep(err.retryAfter * 1000);
					continue;
				}
				if (err instanceof TelegramApiError && err.code === 409) {
					log.error("telegram_poller", "poll_conflict", { telegram_code: 409, retry_ms: 30_000 });
					await this.sleep(30_000);
					continue;
				}
				log.error("telegram_poller", "poll_failed", {
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
					// Model selection is idempotent. A crash before offset commit replays the same
					// selection; callbacks never become chat messages or route to an LLM.
					if ((update as { callback_query?: unknown }).callback_query && updateId >= this.offset())
						await this.onCallback?.(update);
					atomic(this.db, () => {
						const result = ingestUpdate(this.db, update, this.groupChatId);
						if (result.kind === "inserted" || result.kind === "edited") {
							this.db
								.prepare(
									"INSERT INTO pending_telegram_dispatch (update_id, kind, chat_id, message_id) VALUES (?, ?, ?, ?)",
								)
								.run(updateId, result.kind, result.chatId!, result.messageId!);
						}
						setDaemonState(this.db, OFFSET_KEY, String(updateId + 1));
					});
					ingestFailures = 0;
					if (!(await this.deliverPending())) {
						batchFailed = true;
						break;
					}
				} catch (err) {
					ingestFailures++;
					log.error("telegram_poller", "ingest_failed", {
						update_id: updateId,
						consecutive: ingestFailures,
						category: errorCategory(err),
					});
					if (ingestFailures >= INGEST_FAILURE_WARN_THRESHOLD) {
						log.warn("telegram_poller", "ingest_replay_pending", {
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
			.prepare(`SELECT p.update_id updateId, p.kind, p.chat_id chatId, p.message_id messageId, r.json
            FROM pending_telegram_dispatch p JOIN raw_updates r USING (update_id)`)
			.get() as unknown as (IngestResult & { updateId: number; json: string }) | null;
		if (!pending) return true;
		try {
			const { updateId, json, ...result } = pending;
			await this.onMessage(result, JSON.parse(json));
			this.db.prepare("DELETE FROM pending_telegram_dispatch WHERE update_id = ?").run(updateId);
			return true;
		} catch (error) {
			log.error("telegram_poller", "dispatch_pending", {
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
