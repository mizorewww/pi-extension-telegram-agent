import type { Database } from "../db/db.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BotFire, FIRE_BOT_TRIGGER_BUDGET } from "../agent/router.ts";
import type {
	ManualCompactResult,
	ModelControlResult,
	ModelControlSelection,
	NewSessionResult,
} from "../agent/runtime.ts";
import type { BotConfig, TelegramAdmin } from "../config.ts";
import { log } from "../observability/log.ts";
import type { RuntimeControlSnapshot } from "../observability/usage.ts";
import { renderBotStatus } from "../observability/status.ts";
import { updateBotConfigField, updateBotModelConfig } from "../onboarding/config-core.ts";
import type { InlineKeyboardMarkup } from "./api.ts";
import {
	bounded,
	boundedReply,
	type ControlBotIdentity,
	type ControlSender,
	compactFailureText,
	type FireMode,
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
import { modelMenuKey, renderModelMenu } from "./model-menu.ts";
import { cooldownLabel, parseSettingsChoice, renderSettingsMenu } from "./settings-menu.ts";

export {
	type ControlBotIdentity,
	type ControlSender,
	type FireMode,
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
	replyBotId: string;
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
		private readonly bots: readonly BotConfig[],
		private readonly rootDir: string,
		private readonly runtimes: ReadonlyMap<string, TelegramControlRuntime>,
		private readonly admins: readonly TelegramAdmin[],
		private readonly models?: Pick<ModelRuntime, "getAvailableSnapshot">,
		private readonly fire: BotFire = new BotFire(),
	) {}

	async handle(command: ParsedTelegramControlCommand): Promise<TelegramControlResult> {
		const callback = Boolean(command.callbackQueryId);
		const base = { chatId: command.chatId, replyToMessageId: command.messageId, replyBotId: command.replyBotId };
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
			WHERE c.chat_id = ? AND c.message_id = ? AND m.first_seen_by = ? AND m.is_bot = 1
		`)
				.get(command.chatId, command.messageId, command.replyBotId)
		) {
			result = { text: "", callbackNotice: `菜单已失效，请重新发送 /${command.action.kind}。`, outcome: "stale_menu" };
		} else if (callback && this.mutations > 0) {
			result = { text: "", callbackNotice: "有管理操作正在执行，请稍后重试。", outcome: "busy" };
		} else {
			const run = () => this.execute(command);
			result = await (command.action.kind === "set" || command.action.kind === "model"
				? this.enqueueMutation(run)
				: run());
		}
		log.info("telegram_control", "command", {
			bot_id: command.replyBotId,
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
	consumeReply(_botId: string, chatId: number, messageId: number): void {
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
		const botId = command.replyBotId;
		const runtime = this.runtimes.get(botId)!;
		switch (command.action.kind) {
			case "help":
				return { text: HELP_TEXT, outcome: "ok" };
			case "usage":
				return { text: USAGE_TEXT, outcome: "usage" };
			case "status":
				return { text: renderBotStatus(this.bot(botId), await runtime.controlSnapshot()), outcome: "ok" };
			case "set":
				return this.settings(botId, command.action.data);
			case "model":
				return this.model(botId, command.action.data);
			case "fire":
				return this.fireControl(botId, command.chatId, command.action.mode);
			case "task_status": {
				const text = await runtime.taskStatusForControl();
				return {
					text: text == null ? `${botId}: 这个 bot 没有开启后台任务。` : `${botId} 的任务：\n${text}`,
					outcome: text == null ? "unavailable" : "ok",
				};
			}
			case "task_cancel": {
				const result = await runtime.cancelTaskForControl(command.action.taskId);
				return {
					text: result.ok
						? `${botId}: 已取消 ${command.action.taskId}。`
						: `${botId}: 没有可取消的任务（${result.code}）。`,
					outcome: result.ok ? "ok" : result.code,
				};
			}
			case "box_reset": {
				const result = await runtime.resetBoxForControl();
				return {
					text: result.ok ? `${botId}: 工作区已清空。` : `${botId}: 清空失败（${result.code}）。`,
					outcome: result.ok ? "ok" : result.code,
				};
			}
			case "compact": {
				const result = await runtime.compactForControl();
				return {
					text: `${botId}: ${result.ok ? `compact 完成，epoch=${result.epoch}` : compactFailureText(result.code)}`,
					outcome: result.ok ? "ok" : result.code,
				};
			}
			case "new": {
				const result = await runtime.newSessionForControl();
				return {
					text: result.ok
						? `${botId}: 已开启新会话，epoch=${result.epoch}`
						: `${botId}: 新会话失败（${result.code}）。`,
					outcome: result.ok ? "ok" : result.code,
				};
			}
		}
	}

	private async model(botId: string, data?: string): Promise<ControlExecutionResult> {
		const bot = this.bot(botId);
		if (!this.models) return { text: "模型目录暂不可用。", outcome: "unavailable" };
		const models = this.models.getAvailableSnapshot();
		const selection = data ? /^model:s:([a-f0-9]{24})$/.exec(data) : null;
		if (selection) {
			const model = models.find((candidate) => modelMenuKey(candidate.provider, candidate.id) === selection[1]);
			if (!model) return { text: "", callbackNotice: "模型已不可用，请重新发送 /model。", outcome: "unknown_model" };
			const result = await this.runtimes
				.get(botId)!
				.changeModelForControl(model.provider, model.id, (value) => updateBotModelConfig(this.rootDir, botId, value));
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

	/** Button menu; a choice writes through to the config file, the only source of truth. */
	private settings(botId: string, data?: string): ControlExecutionResult {
		const bot = this.bot(botId);
		if (!data) return { ...renderSettingsMenu(bot), outcome: "ok" };
		const choice = parseSettingsChoice(data);
		if (!choice) return { text: "", outcome: "noop" };
		const current = choice.parameter === "routing_p" ? bot.routingP : bot.samplingCooldownMs;
		if (current === choice.value) return { text: "", callbackNotice: "已经是这个值。", outcome: "unchanged" };
		try {
			updateBotConfigField(this.rootDir, botId, choice.parameter, choice.value);
		} catch (error) {
			return {
				text: "",
				callbackNotice: `未修改：${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
				outcome: "config_write_failed",
			};
		}
		if (choice.parameter === "routing_p") bot.routingP = choice.value;
		else bot.samplingCooldownMs = choice.value;
		const label =
			choice.parameter === "routing_p" ? `插话概率已设为 ${choice.value}` : `冷却已设为 ${cooldownLabel(choice.value)}`;
		return { ...renderSettingsMenu(bot), callbackNotice: label, outcome: "ok" };
	}

	/** Scoped to the addressed bot in this chat; state lives in memory and resets on restart. */
	private fireControl(botId: string, chatId: number, mode: FireMode): ControlExecutionResult {
		const remaining = this.fire.status(botId, chatId);
		if (mode === "status") {
			return {
				text:
					remaining == null
						? `${bounded(botId)}: /fire 关闭，其他 bot 的消息不会触发本 bot。`
						: `${bounded(botId)}: /fire 开启，人类发言前还可被 bot 连续触发 ${remaining}/${FIRE_BOT_TRIGGER_BUDGET} 次。`,
				outcome: remaining == null ? "off" : "on",
			};
		}
		if (mode === "on" || (mode === "toggle" && remaining == null)) {
			this.fire.enable(botId, chatId);
			return {
				text: `${bounded(botId)}: /fire 已开启，其他 bot 的消息按正常路由触发本 bot；人类发言前最多连续 ${FIRE_BOT_TRIGGER_BUDGET} 次，重启后自动关闭。`,
				outcome: "on",
			};
		}
		this.fire.disable(botId, chatId);
		return { text: `${bounded(botId)}: /fire 已关闭，其他 bot 的消息不再触发本 bot。`, outcome: "off" };
	}

	/** Commands only ever address configured bots, and every configured bot has a runtime. */
	private bot(botId: string): BotConfig {
		return this.bots.find((candidate) => candidate.id === botId)!;
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
