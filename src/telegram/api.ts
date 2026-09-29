// Minimal Telegram Bot API client over fetch. No third-party SDK.
// Docs: https://core.telegram.org/bots/api

import type { TelegramMessageEntity } from "./markdown.ts";

const API_BASE = "https://api.telegram.org";
const CALL_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const CHAT_ACTION_TIMEOUT_MS = 3500;
// headroom on top of the long-poll window so the server-side timeout fires first
const LONG_POLL_GRACE_MS = 10_000;

export class TelegramApiError extends Error {
	code: number;
	description: string;
	retryAfter: number | null;
	/** `api`: structured Bot API error body; `non_json`: an intermediary answered with HTML/text. */
	kind: "api" | "non_json";
	constructor(code: number, description: string, retryAfter: number | null = null, kind: "api" | "non_json" = "api") {
		super(`telegram api error ${code}: ${description}`);
		this.code = code;
		this.description = description;
		this.retryAfter = retryAfter;
		this.kind = kind;
	}
}

interface ApiResponse<T> {
	ok: boolean;
	result?: T;
	error_code?: number;
	description?: string;
	parameters?: { retry_after?: number };
}

export interface InlineKeyboardMarkup {
	inline_keyboard: { text: string; callback_data: string }[][];
}

export class BotApi {
	token: string;
	constructor(token: string) {
		this.token = token;
	}

	async call<T = unknown>(
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs: number = CALL_TIMEOUT_MS,
		externalSignal?: AbortSignal,
	): Promise<T> {
		const signal = externalSignal
			? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs);
		const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(params),
			signal,
		});
		let body: ApiResponse<T>;
		try {
			body = (await res.json()) as ApiResponse<T>;
		} catch {
			// intermediaries can answer with HTML/text (e.g. 502 pages); keep the HTTP status
			throw new TelegramApiError(res.status, `non-JSON response (HTTP ${res.status})`, null, "non_json");
		}
		if (!body.ok) {
			throw new TelegramApiError(
				body.error_code ?? res.status,
				body.description ?? "unknown",
				body.parameters?.retry_after ?? null,
			);
		}
		return body.result as T;
	}

	getMe(): Promise<{ id: number; username: string; first_name: string; is_bot: boolean }> {
		return this.call("getMe");
	}

	getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<unknown[]> {
		return this.call(
			"getUpdates",
			{
				offset,
				timeout: timeoutSec,
				allowed_updates: ["message", "edited_message", "callback_query"],
			},
			timeoutSec * 1000 + LONG_POLL_GRACE_MS,
			signal,
		);
	}

	setMyCommands(commands: readonly { command: string; description: string }[]): Promise<true> {
		return this.call<true>("setMyCommands", { commands });
	}

	sendMessage(
		chatId: number,
		text: string,
		replyToMessageId?: number,
		replyMarkup?: InlineKeyboardMarkup,
	): Promise<Record<string, unknown>> {
		return this.call("sendMessage", {
			chat_id: chatId,
			text,
			...(replyMarkup ? { reply_markup: replyMarkup } : {}),
			...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
		});
	}

	answerCallbackQuery(id: string, text?: string): Promise<true> {
		return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text, show_alert: true } : {}) });
	}

	editMessageText(
		chatId: number,
		messageId: number,
		text: string,
		replyMarkup: InlineKeyboardMarkup,
	): Promise<Record<string, unknown>> {
		return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup });
	}

	sendMessageWithEntities(
		chatId: number,
		text: string,
		entities: readonly TelegramMessageEntity[],
		replyToMessageId?: number,
	): Promise<Record<string, unknown>> {
		return this.call("sendMessage", {
			chat_id: chatId,
			text,
			...(entities.length > 0 ? { entities } : {}),
			...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
		});
	}

	sendRichMessage(chatId: number, markdown: string, replyToMessageId?: number): Promise<Record<string, unknown>> {
		return this.call("sendRichMessage", {
			chat_id: chatId,
			rich_message: { markdown },
			...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
		});
	}

	sendSticker(chatId: number, fileId: string, replyToMessageId?: number): Promise<Record<string, unknown>> {
		return this.call("sendSticker", {
			chat_id: chatId,
			sticker: fileId,
			...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
		});
	}

	/** Bots get one non-paid reaction per message; re-setting the same emoji is idempotent. */
	setMessageReaction(chatId: number, messageId: number, emoji: string): Promise<true> {
		return this.call<true>("setMessageReaction", {
			chat_id: chatId,
			message_id: messageId,
			reaction: [{ type: "emoji", emoji }],
		});
	}

	/** Current deployment's group-capable processing indicator; draft Thinking is private-only. */
	sendChatAction(chatId: number, signal?: AbortSignal): Promise<true> {
		return this.call<true>("sendChatAction", { chat_id: chatId, action: "typing" }, CHAT_ACTION_TIMEOUT_MS, signal);
	}

	getFile(
		fileId: string,
		signal?: AbortSignal,
	): Promise<{ file_id: string; file_unique_id: string; file_path?: string }> {
		return this.call("getFile", { file_id: fileId }, CALL_TIMEOUT_MS, signal);
	}

	async downloadFile(filePath: string, externalSignal?: AbortSignal): Promise<Uint8Array> {
		const signal = externalSignal
			? AbortSignal.any([externalSignal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
			: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
		const res = await fetch(`${API_BASE}/file/bot${this.token}/${filePath}`, {
			signal,
		});
		if (!res.ok) throw new TelegramApiError(res.status, `file download failed: ${filePath}`);
		return new Uint8Array(await res.arrayBuffer());
	}
}

// The fixed ReactionTypeEmoji enum (https://core.telegram.org/bots/api#reactiontypeemoji,
// captured 2026-09-21). Both sides strip U+FE0F variation selectors, so "❤" and "❤️"
// spellings of the same emoji are equivalent; ZWJ sequences stay explicit.
const REACTION_EMOJIS: ReadonlySet<string> = new Set(
	[
		"❤",
		"👍",
		"👎",
		"🔥",
		"🥰",
		"👏",
		"😁",
		"🤔",
		"🤯",
		"😱",
		"🤬",
		"😢",
		"🎉",
		"🤩",
		"🤮",
		"💩",
		"🙏",
		"👌",
		"🕊",
		"🤡",
		"🥱",
		"🥴",
		"😍",
		"🐳",
		"❤\u200d🔥",
		"🌚",
		"🌭",
		"💯",
		"🤣",
		"⚡",
		"🍌",
		"🏆",
		"💔",
		"🤨",
		"😐",
		"🍓",
		"🍾",
		"💋",
		"🖕",
		"😈",
		"😴",
		"😭",
		"🤓",
		"👻",
		"👨\u200d💻",
		"👀",
		"🎃",
		"🙈",
		"😇",
		"😨",
		"🤝",
		"✍",
		"🤗",
		"🫡",
		"🎅",
		"🎄",
		"☃",
		"💅",
		"🤪",
		"🗿",
		"🆒",
		"💘",
		"🙉",
		"🦄",
		"😘",
		"💊",
		"🙊",
		"😎",
		"👾",
		"🤷\u200d♂",
		"🤷",
		"🤷\u200d♀",
		"😡",
	].map((emoji) => emoji.replaceAll("\ufe0f", "")),
);

/** Telegram rejects any emoji outside its fixed reaction enum with REACTION_INVALID. */
export function isReactionEmoji(value: string): boolean {
	return REACTION_EMOJIS.has(value.replaceAll("\ufe0f", ""));
}
