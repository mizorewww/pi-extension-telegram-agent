import type { Database } from "bun:sqlite";
import type { BotApi } from "../telegram/api.ts";
import { isReactionEmoji } from "../telegram/api.ts";
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

/** Reject before any network call; returns the params to send and the sticker file_id, if any. */
function preflight(
	params: SendParams,
	context: AgentSendContext,
): { params: SendParams; stickerFileId: string | null } {
	const reject = (category: string, message: string, fields: Record<string, unknown> = {}): never => {
		log.warn("agent_send", "preflight_failed", {
			bot_id: context.botId,
			category,
			trigger_message_id: context.triggerMessageId,
			...fields,
		});
		throw new Error(message);
	};
	if (!params.message && !params.sticker && !params.reaction)
		reject("empty_payload", "send requires at least one of message, sticker or reaction");
	if (params.reaction != null && params.reply_to == null)
		reject("reaction_without_target", "reaction requires reply_to: the reaction lands on the replied message");
	if (params.reaction != null && !isReactionEmoji(params.reaction)) {
		// Decoration must not cost a whole extra provider turn: drop it when there is content.
		if (!params.message && !params.sticker)
			reject(
				"invalid_reaction_emoji",
				`invalid reaction emoji: ${params.reaction} (Telegram accepts only its fixed reaction emoji set, e.g. 👍 ❤️ 🔥 🤣 🎉)`,
			);
		log.warn("agent_send", "reaction_dropped", {
			bot_id: context.botId,
			category: "invalid_reaction_emoji",
			trigger_message_id: context.triggerMessageId,
		});
		params = { ...params, reaction: undefined };
	}
	if (params.reply_to != null && !context.visibleMessageIds.has(params.reply_to))
		reject("reply_not_visible", "messaging.reply_not_visible", {
			reply_to: params.reply_to,
			visible_count: context.visibleMessageIds.size,
		});
	// Resolve the sticker before sending anything: a late failure would make the model retry
	// and double-send the text.
	if (!params.sticker) return { params, stickerFileId: null };
	const row = context.db.query("SELECT file_unique_id FROM media WHERE short_id = ?").get(params.sticker) as {
		file_unique_id: string;
	} | null;
	if (!row)
		throw new Error(
			`unknown sticker id: ${params.sticker} (use a short_id from the Sticker 目录 or the latest 〔系统附注〕)`,
		);
	const fileId = fileIdForBot(context.db, context.botId, row.file_unique_id);
	if (fileId) return { params, stickerFileId: fileId };
	context.recordEvent("error", { stage: "send", code: "candidate_invariant", sticker: params.sticker });
	throw new Error(`candidate invariant violated: sticker ${params.sticker} is not sendable by this bot (no file_id)`);
}

async function sendAttempt(requested: SendParams, context: AgentSendContext) {
	const { params, stickerFileId } = preflight(requested, context);
	log.info("agent_send", "started", {
		bot_id: context.botId,
		has_message: Boolean(params.message),
		has_sticker: Boolean(params.sticker),
		has_reaction: params.reaction != null,
		has_reply: params.reply_to != null,
		trigger_message_id: context.triggerMessageId,
	});
	const chatId = context.chatId;
	const primaryComponent = params.sticker && !params.message ? "sticker" : "message";
	const sent: number[] = [];
	const failures: SendFailure[] = [];
	let reactedTo: number | null = null;

	/** After a remote commit, local bookkeeping is best effort: a failure degrades, never resends. */
	const local = async (component: "message" | "sticker", category: string, effect: () => void) => {
		try {
			await retrySqliteBusy(effect);
		} catch (error) {
			const localCategory = localFailureCategory(error);
			failures.push({
				failed_component: component,
				failed_outcome: "committed",
				stage: "local_effect",
				category: localCategory === "local_failure" ? category : localCategory,
			});
		}
	};
	const committed = async (
		component: "message" | "sticker",
		raw: Record<string, unknown>,
		persistFailure: unknown,
		eventKind?: string,
	) => {
		const messageId = raw.message_id as number;
		sent.push(messageId);
		if (persistFailure)
			failures.push({
				failed_component: component,
				failed_outcome: "committed",
				stage: "canonical_persist",
				category: localFailureCategory(persistFailure),
			});
		await local(component, "telemetry_failed", () => context.recordPublicSend());
		await local(component, "visibility_failed", () => context.markVisible([messageId]));
		await local(component, "broadcast_failed", () => context.onSent(raw));
		if (eventKind)
			await local(component, "event_failed", () => context.recordEvent(eventKind, { message_id: messageId }));
	};
	const finish = async (outcome: SendDegradedOutcome | null) => {
		if (outcome == null || sent.length > 0)
			await local(primaryComponent, "event_failed", () =>
				context.recordEvent("send", {
					reply_to: params.reply_to ?? null,
					sticker: params.sticker ?? null,
					reaction: params.reaction ?? null,
					reacted_to: reactedTo,
					sent,
				}),
			);
		await local(primaryComponent, "typing_stop_failed", () => context.stopTyping());
		if (outcome == null && failures.length === 0) {
			log.info("agent_send", "committed", {
				bot_id: context.botId,
				sent_count: sent.length,
				trigger_message_id: context.triggerMessageId,
			});
			return successfulSendResult(sent);
		}
		const degraded = outcome ?? "committed";
		const primary =
			(degraded === "partial" ? failures.find((failure) => failure.stage === "telegram_create") : undefined) ??
			failures[0]!;
		try {
			await retrySqliteBusy(() =>
				context.recordEvent("send_degraded", { outcome: degraded, sent: [...sent], failures }),
			);
		} catch {
			// The bounded, redacted process log remains available when SQLite/event sinks are unavailable.
		}
		log.warn("agent_send", "degraded", {
			bot_id: context.botId,
			outcome: degraded,
			component: primary.failed_component,
			stage: primary.stage,
			category: primary.category,
			sent_count: sent.length,
			trigger_message_id: context.triggerMessageId,
		});
		return degradedSendResult({ sent: [...sent], outcome: degraded, ...primary });
	};
	/** Only a deterministic rejection before any commit may go back to the model as a retryable error. */
	const createFailed = async (component: "message" | "sticker", error: unknown) => {
		const failure = classifyTelegramCreateFailure(error);
		if (failure.outcome === "rejected" && sent.length === 0) {
			try {
				context.stopTyping();
			} catch {
				// Preserve the actionable pre-commit Telegram rejection.
			}
			throw error;
		}
		failures.push({
			failed_component: component,
			failed_outcome: failure.outcome,
			stage: "telegram_create",
			category: failure.category,
		});
		return await finish(sent.length > 0 ? "partial" : "unknown");
	};

	if (params.message) {
		try {
			const { raw, transport } = await sendMarkdownTextAndPersist(
				context.db,
				context.api,
				context.botId,
				chatId,
				params.message,
				params.reply_to,
			);
			await committed("message", raw, null, transport === "formatted" ? "markdown_sent" : "plain_fallback");
		} catch (error) {
			if (!(error instanceof SentMessagePersistenceError)) return await createFailed("message", error);
			await committed(
				"message",
				error.raw,
				error.cause,
				error.transport === "formatted" ? "markdown_sent" : "plain_fallback",
			);
		}
	}
	if (stickerFileId) {
		let raw: Record<string, unknown>;
		try {
			raw = await context.api.sendSticker(chatId, stickerFileId, params.reply_to);
		} catch (error) {
			return await createFailed("sticker", error);
		}
		try {
			await persistSentMessageWithRetry(context.db, context.botId, raw, "sticker", context.emitMediaUpdates);
			await committed("sticker", raw, null);
		} catch (error) {
			await committed("sticker", raw, (error as SentMessagePersistenceError).cause);
		}
	}
	// The reaction is best-effort decoration on the replied message. After a commit its failure
	// is recorded but never downgrades the delivered message; a reaction-only failure goes back
	// to the model, since setMessageReaction is idempotent and cannot duplicate a message.
	if (params.reaction && params.reply_to != null) {
		try {
			await context.api.setMessageReaction(chatId, params.reply_to, params.reaction);
			reactedTo = params.reply_to;
		} catch (error) {
			if (sent.length === 0) {
				try {
					context.stopTyping();
				} catch {
					// Preserve the actionable reaction error.
				}
				throw error;
			}
			const category = classifyTelegramCreateFailure(error).category;
			log.warn("agent_send", "reaction_failed", {
				bot_id: context.botId,
				category,
				target_message_id: params.reply_to,
				trigger_message_id: context.triggerMessageId,
			});
			await local("message", "event_failed", () =>
				context.recordEvent("reaction_failed", { message_id: params.reply_to, category }),
			);
		}
	}
	return await finish(null);
}
