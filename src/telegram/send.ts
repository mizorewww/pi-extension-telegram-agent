// Shared Telegram send -> canonical DB transaction used by agent tools and operator IPC.

import type { Database } from "bun:sqlite";
import { TelegramApiError, type InlineKeyboardMarkup } from "./api.ts";
import { insertSentMessage } from "./ingest.ts";
import { formatTelegramMarkdown, TelegramMarkdownError, type TelegramMessageEntity } from "./markdown.ts";
import type { CanonicalMessage } from "./normalize.ts";

export interface TextSendApi {
	sendMessage(
		chatId: number,
		text: string,
		replyToMessageId?: number,
		replyMarkup?: InlineKeyboardMarkup,
	): Promise<Record<string, unknown>>;
}

export interface MarkdownTextSendApi extends TextSendApi {
	sendMessageWithEntities(
		chatId: number,
		text: string,
		entities: readonly TelegramMessageEntity[],
		replyToMessageId?: number,
	): Promise<Record<string, unknown>>;
}

export type SentMessageTransport = "plain" | "formatted" | "plain_fallback" | "sticker";

export class SentMessagePersistenceError extends Error {
	constructor(
		public readonly cause: unknown,
		public readonly raw: Record<string, unknown>,
		public readonly transport: SentMessageTransport,
	) {
		super("Telegram accepted the message but canonical persistence failed");
		this.name = "SentMessagePersistenceError";
	}
}

const SQLITE_BUSY_RETRY_DELAYS_MS = [25, 100, 250] as const;

/** SQLite reports BUSY/LOCKED synchronously; these retries never repeat Telegram I/O. */
function isSqliteBusy(error: unknown): boolean {
	const value = error as { code?: unknown; errno?: unknown; message?: unknown } | null;
	const code = typeof value?.code === "string" ? value.code.toUpperCase() : "";
	if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
	if (value?.errno === 5 || value?.errno === 6) return true;
	const message = typeof value?.message === "string" ? value.message.toLowerCase() : "";
	return message.includes("database is locked") || message.includes("database is busy");
}

export function localFailureCategory(error: unknown): "sqlite_busy" | "sqlite_closed" | "local_failure" {
	if (isSqliteBusy(error)) return "sqlite_busy";
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	if (message.includes("database") && (message.includes("closed") || message.includes("not open"))) {
		return "sqlite_closed";
	}
	return "local_failure";
}

export interface TelegramCreateFailure {
	outcome: "rejected" | "unknown";
	category:
		| "invalid_request"
		| "telegram_4xx"
		| "rate_limited"
		| "timeout"
		| "server_error"
		| "non_json"
		| "network_error";
}

/**
 * Only a structured, non-timeout Telegram 4xx proves that no message was created.
 * Everything else crosses an unknown commit boundary and must not be retried.
 */
export function classifyTelegramCreateFailure(error: unknown): TelegramCreateFailure {
	if (error instanceof TelegramMarkdownError) return { outcome: "rejected", category: "invalid_request" };
	if (error instanceof TelegramApiError) {
		if (error.kind === "non_json") return { outcome: "unknown", category: "non_json" };
		if (error.code === 408) return { outcome: "unknown", category: "timeout" };
		if (error.code === 429) return { outcome: "unknown", category: "rate_limited" };
		if (error.code >= 500) return { outcome: "unknown", category: "server_error" };
		if (error.code >= 400 && error.code < 500) return { outcome: "rejected", category: "telegram_4xx" };
		return { outcome: "unknown", category: "network_error" };
	}
	const name = error instanceof Error ? error.name : "";
	if (name === "TimeoutError" || name === "AbortError") return { outcome: "unknown", category: "timeout" };
	return { outcome: "unknown", category: "network_error" };
}

export async function retrySqliteBusy<T>(operation: () => T): Promise<T> {
	let attempt = 0;
	while (true) {
		try {
			return operation();
		} catch (error) {
			const delay = SQLITE_BUSY_RETRY_DELAYS_MS[attempt++];
			if (!isSqliteBusy(error) || delay == null) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
		}
	}
}

/** Persist only the local projection; callers must never wrap this in a Telegram retry. */
export async function persistSentMessageWithRetry(
	db: Database,
	botId: string,
	raw: Record<string, unknown>,
	transport: SentMessageTransport,
	/** Vision mode only: a cached description of the sent media replays as a media_update event. */
	emitMediaUpdates = true,
): Promise<CanonicalMessage> {
	try {
		return await retrySqliteBusy(() => insertSentMessage(db, botId, raw, emitMediaUpdates));
	} catch (error) {
		throw new SentMessagePersistenceError(error, raw, transport);
	}
}

export async function sendTextAndPersist(
	db: Database,
	api: TextSendApi,
	botId: string,
	chatId: number,
	text: string,
	replyToMessageId?: number,
	replyMarkup?: InlineKeyboardMarkup,
): Promise<{ raw: Record<string, unknown>; canonical: CanonicalMessage }> {
	const raw = await api.sendMessage(chatId, text, replyToMessageId, replyMarkup);
	return { raw, canonical: await persistSentMessageWithRetry(db, botId, raw, "plain") };
}

const PARSE_REJECTIONS = ["can't parse", "cannot parse", "failed to parse", "parse error"];
const ENTITY_REJECTIONS = [
	...PARSE_REJECTIONS,
	"message entit",
	"entity offset",
	"entity length",
	"entities are not valid",
];
/** A 400 whose description proves Telegram rejected the format before creating any message. */
function isFormatRejection(error: unknown, phrases: readonly string[]): error is TelegramApiError {
	if (!(error instanceof TelegramApiError) || error.kind !== "api" || error.code !== 400) return false;
	const description = error.description.toLowerCase();
	return phrases.some((phrase) => description.includes(phrase));
}

/** Agent Markdown send with one safe entity-free fallback and exactly-once persistence. */
export async function sendMarkdownTextAndPersist(
	db: Database,
	api: MarkdownTextSendApi,
	botId: string,
	chatId: number,
	markdown: string,
	replyToMessageId?: number,
): Promise<{
	raw: Record<string, unknown>;
	canonical: CanonicalMessage;
	transport: "formatted" | "plain_fallback";
}> {
	const formatted = formatTelegramMarkdown(markdown);
	let raw: Record<string, unknown>;
	let transport: "formatted" | "plain_fallback" = "formatted";
	try {
		raw = await api.sendMessageWithEntities(chatId, formatted.text, formatted.entities, replyToMessageId);
	} catch (error) {
		if (!isFormatRejection(error, ENTITY_REJECTIONS)) throw error;
		transport = "plain_fallback";
		raw = await api.sendMessage(chatId, formatted.text, replyToMessageId);
	}
	return { raw, canonical: await persistSentMessageWithRetry(db, botId, raw, transport), transport };
}
