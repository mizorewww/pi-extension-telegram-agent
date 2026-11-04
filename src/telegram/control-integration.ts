import type { DatabaseSync as Database } from "node:sqlite";
import { log } from "../observability/log.ts";
import type { ParsedTelegramControlCommand, TelegramControlResult } from "./control-command.ts";
import type { InlineKeyboardMarkup } from "./api.ts";
import { persistEditedControlMessage } from "./ingest.ts";
import {
	classifyTelegramCreateFailure,
	localFailureCategory,
	retrySqliteBusy,
	sendTextAndPersist,
	SentMessagePersistenceError,
	type TextSendApi,
} from "./send.ts";

export interface TelegramControlCommandPort {
	handle(command: ParsedTelegramControlCommand): Promise<TelegramControlResult>;
	consumeReply(botId: string, chatId: number, messageId: number): void;
}

export interface TelegramControlApi extends TextSendApi {
	answerCallbackQuery(id: string, text?: string): Promise<true>;
	editMessageText(
		chatId: number,
		messageId: number,
		text: string,
		replyMarkup: InlineKeyboardMarkup,
	): Promise<Record<string, unknown>>;
}

export type TelegramControlDeliveryResult =
	| { outcome: "sent"; botId: string; chatId: number; messageId: number }
	| { outcome: "no_reply" | "failed"; category?: string };

/** Command execution + Telegram send/canonical projection, with no uncertain remote retry. */
export class TelegramControlCoordinator {
	private readonly pending = new Set<Promise<unknown>>();

	/** handle() claims synchronously before its first await; polling waits only for acceptance. */
	dispatch(command: ParsedTelegramControlCommand): void {
		const work = this.handle(command)
			.catch(() => {
				this.warn("dispatch", { bot_id: command.replyBotId, category: "local_failure" });
			})
			.finally(() => this.pending.delete(work));
		this.pending.add(work);
	}

	async drain(): Promise<void> {
		await Promise.allSettled([...this.pending]);
	}

	constructor(
		private readonly db: Database,
		private readonly commands: TelegramControlCommandPort,
		private readonly apis: ReadonlyMap<string, TelegramControlApi>,
	) {}

	private warn(operation: string, fields: Record<string, unknown>): void {
		log.warn("telegram_control", "operation_failed", { operation, ...fields });
	}

	async handle(command: ParsedTelegramControlCommand): Promise<TelegramControlDeliveryResult> {
		let result: TelegramControlResult;
		try {
			result = await this.commands.handle(command);
		} catch {
			this.warn("command", { bot_id: command.replyBotId, message_id: command.messageId, category: "local_failure" });
			if (command.callbackQueryId) await this.answerCallback(command, "操作失败，请稍后重试。");
			return { outcome: "failed", category: "local_failure" };
		}
		if (command.callbackQueryId) {
			await this.answerCallback(command, result.callbackNotice);
			if (result.text == null) return { outcome: "no_reply" };
			return this.editMenu(command, result);
		}
		if (result.text == null) return { outcome: "no_reply" };
		// Every configured bot has an API client; commands only address configured bots.
		const api = this.apis.get(result.replyBotId)!;

		try {
			const { canonical } = await sendTextAndPersist(
				this.db,
				api,
				result.replyBotId,
				result.chatId,
				result.text,
				result.replyToMessageId,
				result.replyMarkup,
			);
			try {
				await retrySqliteBusy(() =>
					this.commands.consumeReply(result.replyBotId, canonical.chat_id, canonical.message_id),
				);
			} catch (error) {
				this.warn("reply_marker", {
					bot_id: result.replyBotId,
					message_id: canonical.message_id,
					category: localFailureCategory(error),
				});
			}
			return { outcome: "sent", botId: result.replyBotId, chatId: canonical.chat_id, messageId: canonical.message_id };
		} catch (error) {
			const category =
				error instanceof SentMessagePersistenceError
					? localFailureCategory(error.cause)
					: classifyTelegramCreateFailure(error).category;
			this.warn("reply", { bot_id: result.replyBotId, message_id: result.replyToMessageId, category });
			return { outcome: "failed", category };
		}
	}

	private async answerCallback(command: ParsedTelegramControlCommand, notice?: string): Promise<void> {
		try {
			await this.apis.get(command.replyBotId)!.answerCallbackQuery(command.callbackQueryId!, notice);
		} catch {
			this.warn("callback_answer", {
				bot_id: command.replyBotId,
				message_id: command.messageId,
				category: "request_failed",
			});
		}
	}

	private async editMenu(
		command: ParsedTelegramControlCommand,
		result: TelegramControlResult,
	): Promise<TelegramControlDeliveryResult> {
		try {
			const raw = await this.apis
				.get(result.replyBotId)!
				.editMessageText(result.chatId, command.messageId, result.text!, result.replyMarkup ?? { inline_keyboard: [] });
			await retrySqliteBusy(() => persistEditedControlMessage(this.db, raw));
			return { outcome: "sent", botId: result.replyBotId, chatId: result.chatId, messageId: command.messageId };
		} catch {
			this.warn("menu_edit", { bot_id: command.replyBotId, message_id: command.messageId, category: "request_failed" });
			return { outcome: "failed", category: "request_failed" };
		}
	}
}

export interface TelegramMenuApi {
	setMyCommands(commands: readonly { command: string; description: string }[]): Promise<true>;
}

export const TELEGRAM_CONTROL_MENU = [
	{ command: "help", description: "命令与用法" },
	{ command: "status", description: "各 bot 状态与用量" },
	{ command: "model", description: "选择 Pi 可用模型（管理员）" },
	{ command: "compact", description: "手动压缩上下文（管理员）" },
	{ command: "new", description: "丢弃上下文开启新会话（管理员）" },
	{ command: "set", description: "用按钮调整插话概率与冷却（管理员）" },
	{ command: "fire", description: "允许其他 bot 的消息触发本 bot：on/off/status" },
	{ command: "task", description: "后台任务与用量；cancel tN 停止（管理员）" },
	{ command: "box", description: "reset 清空 bot 的工作区（管理员）" },
] as const;

/** Startup capability only: every bot attempts the same menu, failures never block polling. */
export async function publishTelegramControlMenus(apis: ReadonlyMap<string, TelegramMenuApi>): Promise<void> {
	await Promise.all(
		[...apis].map(async ([botId, api]) => {
			try {
				await api.setMyCommands(TELEGRAM_CONTROL_MENU);
			} catch {
				log.warn("telegram_control", "menu_publish_failed", { bot_id: botId, category: "request_failed" });
			}
		}),
	);
}
