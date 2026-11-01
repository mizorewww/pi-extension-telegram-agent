import { FIRE_BOT_TRIGGER_BUDGET } from "../agent/router.ts";
import type { ManualCompactResult } from "../agent/runtime.ts";
import { botStatusFields, type BotStatusView } from "../observability/status.ts";
import { extractUpdateMessage } from "./normalize.ts";

const MAX_REPLY_CHARS = 3500;
const MAX_LABEL_CHARS = 64;

export interface ControlBotIdentity {
	id: string;
	username: string;
}

export interface ControlSender {
	id: number | null;
	isBot: boolean;
	hasSenderChat: boolean;
}

/** Bare `/fire` toggles. */
export type FireMode = "on" | "off" | "status" | "toggle";

export type TelegramControlAction =
	| { kind: "help" }
	| { kind: "status" }
	| { kind: "compact" }
	| { kind: "new" }
	| { kind: "model"; data?: string }
	| { kind: "set"; data?: string }
	| { kind: "fire"; mode: FireMode }
	| { kind: "box_reset" }
	| { kind: "task_status" }
	| { kind: "task_cancel"; taskId: string }
	| { kind: "usage" };

export type TelegramControlCommandToken =
	| "help"
	| "status"
	| "compact"
	| "new"
	| "set"
	| "model"
	| "fire"
	| "box"
	| "task";

const COMMAND_TOKENS: ReadonlySet<string> = new Set([
	"help",
	"status",
	"compact",
	"new",
	"set",
	"model",
	"fire",
	"box",
	"task",
]);

export interface ParsedTelegramControlCommand {
	chatId: number;
	messageId: number;
	edited: boolean;
	receivedByBotId: string;
	replyBotId: string;
	sender: ControlSender;
	action: TelegramControlAction;
	callbackQueryId?: string;
}

/** Callback messages never enter canonical ingestion or routing. Accept only this deployment's group. */
export function parseTelegramControlCallback(
	update: unknown,
	botId: string,
	groupChatId: number,
): ParsedTelegramControlCommand | null {
	const query = (update as { callback_query?: Record<string, any> } | null)?.callback_query;
	if (
		!query ||
		typeof query.id !== "string" ||
		typeof query.data !== "string" ||
		!/^(?:model|set):/.test(query.data) ||
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
		receivedByBotId: botId,
		replyBotId: botId,
		callbackQueryId: query.id,
		sender: {
			id: Number.isSafeInteger(query.from?.id) && query.from.id > 0 ? query.from.id : null,
			isBot: query.from?.is_bot === true,
			hasSenderChat: message.sender_chat != null && message.from?.is_bot !== true,
		},
		action: { kind: query.data.startsWith("set:") ? "set" : "model", data: query.data },
	};
}

/**
 * Parse only Telegram's offset-zero bot_command entity. Telegram entity offsets are UTF-16
 * code units, which is exactly what JavaScript slice() consumes.
 */
export function parseTelegramControlCommand(
	update: unknown,
	receivedByBotId: string,
	bots: readonly ControlBotIdentity[],
): ParsedTelegramControlCommand | null {
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

	const receivingBot = bots.find((bot) => bot.id === receivedByBotId);
	if (!receivingBot) return null;
	let replyBotId = receivingBot.id;
	if (match[2]) {
		const suffix = match[2].toLowerCase();
		const target = bots.find((bot) => bot.username.toLowerCase() === suffix);
		if (!target) return null;
		replyBotId = target.id;
	}

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
		receivedByBotId,
		replyBotId,
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
	if (command === "fire") {
		if (tokens.length === 0) return { kind: "fire", mode: "toggle" };
		const mode = tokens[0]!.toLowerCase();
		return tokens.length === 1 && (mode === "on" || mode === "off" || mode === "status")
			? { kind: "fire", mode }
			: { kind: "usage" };
	}
	if (command === "task") {
		if (tokens.length === 0 || (tokens.length === 1 && tokens[0]!.toLowerCase() === "status"))
			return { kind: "task_status" };
		return tokens.length === 2 && tokens[0]!.toLowerCase() === "cancel" && /^t\d+$/.test(tokens[1]!)
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
		action.kind === "set" ||
		action.kind === "model" ||
		action.kind === "box_reset" ||
		action.kind === "task_cancel" ||
		(action.kind === "fire" && action.mode !== "status")
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

function escapeMarkdown(value: string): string {
	return bounded(value).replace(/[\\`*_[\]{}()#+\-.!|>]/g, "\\$&");
}

function escapeStatusValue(value: string): string {
	return value.replace(/[\\`*_[\]]/g, "\\$&");
}

export function boundedMarkdownStatus(view: BotStatusView): string {
	const section = [
		`## ${escapeMarkdown(view.name)} · ${escapeMarkdown(view.id)}`,
		...botStatusFields(view, true).map((field) =>
			field.key === "context_breakdown"
				? `- **${field.label}**：\n${field.value}`
				: `- **${field.label}**：${escapeStatusValue(field.value)}`,
		),
	].join("\n");
	return boundedReply(`# Telegram Agent 状态\n\n${section}`);
}

export const USAGE_TEXT = [
	"用法：",
	"/help",
	"/status",
	"/model（管理员）",
	"/compact（管理员）",
	"/new（管理员）",
	"/set（管理员）",
	"/fire status",
	"/fire [on|off]（管理员）",
	"/box reset（管理员）",
	"/task [status]",
	"/task cancel <tN>（管理员）",
].join("\n");

export const HELP_TEXT = [
	"Telegram Agent 控制",
	"查看：/help、/status、/fire status、/task",
	"管理员：/model、/compact、/new、/set、/fire [on|off]、/box reset、/task cancel",
	"/model 用按钮选择 Pi 可用模型，保存后立即开启新会话。",
	"命令默认作用于接收消息的 bot；带 @bot_username 后缀时定向到对应 bot。",
	"手动 compact 会使用既有摘要模型并产生相应费用。",
	"/new 丢弃当前上下文开启新会话（旧会话文件保留在本机），之前的群消息不再可见。",
	"/set 用按钮调整插话概率与冷却，写回 telegram.config.ts，重启后仍然生效。",
	"/box reset 清空 bot 的工作区（每周一 05:00 也会自动清空）。",
	"/task 列出 bot 最近的后台任务和用量，/task cancel tN 停止一个任务。",
	`/fire 让其他 bot 的消息按正常路由触发本 bot（默认关闭、不带参数时切换），人类发言前最多连续 ${FIRE_BOT_TRIGGER_BUDGET} 次；同一部署的 bot 发言在本地路由，部署外的 bot 只在 Telegram 实际投递时生效；重启后关闭。`,
].join("\n");
