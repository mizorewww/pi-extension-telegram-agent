import type { Database } from "bun:sqlite";
import type { BotApi } from "../telegram/api.ts";
import { fileIdForBot } from "../media/local-cache.ts";
import { log } from "../observability/log.ts";
import {
	degradedSendResult,
	successfulSendResult,
	type SendComponentOutcome,
	type SendDegradedOutcome,
	type SendParams,
} from "./tools.ts";
import {
	classifyTelegramCreateFailure,
	localFailureCategory,
	persistSentMessageWithRetry,
	retrySqliteBusy,
	sendMarkdownTextAndPersist,
	SentMessagePersistenceError,
	type SentMessageTransport,
} from "../telegram/send.ts";

interface AgentSendContext {
	db: Database;
	api: BotApi;
	botId: string;
	chatId: number;
	emitMediaUpdates: boolean;
	visibleMessageIds: ReadonlySet<number>;
	triggerMessageId: number | null;
	recordPublicSend(): void;
	markVisible(ids: number[]): void;
	onSent(raw: Record<string, unknown>): void;
	recordEvent(kind: string, payload: unknown): void;
	stopTyping(): void;
	recordDuration(durationMs: number): void;
}

interface SendFailure {
	failed_component: "message" | "sticker";
	failed_outcome: SendComponentOutcome;
	stage: "telegram_create" | "canonical_persist" | "local_effect";
	category: string;
}

function rawTelegramMessageId(raw: Record<string, unknown>): number | null {
	const id = raw.message_id;
	return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Own the entire irreversible send boundary, including every observer and finalizer. */
export async function executeAgentSend(params: SendParams, context: AgentSendContext) {
	const startedAt = Date.now();
	try {
		return await sendAttempt(params, context);
	} finally {
		try {
			context.recordDuration(Date.now() - startedAt);
		} catch (error) {
			log.warn("agent_send", "duration_observer_failed", {
				bot_id: context.botId,
				category: localFailureCategory(error),
			});
		}
	}
}

async function sendAttempt(params: SendParams, context: AgentSendContext) {
	if (!params.message && !params.sticker) {
		log.warn("agent_send", "preflight_failed", {
			bot_id: context.botId,
			category: "empty_payload",
			trigger_message_id: context.triggerMessageId,
		});
		throw new Error("send requires at least one of message or sticker");
	}
	if (params.reply_to != null && !context.visibleMessageIds.has(params.reply_to)) {
		log.warn("agent_send", "preflight_failed", {
			bot_id: context.botId,
			category: "reply_not_visible",
			reply_to: params.reply_to,
			visible_count: context.visibleMessageIds.size,
			trigger_message_id: context.triggerMessageId,
		});
		throw new Error("messaging.reply_not_visible");
	}
	log.info("agent_send", "started", {
		bot_id: context.botId,
		has_message: Boolean(params.message),
		has_sticker: Boolean(params.sticker),
		has_reply: params.reply_to != null,
		trigger_message_id: context.triggerMessageId,
	});
	// Validate everything (incl. sticker resolution) before any network send (R7):
	// a late sticker failure would make the model retry and double-send the text.
	let stickerFileId: string | null = null;
	if (params.sticker) {
		const row = context.db.query("SELECT file_unique_id FROM media WHERE short_id = ?").get(params.sticker) as {
			file_unique_id: string;
		} | null;
		if (!row)
			throw new Error(
				`unknown sticker id: ${params.sticker} (use a short_id from the Sticker 目录 or latest recent-context candidates)`,
			);
		stickerFileId = fileIdForBot(context.db, context.botId, row.file_unique_id);
		if (!stickerFileId) {
			context.recordEvent("error", { stage: "send", code: "candidate_invariant", sticker: params.sticker });
			throw new Error(
				`candidate invariant violated: sticker ${params.sticker} is not sendable by this bot (no file_id)`,
			);
		}
	}
	const chatId = context.chatId;
	const sentIds: number[] = [];
	const failures: SendFailure[] = [];
	let remoteCommits = 0;
	let sendEventAttempted = false;
	let typingStopAttempted = false;

	const addFailure = (failure: SendFailure): void => {
		// One tool call has at most two remote components and a small fixed set of local effects.
		failures.push(failure);
	};
	const runLocalEffect = async (
		component: "message" | "sticker",
		category: string,
		effect: () => void,
		retryBusy: boolean,
	): Promise<void> => {
		try {
			if (retryBusy) await retrySqliteBusy(effect);
			else effect();
		} catch (error) {
			const localCategory = localFailureCategory(error);
			addFailure({
				failed_component: component,
				failed_outcome: "committed",
				stage: "local_effect",
				category: localCategory === "local_failure" ? category : localCategory,
			});
		}
	};
	const finishCommittedComponent = async (
		component: "message" | "sticker",
		raw: Record<string, unknown>,
		messageId: number | null,
		transport?: SentMessageTransport,
	): Promise<void> => {
		remoteCommits++;
		await runLocalEffect(component, "telemetry_failed", () => context.recordPublicSend(), true);
		if (messageId != null && !sentIds.includes(messageId)) sentIds.push(messageId);
		if (messageId != null) {
			await runLocalEffect(component, "visibility_failed", () => context.markVisible([messageId]), true);
		}
		await runLocalEffect(component, "broadcast_failed", () => context.onSent(raw), false);
		if (component === "message" && messageId != null && transport) {
			await runLocalEffect(
				component,
				"event_failed",
				() =>
					context.recordEvent(transport === "formatted" ? "markdown_sent" : "plain_fallback", {
						message_id: messageId,
					}),
				true,
			);
		}
	};
	const finishDegraded = async (outcome: SendDegradedOutcome) => {
		const component = failures[0]?.failed_component ?? (params.sticker && !params.message ? "sticker" : "message");
		if (sentIds.length > 0 && !sendEventAttempted) {
			sendEventAttempted = true;
			await runLocalEffect(
				component,
				"event_failed",
				() =>
					context.recordEvent("send", {
						reply_to: params.reply_to ?? null,
						sticker: params.sticker ?? null,
						sent: sentIds,
					}),
				true,
			);
		}
		if (!typingStopAttempted) {
			typingStopAttempted = true;
			await runLocalEffect(component, "typing_stop_failed", () => context.stopTyping(), false);
		}
		const primary = (outcome === "partial" ? failures.find((failure) => failure.stage === "telegram_create") : null) ??
			failures[0] ?? {
				failed_component: component,
				failed_outcome: "unknown" as const,
				stage: "local_effect" as const,
				category: "local_failure",
			};
		const diagnostic = {
			outcome,
			sent: [...sentIds],
			failures: failures.length > 0 ? failures : [primary],
		};
		try {
			await retrySqliteBusy(() => context.recordEvent("send_degraded", diagnostic));
		} catch {
			// The bounded, redacted process log remains available when SQLite/event sinks are unavailable.
		}
		log.warn("agent_send", "degraded", {
			bot_id: context.botId,
			outcome,
			component: primary.failed_component,
			stage: primary.stage,
			category: primary.category,
			sent_count: sentIds.length,
			trigger_message_id: context.triggerMessageId,
		});
		return degradedSendResult({ sent: [...sentIds], outcome, ...primary });
	};
	const handleCreateFailure = async (
		component: "message" | "sticker",
		error: unknown,
	): Promise<ReturnType<typeof degradedSendResult>> => {
		const failure = classifyTelegramCreateFailure(error);
		if (failure.outcome === "rejected" && remoteCommits === 0) {
			try {
				context.stopTyping();
			} catch {
				// Preserve the actionable pre-commit Telegram rejection.
			}
			throw error;
		}
		addFailure({
			failed_component: component,
			failed_outcome: failure.outcome,
			stage: "telegram_create",
			category: failure.category,
		});
		return await finishDegraded(remoteCommits > 0 ? "partial" : "unknown");
	};

	if (params.message) {
		try {
			const { raw, canonical, transport } = await sendMarkdownTextAndPersist(
				context.db,
				context.api,
				context.botId,
				chatId,
				params.message,
				params.reply_to,
			);
			await finishCommittedComponent("message", raw, canonical.message_id, transport);
		} catch (error) {
			if (!(error instanceof SentMessagePersistenceError)) return await handleCreateFailure("message", error);
			addFailure({
				failed_component: "message",
				failed_outcome: "committed",
				stage: "canonical_persist",
				category: localFailureCategory(error.cause),
			});
			await finishCommittedComponent("message", error.raw, rawTelegramMessageId(error.raw), error.transport);
		}
	}
	if (stickerFileId) {
		try {
			const raw = await context.api.sendSticker(chatId, stickerFileId, params.reply_to);
			try {
				const canonical = await persistSentMessageWithRetry(
					context.db,
					context.botId,
					raw,
					"sticker",
					context.emitMediaUpdates,
				);
				await finishCommittedComponent("sticker", raw, canonical.message_id);
			} catch (error) {
				if (!(error instanceof SentMessagePersistenceError)) throw error;
				addFailure({
					failed_component: "sticker",
					failed_outcome: "committed",
					stage: "canonical_persist",
					category: localFailureCategory(error.cause),
				});
				await finishCommittedComponent("sticker", error.raw, rawTelegramMessageId(error.raw));
			}
		} catch (error) {
			return await handleCreateFailure("sticker", error);
		}
	}
	sendEventAttempted = true;
	typingStopAttempted = true;
	await runLocalEffect(
		params.sticker && !params.message ? "sticker" : "message",
		"event_failed",
		() =>
			context.recordEvent("send", {
				reply_to: params.reply_to ?? null,
				sticker: params.sticker ?? null,
				sent: sentIds,
			}),
		true,
	);
	await runLocalEffect(
		params.sticker && !params.message ? "sticker" : "message",
		"typing_stop_failed",
		() => context.stopTyping(),
		false,
	);
	if (failures.length > 0) return await finishDegraded("committed");
	log.info("agent_send", "committed", {
		bot_id: context.botId,
		sent_count: sentIds.length,
		trigger_message_id: context.triggerMessageId,
	});
	return successfulSendResult(sentIds);
}
