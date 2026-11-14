import type { ManualCompactResult } from "../agent/runtime.ts";
import { extractUpdateMessage } from "./normalize.ts";

const MAX_REPLY_CHARS = 3500;
const MAX_LABEL_CHARS = 64;

export interface ControlSender {
	id: number | null;
	isBot: boolean;
	hasSenderChat: boolean;
}

export type TelegramControlAction =
	| { kind: "help" }
	| { kind: "status" }
	| { kind: "compact" }
	| { kind: "new" }
	| { kind: "model"; data?: string }
	| { kind: "box_reset" }
	| { kind: "task_status" }
	| { kind: "task_cancel"; taskId: string }
	| { kind: "usage" };

/** The command parser, help and Telegram menu share one list. */
export const CONTROL_COMMANDS = [
	["help", "命令与用法", "/help"],
	["status", "状态与用量", "/status"],
	["model", "选择 Pi 可用模型（管理员）", "/model（管理员）"],
	["compact", "压缩上下文（管理员）", "/compact（管理员）"],
	["new", "开启新会话（管理员）", "/new（管理员）"],
	["task", "后台任务与定时任务", "/task [status] · /task cancel <tN|cN>（管理员）"],
	["box", "清空工作区（管理员）", "/box reset（管理员）"],
] as const;
export type TelegramControlCommandToken = (typeof CONTROL_COMMANDS)[number][0];
const COMMAND_TOKENS: ReadonlySet<string> = new Set(CONTROL_COMMANDS.map(([command]) => command));

export interface ParsedTelegramControlCommand {
	chatId: number;
	messageId: number;
	edited: boolean;
	sender: ControlSender;
	action: TelegramControlAction;
	callbackQueryId?: string;
}

/** Callback messages never enter canonical ingestion or routing. Accept only this deployment's group. */
export function parseTelegramControlCallback(
	update: unknown,
	groupChatId: number,
): ParsedTelegramControlCommand | null {
	const query = (update as { callback_query?: Record<string, any> } | null)?.callback_query;
	if (
		!query ||
		typeof query.id !== "string" ||
		typeof query.data !== "string" ||
		!query.data.startsWith("model:") ||
		Buffer.byteLength(query.data) > 64
	)
		return null;
	const message = query.message;
	if (message?.chat?.id !== groupChatId || !Number.isSafeInteger(message.message_id) || message.message_id <= 0)
		return null;
	return {
		chatId: groupChatId,
		messageId: message.message_id,
		edited: false,
		callbackQueryId: query.id,
		sender: {
			id: Number.isSafeInteger(query.from?.id) && query.from.id > 0 ? query.from.id : null,
			isBot: query.from?.is_bot === true,
			hasSenderChat: message.sender_chat != null && message.from?.is_bot !== true,
		},
		action: { kind: "model", data: query.data },
	};
}

/**
 * Parse only Telegram's offset-zero bot_command entity. Telegram entity offsets are UTF-16
 * code units, which is exactly what JavaScript slice() consumes.
 */
export function parseTelegramControlCommand(update: unknown, botUsername: string): ParsedTelegramControlCommand | null {
	const payload = extractUpdateMessage(update);
	if (!payload) return null;
	const message = payload.message as Record<string, unknown>;
	const source =
		typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : null;
	const entities = typeof message.text === "string" ? message.entities : message.caption_entities;
	if (source == null || !Array.isArray(entities)) return null;
	const entity = entities.find((candidate) => {
		if (!candidate || typeof candidate !== "object") return false;
		const value = candidate as Record<string, unknown>;
		return value.type === "bot_command" && value.offset === 0;
	}) as Record<string, unknown> | undefined;
	if (!entity || typeof entity.length !== "number" || !Number.isSafeInteger(entity.length) || entity.length <= 0)
		return null;
	const commandToken = source.slice(0, entity.length);
	const match = commandToken.match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]{5,32}))?$/i);
	if (!match || !COMMAND_TOKENS.has(match[1]!.toLowerCase())) return null;
	const token = match[1]!.toLowerCase() as TelegramControlCommandToken;

	// `/status@other_bot` belongs to another bot in the group.
	if (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase()) return null;

	const chat = message.chat as Record<string, unknown> | undefined;
	const chatId = chat?.id;
	const messageId = message.message_id;
	if (typeof chatId !== "number" || !Number.isSafeInteger(chatId)) return null;
	if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId <= 0) return null;
	const from = message.from as Record<string, unknown> | undefined;
	const senderId = typeof from?.id === "number" && Number.isSafeInteger(from.id) && from.id > 0 ? from.id : null;

	const remainder = source.slice(entity.length);
	const action =
		remainder && !/^\s/.test(remainder) ? ({ kind: "usage" } as const) : parseControlArguments(token, remainder.trim());
	return {
		chatId,
		messageId,
		edited: payload.edited,
		sender: {
			id: senderId,
			isBot: from?.is_bot === true,
			hasSenderChat: message.sender_chat != null,
		},
		action,
	};
}

function parseControlArguments(command: TelegramControlCommandToken, input: string): TelegramControlAction {
	const tokens = input ? input.split(/\s+/) : [];
	if (command === "task") {
		if (tokens.length === 0 || (tokens.length === 1 && tokens[0]!.toLowerCase() === "status"))
			return { kind: "task_status" };
		return tokens.length === 2 && tokens[0]!.toLowerCase() === "cancel" && /^[tc]\d+$/.test(tokens[1]!)
			? { kind: "task_cancel", taskId: tokens[1]! }
			: { kind: "usage" };
	}
	if (command === "box")
		return tokens.length === 1 && tokens[0]!.toLowerCase() === "reset" ? { kind: "box_reset" } : { kind: "usage" };
	return tokens.length === 0 ? { kind: command } : { kind: "usage" };
}

export function isHuman(sender: ControlSender): boolean {
	return sender.id != null && !sender.isBot && !sender.hasSenderChat;
}

export function isMutation(action: TelegramControlAction): boolean {
	return (
		action.kind === "compact" ||
		action.kind === "new" ||
		action.kind === "model" ||
		action.kind === "box_reset" ||
		action.kind === "task_cancel"
	);
}

export function compactFailureText(code: Exclude<ManualCompactResult, { ok: true }>["code"]): string {
	switch (code) {
		case "busy":
			return "busy，请稍后重试";
		case "stopping":
			return "正在停止";
		case "unavailable":
			return "runtime unavailable";
		case "nothing_to_compact":
			return "没有足够上下文可压缩";
		case "failed":
			return "compact 失败（详情仅保留在本机日志）";
	}
}

export function bounded(value: string): string {
	const clean = value.replace(/[\r\n\t]+/g, " ");
	return clean.length <= MAX_LABEL_CHARS ? clean : `${clean.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

export function boundedReply(value: string): string {
	return value.length <= MAX_REPLY_CHARS ? value : `${value.slice(0, MAX_REPLY_CHARS - 1)}…`;
}

export const USAGE_TEXT = ["用法：", ...CONTROL_COMMANDS.map(([, , usage]) => usage)].join("\n");

export const HELP_TEXT = [
	"Telegram Agent 控制",
	"查看：/help、/status、/task",
	"管理员：/model、/compact、/new、/box reset、/task cancel",
	"/model 用按钮选择 Pi 可用模型，保存后立即开启新会话。",
	"手动 compact 使用 Pi 当前会话模型压缩上下文并产生相应费用。",
	"/new 丢弃当前上下文开启新会话（历史保留在 Pi 数据库），之前的群消息不再可见。",
	"/box reset 清空 bot 的工作区（每周一 05:00 也会自动清空）。",
	"/task 列出后台任务与定时任务，/task cancel tN|cN 取消任务或定时。",
].join("\n");
