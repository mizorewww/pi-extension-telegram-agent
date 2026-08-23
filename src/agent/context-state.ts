// Structured context ownership walker: recover the SQLite half of prior custom-message
// commits from session entries. Provider-rendered strings are never parsed for identities.
//
// Visibility semantics: every walk input (startup reconcile over buildContextEntries(),
// handleBeforeCompact over keptEntries) is the active window after the last compaction
// boundary, so the union of custom_message visibleMessageIds inside the window is the true
// visible set. Compaction entries only carry the monotonic cursor forward: their
// details.visibleMessageIds is the cumulative union computed by this same walker, so
// re-adding it could never shrink the set (RC1 phantom visibility).

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isTelegramContextDetails } from "./extensions/index.ts";

export interface ContextState {
	consumedSeq: number;
	visible: Set<number>;
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
