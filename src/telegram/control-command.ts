import type { Database } from "bun:sqlite";
import { log } from "../observability/log.ts";
import type { BotConfig, TelegramAdmin } from "../config.ts";
import type { ManualCompactResult } from "../agent/runtime.ts";
import { updateBotConfigField } from "../onboarding/config-core.ts";
import { loadBotStats } from "../db/usage.ts";
import type { RuntimeControlSnapshot } from "../ipc.ts";
import {
	botStatusFields,
	buildBotStatusView,
	renderBotStatusPlain,
	type BotStatusView,
} from "../observability/status.ts";
import { extractUpdateMessage } from "./normalize.ts";

export const CONTROL_COMMAND_AUDIT_EVENT = "telegram_control";

const MAX_REPLY_CHARS = 3500;
const MAX_LABEL_CHARS = 64;

export interface ControlBotIdentity {
	id: string;
	username: string;
}

export interface ControlSender {
	id: number | null;
	username: `@${string}` | null;
	isBot: boolean;
	hasSenderChat: boolean;
}

export type TelegramControlAction =
	| { kind: "help" }
	| { kind: "status" }
	| { kind: "compact" }
	| { kind: "set"; parameter: "routing_p" | "cooldown_ms"; value: number }
	| { kind: "usage" };

export type TelegramControlCommandToken = "help" | "status" | "compact" | "set";

const COMMAND_TOKENS: ReadonlySet<string> = new Set(["help", "status", "compact", "set"]);

export interface ParsedTelegramControlCommand {
	chatId: number;
	messageId: number;
	edited: boolean;
	receivedByBotId: string;
	replyBotId: string;
	sender: ControlSender;
	action: TelegramControlAction;
}

export interface TelegramControlRuntime {
	controlSnapshot(): RuntimeControlSnapshot;
	compactForControl(): Promise<ManualCompactResult>;
	consumeControlMessage(messageId: number): void;
}

export interface TelegramControlResult {
	chatId: number;
	replyToMessageId: number;
	replyBotId: string;
	text: string | null;
	/** Telegram InputRichMessage Markdown; text remains the independent safe fallback projection. */
	richText?: string;
}

interface ControlExecutionResult {
	text: string;
	richText?: string;
	outcome: string;
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
	const username =
		typeof from?.username === "string" && /^[a-z0-9_]{5,32}$/i.test(from.username)
			? (`@${from.username.toLowerCase()}` as `@${string}`)
			: null;

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
			username,
			isBot: from?.is_bot === true,
			hasSenderChat: message.sender_chat != null,
		},
		action,
	};
}

function parseControlArguments(command: TelegramControlCommandToken, input: string): TelegramControlAction {
	const tokens = input ? input.split(/\s+/) : [];
	if (command === "set") {
		if (tokens.length !== 2) return { kind: "usage" };
		const parameter = normalizedParameter(tokens[0]!);
		if (!parameter) return { kind: "usage" };
		const value = parseControlValue(parameter, tokens[1]!);
		return value == null ? { kind: "usage" } : { kind: "set", parameter, value };
	}
	return tokens.length === 0 ? { kind: command } : { kind: "usage" };
}

function normalizedParameter(value: string): "routing_p" | "cooldown_ms" | null {
	const normalized = value.toLowerCase();
	return normalized === "routing_p" || normalized === "cooldown_ms" ? normalized : null;
}

function parseControlValue(parameter: "routing_p" | "cooldown_ms", raw: string): number | null {
	if (parameter === "cooldown_ms") {
		if (!/^\d+$/.test(raw)) return null;
		const value = Number(raw);
		return Number.isSafeInteger(value) ? value : null;
	}
	if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(raw)) return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

export class TelegramControlCommandService {
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(
		private readonly db: Database,
		private readonly bots: readonly BotConfig[],
		private readonly rootDir: string,
		private readonly runtimes: ReadonlyMap<string, TelegramControlRuntime>,
		private readonly admins: readonly TelegramAdmin[],
		private readonly now: () => number = () => Date.now(),
	) {}

	async handle(command: ParsedTelegramControlCommand): Promise<TelegramControlResult> {
		const claimed = this.claim(command);
		this.consumeEveryRuntime(command.messageId);
		if (!claimed) return this.result(command, null);
		const startedAt = this.now();
		if (command.edited) {
			this.audit(command, false, "ignored_edit", startedAt);
			return this.result(command, null);
		}
		if (!isHuman(command.sender)) {
			this.audit(command, false, "rejected_sender", startedAt);
			return this.result(command, null);
		}

		const mutation = isMutation(command.action);
		const authorized = !mutation || this.isAdmin(command.sender);
		if (!authorized) {
			this.audit(command, false, "permission_denied", startedAt);
			return this.result(command, "权限不足：此操作仅限 telegram_admins 白名单。");
		}

		if (mutation) {
			return await this.enqueueMutation(async () => {
				const executed = await this.execute(command);
				this.audit(command, true, executed.outcome, startedAt);
				return this.result(command, executed.text, executed.richText);
			});
		}
		const executed = await this.execute(command);
		this.audit(command, true, executed.outcome, startedAt);
		return this.result(command, executed.text, executed.richText);
	}

	/** Persist and expose a sent control reply so it remains outside every future provider epoch. */
	consumeReply(_botId: string, chatId: number, messageId: number): void {
		this.db
			.query("INSERT OR IGNORE INTO telegram_control_messages (chat_id, message_id) VALUES (?, ?)")
			.run(chatId, messageId);
		this.consumeEveryRuntime(messageId);
	}

	private claim(command: ParsedTelegramControlCommand): boolean {
		return (
			this.db
				.query("INSERT OR IGNORE INTO telegram_control_messages (chat_id, message_id) VALUES (?, ?)")
				.run(command.chatId, command.messageId).changes > 0
		);
	}

	private async execute(command: ParsedTelegramControlCommand): Promise<ControlExecutionResult> {
		switch (command.action.kind) {
			case "help":
				return { text: HELP_TEXT, outcome: "ok" };
			case "status":
				return this.formatStatus(command.replyBotId);
			case "set":
				return this.set(command.replyBotId, command.action.parameter, command.action.value);
			case "compact":
				return await this.compact(command.replyBotId);
			case "usage":
				return { text: USAGE_TEXT, outcome: "usage" };
		}
	}

	private formatStatus(botId: string): ControlExecutionResult {
		const bot = this.bots.find((candidate) => candidate.id === botId);
		if (!bot) return { text: `未知 bot：${bounded(botId)}`, outcome: "unknown_bot" };
		const snapshot = this.runtimes.get(bot.id)?.controlSnapshot();
		const view = buildBotStatusView(bot, loadBotStats(this.db, bot.id), snapshot);
		return {
			text: renderBotStatusPlain(view),
			richText: boundedRichStatus(statusRichSection(view)),
			outcome: "ok",
		};
	}

	/** Write-through: the config file is the only source of truth, so the new value survives restarts. */
	private set(botId: string, parameter: "routing_p" | "cooldown_ms", value: number): { text: string; outcome: string } {
		const bot = this.bots.find((candidate) => candidate.id === botId);
		if (!bot) return { text: `未知 bot：${bounded(botId)}`, outcome: "unknown_bot" };
		try {
			updateBotConfigField(
				this.rootDir,
				botId,
				parameter === "routing_p" ? "routing_p" : "sampling_cooldown_ms",
				value,
			);
		} catch (error) {
			return {
				text: boundedReply(`未修改：${error instanceof Error ? error.message : String(error)}`),
				outcome: "config_write_failed",
			};
		}
		if (parameter === "routing_p") bot.routingP = value;
		else bot.samplingCooldownMs = value;
		return {
			text: `${bounded(botId)}.${parameter} = ${value}（已写入 telegram.config.ts，重启后仍然生效）`,
			outcome: "ok",
		};
	}

	private async compact(botId: string): Promise<{ text: string; outcome: string }> {
		const runtime = this.runtimes.get(botId);
		const result: ManualCompactResult = runtime
			? await runtime.compactForControl()
			: { ok: false, code: "unavailable" };
		if (result.ok) return { text: `${bounded(botId)}: compact 完成，epoch=${result.epoch}`, outcome: "ok" };
		return { text: `${bounded(botId)}: ${compactFailureText(result.code)}`, outcome: result.code };
	}

	private isAdmin(sender: ControlSender): boolean {
		return this.admins.some((admin) => (typeof admin === "number" ? admin === sender.id : admin === sender.username));
	}

	private consumeEveryRuntime(messageId: number): void {
		for (const [botId, runtime] of this.runtimes) {
			try {
				runtime.consumeControlMessage(messageId);
			} catch {
				// The durable claim/reply marker remains the flush authority even if local
				// obligation cleanup races shutdown.
				log.error("telegram_control", "context_exclusion_failed", {
					bot_id: botId,
					message_id: messageId,
					category: "local_failure",
				});
			}
		}
	}

	private audit(command: ParsedTelegramControlCommand, authorized: boolean, outcome: string, startedAt: number): void {
		const target = ["status", "compact", "set"].includes(command.action.kind) ? command.replyBotId : null;
		const finishedAt = this.now();
		this.db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (?, ?, ?, ?)").run(
			command.replyBotId,
			finishedAt,
			CONTROL_COMMAND_AUDIT_EVENT,
			JSON.stringify({
				command: command.action.kind,
				target,
				sender_id: command.sender.id,
				username: command.sender.username,
				authorized,
				outcome,
				duration_ms: Math.max(0, finishedAt - startedAt),
			}),
		);
	}

	private result(command: ParsedTelegramControlCommand, text: string | null, richText?: string): TelegramControlResult {
		return {
			chatId: command.chatId,
			replyToMessageId: command.messageId,
			replyBotId: command.replyBotId,
			text: text == null ? null : boundedReply(text),
			...(richText ? { richText } : {}),
		};
	}

	private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutationTail.then(operation, operation);
		this.mutationTail = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}

/** IDs marked here stay out of provider suffixes across every context generation. */
export function consumedControlMessageIds(db: Database, chatId: number): Set<number> {
	const rows = db.query("SELECT message_id FROM telegram_control_messages WHERE chat_id = ?").all(chatId) as {
		message_id: number;
	}[];
	return new Set(rows.map((row) => row.message_id));
}

function isHuman(sender: ControlSender): boolean {
	return sender.id != null && !sender.isBot && !sender.hasSenderChat;
}

function isMutation(action: TelegramControlAction): boolean {
	return action.kind === "compact" || action.kind === "set";
}

function compactFailureText(code: Exclude<ManualCompactResult, { ok: true }>["code"]): string {
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

function bounded(value: string): string {
	const clean = value.replace(/[\r\n\t]+/g, " ");
	return clean.length <= MAX_LABEL_CHARS ? clean : `${clean.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

function boundedReply(value: string): string {
	return value.length <= MAX_REPLY_CHARS ? value : `${value.slice(0, MAX_REPLY_CHARS - 1)}…`;
}

function escapeRichMarkdown(value: string): string {
	return bounded(value).replace(/[\\`*_[\]{}()#+\-.!|>]/g, "\\$&");
}

function escapeRichStatusValue(value: string): string {
	return value.replace(/[\\`*_[\]]/g, "\\$&");
}

function statusRichSection(view: BotStatusView): string {
	return [
		`## ${escapeRichMarkdown(view.name)} · ${escapeRichMarkdown(view.id)}`,
		...botStatusFields(view, true).map((field) =>
			field.key === "context_breakdown"
				? `- **${field.label}**：\n${field.value}`
				: `- **${field.label}**：${escapeRichStatusValue(field.value)}`,
		),
	].join("\n");
}

function boundedRichStatus(section: string): string {
	return boundedReply(`# Telegram Agent 状态\n\n${section}`);
}

const USAGE_TEXT = [
	"用法：",
	"/help",
	"/status",
	"/compact（管理员）",
	"/set <routing_p|cooldown_ms> <value>（管理员）",
].join("\n");

const HELP_TEXT = [
	"Telegram Agent 控制",
	"查看：/help、/status",
	"管理员：/compact、/set",
	"命令默认作用于接收消息的 bot；带 @bot_username 后缀时定向到对应 bot。",
	"手动 compact 会使用既有摘要模型并产生相应费用。",
	"/set 写穿 telegram.config.ts，新值重启后仍然生效。",
	USAGE_TEXT,
].join("\n");
