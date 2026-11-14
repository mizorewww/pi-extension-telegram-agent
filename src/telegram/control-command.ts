import type { Database } from "../db/db.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	ManualCompactResult,
	ModelControlResult,
	ModelControlSelection,
	NewSessionResult,
} from "../agent/runtime.ts";
import type { BotConfig, TelegramAdmin } from "../config.ts";
import { log } from "../observability/log.ts";
import { renderBotStatus, type RuntimeControlSnapshot } from "../observability/status.ts";
import { updateBotModelConfig } from "../onboarding/config-core.ts";
import type { BotApi, InlineKeyboardMarkup } from "./api.ts";
import {
	boundedReply,
	CONTROL_COMMANDS,
	type ControlSender,
	compactFailureText,
	HELP_TEXT,
	isHuman,
	isMutation,
	type ParsedTelegramControlCommand,
	parseTelegramControlCallback,
	parseTelegramControlCommand,
	type TelegramControlAction,
	type TelegramControlCommandToken,
	USAGE_TEXT,
} from "./control-parse.ts";
import { persistEditedControlMessage } from "./ingest.ts";
import { modelMenuKey, renderModelMenu } from "./model-menu.ts";
import {
	classifyTelegramCreateFailure,
	localFailureCategory,
	sendTextAndPersist,
	SentMessagePersistenceError,
} from "./send.ts";

export {
	type ControlSender,
	type ParsedTelegramControlCommand,
	parseTelegramControlCallback,
	parseTelegramControlCommand,
	type TelegramControlAction,
	type TelegramControlCommandToken,
};

export interface TelegramControlRuntime {
	controlSnapshot(): Promise<RuntimeControlSnapshot>;
	compactForControl(): Promise<ManualCompactResult>;
	resetBoxForControl(): Promise<{ ok: true } | { ok: false; code: "unavailable" | "failed" }>;
	taskStatusForControl(): Promise<string | null>;
	cancelTaskForControl(taskId: string): Promise<{ ok: true } | { ok: false; code: "unavailable" | "unknown_task" }>;
	newSessionForControl(): Promise<NewSessionResult>;
	changeModelForControl(
		provider: string,
		model: string,
		persist: (selection: ModelControlSelection) => { finalize(): void; rollback(): void },
	): Promise<ModelControlResult>;
}

export interface TelegramControlResult {
	chatId: number;
	replyToMessageId: number;
	text: string | null;
	replyMarkup?: InlineKeyboardMarkup;
	callbackNotice?: string;
}

interface ControlExecutionResult {
	text: string;
	replyMarkup?: InlineKeyboardMarkup;
	callbackNotice?: string;
	outcome: string;
}

export class TelegramControlCommandService {
	private mutationTail: Promise<void> = Promise.resolve();
	private mutations = 0;

	constructor(
		private readonly db: Database,
		private readonly bot: BotConfig,
		private readonly rootDir: string,
		private readonly runtime: TelegramControlRuntime,
		private readonly admins: readonly TelegramAdmin[],
		private readonly models?: Pick<ModelRuntime, "getAvailableSnapshot">,
	) {}

	async handle(command: ParsedTelegramControlCommand): Promise<TelegramControlResult> {
		const callback = Boolean(command.callbackQueryId);
		const base = { chatId: command.chatId, replyToMessageId: command.messageId };
		if (!callback && !this.claim(command)) return { ...base, text: null };
		if (command.edited || !isHuman(command.sender)) return { ...base, text: null };
		const authorized = !(callback || isMutation(command.action)) || this.admins.includes(command.sender.id!);
		const startedAt = Date.now();
		let result: ControlExecutionResult;
		if (!authorized) {
			const text = "权限不足：此操作仅限 telegram_admins 白名单。";
			result = { text: callback ? "" : text, callbackNotice: text, outcome: "permission_denied" };
		} else if (
			callback &&
			!this.db
				.prepare(`
			SELECT 1 FROM telegram_control_messages c JOIN messages m USING (chat_id, message_id)
			WHERE c.chat_id = ? AND c.message_id = ? AND m.is_bot = 1
		`)
				.get(command.chatId, command.messageId)
		) {
			result = { text: "", callbackNotice: `菜单已失效，请重新发送 /${command.action.kind}。`, outcome: "stale_menu" };
		} else if (callback && this.mutations > 0) {
			result = { text: "", callbackNotice: "有管理操作正在执行，请稍后重试。", outcome: "busy" };
		} else {
			const run = () => this.execute(command);
			result = await (command.action.kind === "model" ? this.enqueueMutation(run) : run());
		}
		log.info("telegram_control", "command", {
			command: command.action.kind,
			sender_id: command.sender.id,
			authorized,
			outcome: result.outcome,
			duration_ms: Date.now() - startedAt,
		});
		return {
			...base,
			text: result.text ? boundedReply(result.text) : null,
			replyMarkup: result.replyMarkup,
			callbackNotice: result.callbackNotice,
		};
	}

	/** Persist and expose a sent control reply so it remains outside every future provider epoch. */
	consumeReply(chatId: number, messageId: number): void {
		this.db
			.prepare("INSERT OR IGNORE INTO telegram_control_messages (chat_id, message_id) VALUES (?, ?)")
			.run(chatId, messageId);
	}

	private claim(command: ParsedTelegramControlCommand): boolean {
		return (
			this.db
				.prepare("INSERT OR IGNORE INTO telegram_control_messages (chat_id, message_id) VALUES (?, ?)")
				.run(command.chatId, command.messageId).changes > 0
		);
	}

	private async execute(command: ParsedTelegramControlCommand): Promise<ControlExecutionResult> {
		const runtime = this.runtime;
		switch (command.action.kind) {
			case "help":
				return { text: HELP_TEXT, outcome: "ok" };
			case "usage":
				return { text: USAGE_TEXT, outcome: "usage" };
			case "status":
				return { text: renderBotStatus(this.bot, await runtime.controlSnapshot()), outcome: "ok" };
			case "model":
				return this.model(command.action.data);
			case "task_status": {
				const text = await runtime.taskStatusForControl();
				return {
					text: text == null ? "没有开启后台任务。" : `任务：\n${text}`,
					outcome: text == null ? "unavailable" : "ok",
				};
			}
			case "task_cancel": {
				const result = await runtime.cancelTaskForControl(command.action.taskId);
				return {
					text: result.ok ? `已取消 ${command.action.taskId}。` : `没有可取消的任务（${result.code}）。`,
					outcome: result.ok ? "ok" : result.code,
				};
			}
			case "box_reset": {
				const result = await runtime.resetBoxForControl();
				return {
					text: result.ok ? `工作区已清空。` : `清空失败（${result.code}）。`,
					outcome: result.ok ? "ok" : result.code,
				};
			}
			case "compact": {
				const result = await runtime.compactForControl();
				return {
					text: `${result.ok ? `compact 完成，epoch=${result.epoch}` : compactFailureText(result.code)}`,
					outcome: result.ok ? "ok" : result.code,
				};
			}
			case "new": {
				const result = await runtime.newSessionForControl();
				return {
					text: result.ok ? `已开启新会话，epoch=${result.epoch}` : `新会话失败（${result.code}）。`,
					outcome: result.ok ? "ok" : result.code,
				};
			}
		}
	}

	private async model(data?: string): Promise<ControlExecutionResult> {
		const bot = this.bot;
		if (!this.models) return { text: "模型目录暂不可用。", outcome: "unavailable" };
		const models = this.models.getAvailableSnapshot();
		const selection = data ? /^model:s:([a-f0-9]{24})$/.exec(data) : null;
		if (selection) {
			const model = models.find((candidate) => modelMenuKey(candidate.provider, candidate.id) === selection[1]);
			if (!model) return { text: "", callbackNotice: "模型已不可用，请重新发送 /model。", outcome: "unknown_model" };
			const result = await this.runtime.changeModelForControl(model.provider, model.id, (value) =>
				updateBotModelConfig(this.rootDir, value),
			);
			if (!result.ok) {
				const message =
					result.code === "image_input_unsupported"
						? "hybrid 媒体模式需要支持图片输入的模型。"
						: result.code === "context_window_too_small"
							? "该模型的上下文窗口过小，需要大于 16384 tokens。"
							: result.code === "busy"
								? "Bot 正忙，请稍后重试。"
								: result.code === "config_write_failed"
									? "配置保存失败，原模型保持不变。"
									: `切换失败（${result.code}），请稍后重试。`;
				return { text: "", callbackNotice: message, outcome: result.code };
			}
			return {
				text: `已选择 ${model.provider}/${model.id}\nReasoning：${result.reasoningEffort}\n已保存，重启后仍然生效。`,
				replyMarkup: { inline_keyboard: [[{ text: "选择模型", callback_data: "model:r:0" }]] },
				outcome: "ok",
			};
		}
		const view = renderModelMenu(bot, models, data);
		return view
			? { ...view, outcome: "ok" }
			: { text: "", callbackNotice: "菜单已失效，请重新发送 /model。", outcome: "stale_menu" };
	}

	private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
		this.mutations++;
		const result = this.mutationTail.then(operation, operation);
		this.mutationTail = result
			.then(
				() => {},
				() => {},
			)
			.finally(() => {
				this.mutations--;
			});
		return result;
	}
}

/** IDs marked here stay out of provider suffixes across every context generation. */
export function consumedControlMessageIds(db: Database, chatId: number): Set<number> {
	const rows = db.prepare("SELECT message_id FROM telegram_control_messages WHERE chat_id = ?").all(chatId) as {
		message_id: number;
	}[];
	return new Set(rows.map((row) => row.message_id));
}

export class TelegramControlCoordinator {
	private readonly pending = new Set<Promise<unknown>>();

	constructor(
		private readonly db: Database,
		private readonly commands: TelegramControlCommandService,
		private readonly api: BotApi,
	) {}

	dispatch(command: ParsedTelegramControlCommand): void {
		const work = this.handle(command)
			.catch(() =>
				log.warn("telegram_control", "operation_failed", { operation: "dispatch", category: "local_failure" }),
			)
			.finally(() => this.pending.delete(work));
		this.pending.add(work);
	}

	async drain(): Promise<void> {
		await Promise.allSettled([...this.pending]);
	}

	private async handle(command: ParsedTelegramControlCommand): Promise<void> {
		let operation = "command";
		try {
			const result = await this.commands.handle(command);
			if (command.callbackQueryId) {
				await this.api.answerCallbackQuery(command.callbackQueryId, result.callbackNotice).catch(() =>
					log.warn("telegram_control", "operation_failed", {
						operation: "callback_answer",
						message_id: command.messageId,
						category: "request_failed",
					}),
				);
			}
			if (result.text == null) return;
			if (command.callbackQueryId) {
				operation = "menu_edit";
				const raw = await this.api.editMessageText(
					result.chatId,
					command.messageId,
					result.text,
					result.replyMarkup ?? { inline_keyboard: [] },
				);
				persistEditedControlMessage(this.db, raw);
				return;
			}
			operation = "reply";
			const { canonical } = await sendTextAndPersist(
				this.db,
				this.api,
				result.chatId,
				result.text,
				result.replyToMessageId,
				result.replyMarkup,
			);
			try {
				this.commands.consumeReply(canonical.chat_id, canonical.message_id);
			} catch (error) {
				log.warn("telegram_control", "operation_failed", {
					operation: "reply_marker",
					message_id: canonical.message_id,
					category: localFailureCategory(error),
				});
			}
		} catch (error) {
			const category =
				error instanceof SentMessagePersistenceError
					? localFailureCategory(error.cause)
					: operation === "reply"
						? classifyTelegramCreateFailure(error).category
						: "local_failure";
			log.warn("telegram_control", "operation_failed", { operation, message_id: command.messageId, category });
			if (operation === "command" && command.callbackQueryId) {
				await this.api.answerCallbackQuery(command.callbackQueryId, "操作失败，请稍后重试。").catch(() => {});
			}
		}
	}
}

export async function publishTelegramControlMenu(api: BotApi): Promise<void> {
	try {
		await api.setMyCommands(CONTROL_COMMANDS.map(([command, description]) => ({ command, description })));
	} catch {
		log.warn("telegram_control", "menu_publish_failed", { category: "request_failed" });
	}
}
