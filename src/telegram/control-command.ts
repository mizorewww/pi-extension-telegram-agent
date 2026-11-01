import type { Database } from "bun:sqlite";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BotFire, FIRE_BOT_TRIGGER_BUDGET } from "../agent/router.ts";
import type {
	ManualCompactResult,
	ModelControlResult,
	ModelControlSelection,
	NewSessionResult,
} from "../agent/runtime.ts";
import type { BotConfig, TelegramAdmin } from "../config.ts";
import { loadBotStats } from "../db/usage.ts";
import type { RuntimeControlSnapshot } from "../ipc.ts";
import { log } from "../observability/log.ts";
import { buildBotStatusView, renderBotStatusPlain } from "../observability/status.ts";
import { updateBotConfigField, updateBotModelConfig } from "../onboarding/config-core.ts";
import type { InlineKeyboardMarkup } from "./api.ts";
import {
	bounded,
	boundedMarkdownStatus,
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

const CONTROL_COMMAND_AUDIT_EVENT = "telegram_control";

export interface TelegramControlRuntime {
	controlSnapshot(): RuntimeControlSnapshot;
	compactForControl(): Promise<ManualCompactResult>;
	resetBoxForControl(): Promise<{ ok: true } | { ok: false; code: "unavailable" | "failed" }>;
	taskStatusForControl(): string | null;
	cancelTaskForControl(taskId: string): { ok: true } | { ok: false; code: "unavailable" | "unknown_task" };
	newSessionForControl(): Promise<NewSessionResult>;
	consumeControlMessage(messageId: number): void;
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
	/** Markdown sent as classic Telegram entities (old clients cannot show Rich Messages). */
	markdown?: string;
	replyMarkup?: InlineKeyboardMarkup;
	callbackNotice?: string;
}

interface ControlExecutionResult {
	text: string;
	markdown?: string;
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
		if (command.callbackQueryId) return this.handleCallback(command);
		const claimed = this.claim(command);
		this.consumeEveryRuntime(command.messageId);
		if (!claimed) return this.result(command, null);
		const startedAt = Date.now();
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
				return { ...this.result(command, executed.text, executed.markdown), replyMarkup: executed.replyMarkup };
			});
		}
		const executed = await this.execute(command);
		this.audit(command, true, executed.outcome, startedAt);
		return this.result(command, executed.text, executed.markdown);
	}

	private async handleCallback(command: ParsedTelegramControlCommand): Promise<TelegramControlResult> {
		const startedAt = Date.now();
		const authorized = isHuman(command.sender) && this.isAdmin(command.sender);
		const owned = this.db
			.query(`SELECT 1 FROM telegram_control_messages c JOIN messages m USING (chat_id, message_id)
			WHERE c.chat_id = ? AND c.message_id = ? AND m.first_seen_by = ? AND m.is_bot = 1`)
			.get(command.chatId, command.messageId, command.replyBotId);
		let executed: ControlExecutionResult;
		if (!authorized)
			executed = {
				text: "",
				callbackNotice: "权限不足：此操作仅限 telegram_admins 白名单。",
				outcome: "permission_denied",
			};
		else if (!owned)
			executed = {
				text: "",
				callbackNotice: `菜单已失效，请重新发送 /${command.action.kind}。`,
				outcome: "stale_menu",
			};
		else if (this.mutations > 0)
			executed = { text: "", callbackNotice: "有管理操作正在执行，请稍后重试。", outcome: "busy" };
		else executed = await this.enqueueMutation(() => this.execute(command));
		this.audit(command, authorized, executed.outcome, startedAt);
		return {
			...this.result(command, executed.text || null),
			replyMarkup: executed.replyMarkup,
			callbackNotice: executed.callbackNotice,
		};
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
				return this.settings(command.replyBotId, command.action.data);
			case "compact":
				return await this.compact(command.replyBotId);
			case "new":
				return await this.newSession(command.replyBotId);
			case "model":
				return await this.model(command.replyBotId, command.action.data);
			case "fire":
				return this.fireControl(command.replyBotId, command.chatId, command.action.mode);
			case "box_reset":
				return await this.resetBox(command.replyBotId);
			case "task_status":
				return this.taskStatus(command.replyBotId);
			case "task_cancel":
				return this.cancelTask(command.replyBotId, command.action.taskId);
			case "usage":
				return { text: USAGE_TEXT, outcome: "usage" };
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
			const result = await this.runtime(botId).changeModelForControl(model.provider, model.id, (value) =>
				updateBotModelConfig(this.rootDir, botId, value),
			);
			if (!result.ok) {
				const message =
					result.code === "image_input_unsupported"
						? "hybrid 媒体模式需要支持图片输入的模型。"
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

	private formatStatus(botId: string): ControlExecutionResult {
		const bot = this.bot(botId);
		const snapshot = this.runtime(botId).controlSnapshot();
		const view = buildBotStatusView(bot, loadBotStats(this.db, bot.id), snapshot);
		return {
			text: renderBotStatusPlain(view),
			markdown: boundedMarkdownStatus(view),
			outcome: "ok",
		};
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

	private taskStatus(botId: string): { text: string; outcome: string } {
		const text = this.runtime(botId).taskStatusForControl();
		if (text == null) return { text: `${bounded(botId)}: 这个 bot 没有开启后台任务。`, outcome: "unavailable" };
		return { text: boundedReply(`${bounded(botId)} 的任务：\n${text}`), outcome: "ok" };
	}

	private cancelTask(botId: string, taskId: string): { text: string; outcome: string } {
		const result = this.runtime(botId).cancelTaskForControl(taskId);
		if (result.ok) return { text: `${bounded(botId)}: 已取消 ${taskId}。`, outcome: "ok" };
		return {
			text: `${bounded(botId)}: ${result.code === "unavailable" ? "这个 bot 没有开启后台任务。" : `没有正在运行的 ${taskId}。`}`,
			outcome: result.code,
		};
	}

	private async resetBox(botId: string): Promise<{ text: string; outcome: string }> {
		const result = await this.runtime(botId).resetBoxForControl();
		if (result.ok) return { text: `${bounded(botId)}: 工作区已清空。`, outcome: "ok" };
		return {
			text: `${bounded(botId)}: ${result.code === "unavailable" ? "这个 bot 没有工作区。" : "清空失败，请查看日志。"}`,
			outcome: result.code,
		};
	}

	private async compact(botId: string): Promise<{ text: string; outcome: string }> {
		const result = await this.runtime(botId).compactForControl();
		if (result.ok) return { text: `${bounded(botId)}: compact 完成，epoch=${result.epoch}`, outcome: "ok" };
		return { text: `${bounded(botId)}: ${compactFailureText(result.code)}`, outcome: result.code };
	}

	private async newSession(botId: string): Promise<{ text: string; outcome: string }> {
		const result = await this.runtime(botId).newSessionForControl();
		if (result.ok) return { text: `${bounded(botId)}: 已开启新会话，epoch=${result.epoch}`, outcome: "ok" };
		const reason =
			result.code === "busy" ? "busy，请稍后重试" : result.code === "stopping" ? "正在停止" : `失败（${result.code}）`;
		return { text: `${bounded(botId)}: 新会话${reason}`, outcome: result.code };
	}

	/** Commands only ever address configured bots, and every configured bot has a runtime. */
	private bot(botId: string): BotConfig {
		return this.bots.find((candidate) => candidate.id === botId)!;
	}

	private runtime(botId: string): TelegramControlRuntime {
		return this.runtimes.get(botId)!;
	}

	private isAdmin(sender: ControlSender): boolean {
		return sender.id != null && this.admins.includes(sender.id);
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
		const target = [
			"status",
			"compact",
			"new",
			"set",
			"model",
			"fire",
			"box_reset",
			"task_status",
			"task_cancel",
		].includes(command.action.kind)
			? command.replyBotId
			: null;
		const finishedAt = Date.now();
		this.db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (?, ?, ?, ?)").run(
			command.replyBotId,
			finishedAt,
			CONTROL_COMMAND_AUDIT_EVENT,
			JSON.stringify({
				command: command.action.kind,
				target,
				sender_id: command.sender.id,
				authorized,
				outcome,
				duration_ms: Math.max(0, finishedAt - startedAt),
			}),
		);
	}

	private result(command: ParsedTelegramControlCommand, text: string | null, markdown?: string): TelegramControlResult {
		return {
			chatId: command.chatId,
			replyToMessageId: command.messageId,
			replyBotId: command.replyBotId,
			text: text == null ? null : boundedReply(text),
			...(markdown ? { markdown } : {}),
		};
	}

	private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
		this.mutations++;
		const result = this.mutationTail.then(operation, operation);
		this.mutationTail = result.then(
			() => {
				this.mutations--;
			},
			() => {
				this.mutations--;
			},
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
