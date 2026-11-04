import type { Database } from "../db/db.ts";
import { log } from "../observability/log.ts";
import type { ParsedTelegramControlCommand, TelegramControlResult } from "./control-command.ts";
import type { InlineKeyboardMarkup } from "./api.ts";
import { CONTROL_COMMANDS } from "./control-parse.ts";
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
		let operation = "command";
		try {
			const result = await this.commands.handle(command);
			const api = this.apis.get(result.replyBotId)!;
			if (command.callbackQueryId) await this.answerCallback(command, result.callbackNotice);
			if (result.text == null) return { outcome: "no_reply" };
			if (command.callbackQueryId) {
				operation = "menu_edit";
				const raw = await api.editMessageText(
					result.chatId,
					command.messageId,
					result.text,
					result.replyMarkup ?? { inline_keyboard: [] },
				);
				await retrySqliteBusy(() => persistEditedControlMessage(this.db, raw));
				return { outcome: "sent", botId: result.replyBotId, chatId: result.chatId, messageId: command.messageId };
			}
			operation = "reply";
			const { canonical } = await sendTextAndPersist(
				this.db,
				api,
				result.replyBotId,
				result.chatId,
				result.text,
				result.replyToMessageId,
				result.replyMarkup,
			);
			// A local marker failure must not repeat the irreversible Telegram create.
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
					: operation === "reply"
						? classifyTelegramCreateFailure(error).category
						: "local_failure";
			this.warn(operation, { bot_id: command.replyBotId, message_id: command.messageId, category });
			if (operation === "command" && command.callbackQueryId)
				await this.answerCallback(command, "操作失败，请稍后重试。");
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
}

export interface TelegramMenuApi {
	setMyCommands(commands: readonly { command: string; description: string }[]): Promise<true>;
}

export const TELEGRAM_CONTROL_MENU = CONTROL_COMMANDS.map(([command, description]) => ({ command, description }));

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
