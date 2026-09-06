// Operator text send service for additive IPC. Tokens and Telegram I/O stay in the daemon.

import type { Database } from "bun:sqlite";
import { errorCategory, log } from "../observability/log.ts";
import { createHash } from "node:crypto";
import type { SendMessageRequest, SendMessageResult } from "../ipc.ts";
import { TelegramApiError } from "../telegram/api.ts";
import {
	classifyTelegramCreateFailure,
	sendTextAndPersist,
	SentMessagePersistenceError,
	type TextSendApi,
} from "../telegram/send.ts";

export const TELEGRAM_TEXT_MAX_CHARS = 4096;
const REQUEST_ID_MAX = 128;
const REQUEST_CACHE_MAX = 256;

interface RequestEntry {
	fingerprint: string;
	settled: boolean;
	promise: Promise<SendMessageResult>;
}

export interface ManualSendNotification {
	botId: string;
	chatId: number;
	messageId: number;
}

export class ManualSendService {
	private readonly requests = new Map<string, RequestEntry>();

	constructor(
		private readonly db: Database,
		private readonly chatId: number,
		private readonly apis: ReadonlyMap<string, TextSendApi>,
		private readonly onSent?: (message: ManualSendNotification) => void,
	) {}

	send(input: SendMessageRequest): Promise<SendMessageResult> {
		const requestId = typeof input.requestId === "string" ? input.requestId : "";
		const botId = typeof input.botId === "string" ? input.botId : "";
		const text = typeof input.text === "string" ? input.text : "";
		const invalid = this.validate(requestId, botId, text);
		if (invalid) return Promise.resolve(invalid);

		const fingerprint = createHash("sha256").update(botId).update("\0").update(text).digest("hex");
		const existing = this.requests.get(requestId);
		if (existing) {
			if (existing.fingerprint === fingerprint) return existing.promise;
			return Promise.resolve({
				requestId,
				botId,
				ok: false,
				code: "request_conflict",
				error: "request id was already used for different content",
			});
		}

		if (!this.makeRoom()) {
			return Promise.resolve({
				requestId,
				botId,
				ok: false,
				code: "busy",
				error: "too many send requests are currently in flight",
			});
		}

		const entry = { fingerprint, settled: false } as RequestEntry;
		entry.promise = this.execute(requestId, botId, text).finally(() => {
			entry.settled = true;
		});
		this.requests.set(requestId, entry);
		return entry.promise;
	}

	private validate(requestId: string, botId: string, text: string): SendMessageResult | null {
		if (!requestId || requestId.length > REQUEST_ID_MAX || !/^[A-Za-z0-9._:-]+$/.test(requestId)) {
			return { requestId, botId, ok: false, code: "invalid_request", error: "invalid request id" };
		}
		if (!this.apis.has(botId)) {
			return { requestId, botId, ok: false, code: "unknown_bot", error: `unknown bot id: ${botId}` };
		}
		if (!text.trim()) {
			return { requestId, botId, ok: false, code: "invalid_request", error: "message text must not be empty" };
		}
		// Fast reject absurd payloads before allocating an Array.from copy; two UTF-16 code
		// units are the maximum representation size of one Unicode code point.
		if (text.length > TELEGRAM_TEXT_MAX_CHARS * 2 || Array.from(text).length > TELEGRAM_TEXT_MAX_CHARS) {
			return {
				requestId,
				botId,
				ok: false,
				code: "too_long",
				error: `message exceeds Telegram's ${TELEGRAM_TEXT_MAX_CHARS}-character limit`,
			};
		}
		return null;
	}

	private makeRoom(): boolean {
		if (this.requests.size < REQUEST_CACHE_MAX) return true;
		for (const [requestId, entry] of this.requests) {
			if (!entry.settled) continue;
			this.requests.delete(requestId);
			return true;
		}
		return false;
	}

	private async execute(requestId: string, botId: string, text: string): Promise<SendMessageResult> {
		const api = this.apis.get(botId)!;
		try {
			const { canonical } = await sendTextAndPersist(this.db, api, botId, this.chatId, text);
			try {
				this.onSent?.({ botId, chatId: canonical.chat_id, messageId: canonical.message_id });
			} catch (error) {
				log.error("manual_send", "broadcast_failed", {
					bot_id: botId,
					request_id: requestId,
					category: errorCategory(error),
				});
			}
			log.info("manual_send", "committed", { bot_id: botId, request_id: requestId, message_id: canonical.message_id });
			return { requestId, botId, ok: true, chatId: canonical.chat_id, messageId: canonical.message_id };
		} catch (error) {
			if (error instanceof SentMessagePersistenceError) {
				log.error("manual_send", "persistence_failed", { bot_id: botId, request_id: requestId, outcome: "unknown" });
				return {
					requestId,
					botId,
					ok: false,
					code: "unknown_outcome",
					error: "Telegram may have accepted the message, but local persistence failed; do not retry automatically",
				};
			}
			const failure = classifyTelegramCreateFailure(error);
			const telegramCode = error instanceof TelegramApiError ? error.code : null;
			log.error("manual_send", "telegram_create_failed", {
				bot_id: botId,
				request_id: requestId,
				telegram_code: telegramCode ?? "unknown",
			});
			return {
				requestId,
				botId,
				ok: false,
				code: failure.outcome === "unknown" ? "unknown_outcome" : "telegram_error",
				error:
					failure.outcome === "unknown"
						? "Telegram send result is unknown; check the group before retrying"
						: `Telegram send failed (${telegramCode})`,
			};
		}
	}
}
