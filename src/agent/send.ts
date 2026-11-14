import type { Database } from "../db/db.ts";
import type { BotApi } from "../telegram/api.ts";
import { isReactionEmoji } from "../telegram/api.ts";
import { groupMessage } from "../db/message-events.ts";
import { fileIdFor } from "../media/local-cache.ts";
import { log } from "../observability/log.ts";
import { BoxError, type WorkBox } from "../sandbox/box.ts";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	degradedSendResult,
	successfulSendResult,
	type SendComponentOutcome,
	type SendDegradedOutcome,
	type SendFile,
	type SendParams,
} from "./tools.ts";
import {
	classifyTelegramCreateFailure,
	localFailureCategory,
	persistSentMessage,
	sendMarkdownTextAndPersist,
	sendRichMarkdownAndPersist,
	SentMessagePersistenceError,
} from "../telegram/send.ts";

interface AgentSendContext {
	db: Database;
	api: BotApi;
	chatId: number;
	/** The group's narrowed reaction set; null when every standard reaction is allowed. */
	allowedReactions: ReadonlySet<string> | null;
	/** The bot's work box; `files` are only accepted when it has one. */
	box: WorkBox | null;
	triggerMessageId: number | null;
}

interface SendFailure {
	failed_component: "message" | "sticker" | "file";
	failed_outcome: SendComponentOutcome;
	stage: "telegram_create" | "canonical_persist" | "local_effect";
	category: string;
}

const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
const PHOTO_EXTENSION = /\.(jpe?g|png|webp)$/i;

interface PreparedFiles {
	photos: { name: string; bytes: Uint8Array }[];
	documents: { name: string; bytes: Uint8Array }[];
}

/**
 * Copy every requested file out of the box before anything is sent, so a missing or oversized
 * file is a retryable error instead of a half-delivered send.
 */
async function prepareFiles(files: readonly SendFile[] | undefined, box: WorkBox | null): Promise<PreparedFiles> {
	const prepared: PreparedFiles = { photos: [], documents: [] };
	if (!files || files.length === 0) return prepared;
	if (!box) throw new Error("files need a work box, and this bot has none");
	for (const file of files) {
		let copy: Awaited<ReturnType<WorkBox["copyOut"]>>;
		try {
			copy = await box.copyOut(file.path, DOCUMENT_MAX_BYTES);
		} catch (error) {
			throw new Error(`file ${file.path}: ${error instanceof BoxError ? error.message : "copy failed"}`);
		}
		try {
			const name = basename(copy.hostPath);
			const bytes = new Uint8Array(readFileSync(copy.hostPath));
			const photoCapable = PHOTO_EXTENSION.test(name) && copy.size <= PHOTO_MAX_BYTES;
			if (file.as === "photo" && !photoCapable)
				throw new Error(`file ${file.path}: photos must be jpg/png/webp up to 10 MB; use as: "document"`);
			const asPhoto = file.as === "photo" || ((file.as ?? "auto") === "auto" && photoCapable);
			(asPhoto ? prepared.photos : prepared.documents).push({ name, bytes });
		} finally {
			copy.cleanup();
		}
	}
	return prepared;
}

/** Reject before any network call; returns the params to send and the sticker file_id, if any. */
function preflight(
	params: SendParams,
	context: AgentSendContext,
): { params: SendParams; stickerFileId: string | null } {
	const reject = (category: string, message: string, fields: Record<string, unknown> = {}): never => {
		log.warn("agent_send", "preflight_failed", {
			category,
			trigger_message_id: context.triggerMessageId,
			...fields,
		});
		throw new Error(message);
	};
	if (!params.message && !params.rich && !params.sticker && !params.reaction && !params.files?.length)
		reject("empty_payload", "send requires at least one of message, rich, sticker, files or reaction");
	if (params.message && params.rich) reject("message_and_rich", "use either message or rich, not both");
	if (params.reaction != null && params.reply_to == null)
		reject("reaction_without_target", "reaction requires reply_to: the reaction lands on the replied message");
	if (params.reaction != null && !isReactionEmoji(params.reaction, context.allowedReactions)) {
		// Decoration must not cost a whole extra provider turn: drop it when there is content.
		if (!params.message && !params.sticker && !params.files?.length)
			reject(
				"invalid_reaction_emoji",
				`invalid reaction emoji: ${params.reaction} (use one this group allows${context.allowedReactions ? `: ${[...context.allowedReactions].join(" ")}` : ", e.g. 👍 ❤️ 🔥 🤣 🎉"})`,
			);
		log.warn("agent_send", "reaction_dropped", {
			category: "invalid_reaction_emoji",
			trigger_message_id: context.triggerMessageId,
		});
		params = { ...params, reaction: undefined };
	}
	// Any real message of this group may be replied to or reacted on, including old ones found
	// with tg_messages; only an id that does not exist (an invented one) is refused.
	if (params.reply_to != null && !groupMessage(context.db, context.chatId, params.reply_to))
		reject("reply_unknown", `reply_to #${params.reply_to} is not a message of this group; use a real #id`, {
			reply_to: params.reply_to,
		});
	// Resolve the sticker before sending anything: a late failure would make the model retry
	// and double-send the text.
	if (!params.sticker) return { params, stickerFileId: null };
	const row = context.db.prepare("SELECT file_unique_id FROM media WHERE short_id = ?").get(params.sticker) as {
		file_unique_id: string;
	} | null;
	if (!row)
		throw new Error(
			`unknown sticker id: ${params.sticker} (use a short_id from the Sticker 目录 or the latest 〔系统附注〕)`,
		);
	const fileId = fileIdFor(context.db, row.file_unique_id);
	if (fileId) return { params, stickerFileId: fileId };
	log.info("agent", "error");
	throw new Error(`candidate invariant violated: sticker ${params.sticker} is not sendable by this bot (no file_id)`);
}

export async function executeAgentSend(requested: SendParams, context: AgentSendContext) {
	const { params, stickerFileId } = preflight(requested, context);
	let files: PreparedFiles;
	try {
		files = await prepareFiles(params.files, context.box);
	} catch (error) {
		log.warn("agent_send", "preflight_failed", {
			category: "file_unavailable",
			trigger_message_id: context.triggerMessageId,
		});
		throw error;
	}
	log.info("agent_send", "started", {
		has_message: Boolean(params.message),
		has_rich: Boolean(params.rich),
		has_sticker: Boolean(params.sticker),
		has_reaction: params.reaction != null,
		has_reply: params.reply_to != null,
		files: files.photos.length + files.documents.length,
		trigger_message_id: context.triggerMessageId,
	});
	const chatId = context.chatId;
	const sent: number[] = [];
	const failures: SendFailure[] = [];
	let reactedTo: number | null = null;

	const committed = async (
		component: SendFailure["failed_component"],
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
		if (eventKind) log.info("agent", eventKind);
	};
	const finish = async (outcome: SendDegradedOutcome | null) => {
		if (outcome == null || sent.length > 0) log.info("agent", "send", { reacted: reactedTo != null });
		if (outcome == null && failures.length === 0) {
			log.info("agent_send", "committed", {
				sent_count: sent.length,
				trigger_message_id: context.triggerMessageId,
			});
			return successfulSendResult(sent);
		}
		const degraded = outcome ?? "committed";
		const primary =
			(degraded === "partial" ? failures.find((failure) => failure.stage === "telegram_create") : undefined) ??
			failures[0]!;
		log.info("agent", "send_degraded");
		log.warn("agent_send", "degraded", {
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
	const createFailed = async (component: SendFailure["failed_component"], error: unknown) => {
		const failure = classifyTelegramCreateFailure(error);
		if (failure.outcome === "rejected" && sent.length === 0) {
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
	if (params.rich) {
		try {
			const { raw } = await sendRichMarkdownAndPersist(context.db, context.api, chatId, params.rich, params.reply_to);
			await committed("message", raw, null, "rich_sent");
		} catch (error) {
			if (!(error instanceof SentMessagePersistenceError)) return await createFailed("message", error);
			await committed("message", error.raw, error.cause, "rich_sent");
		}
	}
	// Files follow the text; only the first created message carries the reply.
	for (const [kind, group] of [
		["photo", files.photos],
		["document", files.documents],
	] as const) {
		if (group.length === 0) continue;
		let raws: Record<string, unknown>[];
		try {
			raws = await context.api.sendFiles(chatId, kind, group, sent.length === 0 ? params.reply_to : undefined);
		} catch (error) {
			return await createFailed("file", error);
		}
		for (const raw of raws) {
			try {
				persistSentMessage(context.db, raw, "file");
				await committed("file", raw, null, "file_sent");
			} catch (error) {
				await committed("file", raw, (error as SentMessagePersistenceError).cause, "file_sent");
			}
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
			persistSentMessage(context.db, raw, "sticker");
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
				throw error;
			}
			const category = classifyTelegramCreateFailure(error).category;
			log.warn("agent_send", "reaction_failed", {
				category,
				target_message_id: params.reply_to,
				trigger_message_id: context.triggerMessageId,
			});
		}
	}
	return await finish(null);
}
