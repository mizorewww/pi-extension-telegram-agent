// Structured context ownership walker: recover the SQLite half of prior custom-message
// commits from session entries. Provider-rendered strings are never parsed for identities.
//
// Visibility semantics: every walk input (startup reconcile over buildContextEntries(),
// handleBeforeCompact over keptEntries) is the active window after the last compaction
// boundary, so the union of custom_message visibleMessageIds inside the window is the true
// visible set. Compaction entries only carry the monotonic cursor forward: their
// details.visibleMessageIds is the cumulative union computed by this same walker, so
// re-adding it could never shrink the set (RC1 phantom visibility).

import type { Database } from "bun:sqlite";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { getConsumedSeq, replaceVisibleMessageIds, setConsumedSeq } from "../db/message-events.ts";
import { removeReplyObligations } from "../db/reply-obligations.ts";
import {
	isTelegramContextDetails,
	TELEGRAM_CONTEXT_TYPE,
	TELEGRAM_CONTEXT_VERSION,
	type TelegramContextDetails,
	viewImageRefs,
} from "./extensions/index.ts";
import type { PackedMessageEvents } from "./token-packer.ts";

export const TELEGRAM_CONTEXT_COMMIT_TYPE = "telegram_context_commit_v2";

interface ContextState {
	consumedSeq: number;
	visible: Set<number>;
}

/**
 * One packed batch as a Telegram context message. Its content is the rendered text; the sticker
 * note stays in details and is projected after the batch, so compaction never reads it.
 */
export function batchMessage(
	packed: Pick<PackedMessageEvents, "text" | "visibleMessageIds">,
	consumedSeq: number,
	stickerCandidates: string,
) {
	const details: TelegramContextDetails = {
		version: TELEGRAM_CONTEXT_VERSION,
		consumedSeq,
		stickerCandidates,
		visibleMessageIds: packed.visibleMessageIds,
	};
	return { customType: TELEGRAM_CONTEXT_TYPE, content: packed.text, display: false, details };
}

/** Message ids made visible by batches steered into the turn that started at `turnHighWater`. */
export function steeredVisibleIds(entries: readonly SessionEntry[], turnHighWater: number): Set<number> {
	const ids = new Set<number>();
	for (const entry of entries)
		if (
			entry.type === "custom_message" &&
			isTelegramContextDetails(entry.details) &&
			entry.details.consumedSeq > turnHighWater
		)
			for (const id of entry.details.visibleMessageIds) ids.add(id);
	return ids;
}

/** Structured context ownership; provider-rendered strings are never parsed for identities. */
export function deliveredCommitIdsFromEntries(entries: readonly SessionEntry[]): Set<number> {
	const delivered = new Set<number>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TELEGRAM_CONTEXT_COMMIT_TYPE) continue;
		const ids = (entry.data as { deliveredObligationIds?: unknown } | undefined)?.deliveredObligationIds;
		if (!Array.isArray(ids)) continue;
		for (const messageId of ids) {
			if (Number.isSafeInteger(messageId) && (messageId as number) > 0) delivered.add(messageId as number);
		}
	}
	return delivered;
}

/** Recover the SQLite half of prior custom-message commits without parsing rendered text. */
export function reconcileContextStateFromSession(
	db: Database,
	sessionManager: SessionManager,
	botId: string,
	chatId: number,
	epoch: number,
): Set<number> {
	const state = contextStateFromEntries(sessionManager.buildContextEntries(), getConsumedSeq(db, botId, chatId));
	setConsumedSeq(db, botId, chatId, state.consumedSeq);
	replaceVisibleMessageIds(db, botId, chatId, epoch, [...state.visible]);
	const delivered = deliveredCommitIdsFromEntries(sessionManager.getBranch());
	removeReplyObligations(
		db,
		botId,
		[...delivered].map((messageId) => ({ chatId, messageId })),
	);
	return state.visible;
}

export function contextStateFromEntries(entries: readonly SessionEntry[], initialConsumedSeq = 0): ContextState {
	let consumedSeq = initialConsumedSeq;
	const visible = new Set<number>();
	for (const entry of entries) {
		if (entry.type === "custom_message" && isTelegramContextDetails(entry.details)) {
			consumedSeq = Math.max(consumedSeq, entry.details.consumedSeq);
			for (const messageId of entry.details.visibleMessageIds) visible.add(messageId);
			continue;
		}
		if (entry.type === "compaction") {
			// Compaction is a replacement boundary, but its details.visibleMessageIds is the
			// cumulative union computed by this same walker, so re-adding it would never shrink
			// the visible set. Only the monotonic cursor is carried forward; visibility comes
			// from the custom_message entries inside the active window after the boundary.
			const details = entry.details as { consumedSeq?: unknown } | undefined;
			if (Number.isSafeInteger(details?.consumedSeq))
				consumedSeq = Math.max(consumedSeq, details!.consumedSeq as number);
			continue;
		}
		// A viewed image puts its whole message (rendered line plus image) in context.
		const viewed = entry.type === "message" ? viewImageRefs(entry.message) : null;
		if (viewed) {
			visible.add(viewed.messageId);
			continue;
		}
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "send") {
			const sent = (entry.message.details as { sent?: unknown } | undefined)?.sent;
			if (Array.isArray(sent)) {
				for (const messageId of sent) {
					if (Number.isSafeInteger(messageId) && (messageId as number) > 0) visible.add(messageId as number);
				}
			}
		}
	}
	return { consumedSeq, visible };
}
