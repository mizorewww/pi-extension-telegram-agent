// Regression tests for the visible-set walker (RC1: phantom visibility across compaction).
// Production pattern: custom_message batches interleaved with compaction entries whose
// details.visibleMessageIds is the cumulative union computed by the same walker, so a
// compaction branch that re-adds those ids can never shrink the visible set.

import { expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { contextStateFromEntries } from "../src/agent/context-state.ts";
import { TELEGRAM_CONTEXT_TYPE, TELEGRAM_CONTEXT_VERSION } from "../src/agent/extensions/index.ts";

function customMessage(id: string, visible: number[], consumedSeq: number): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "2026-08-08T00:00:00.000Z",
		customType: TELEGRAM_CONTEXT_TYPE,
		content: "provider text",
		display: false,
		details: {
			version: TELEGRAM_CONTEXT_VERSION,
			consumedSeq,
			providerText: "provider text",
			stickerCandidates: "",
			visibleMessageIds: visible,
			events: visible.map((messageId, index) => ({
				ingestSeq: consumedSeq - visible.length + index + 1,
				kind: "message",
				chatId: -1001,
				messageId,
				fullMessageVisible: true,
			})),
		},
	};
}

function compaction(id: string, visible: number[], consumedSeq: number): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: "2026-08-08T00:00:00.000Z",
		summary: "summary",
		firstKeptEntryId: "kept",
		tokensBefore: 100,
		details: { version: TELEGRAM_CONTEXT_VERSION, consumedSeq, visibleMessageIds: visible },
	};
}

test("visible-set walker ignores stale compaction unions (RC1)", () => {
	const entries = [
		customMessage("c1", [1, 2], 2),
		compaction("k1", [1, 2, 3, 4, 5], 5),
		customMessage("c2", [3, 4], 6),
		compaction("k2", [1, 2, 3, 4, 5, 6, 7], 8),
		customMessage("c3", [5, 6], 10),
	];
	const state = contextStateFromEntries(entries, 0);
	// Stale id 7 (only present in the old compaction union) must be excluded.
	expect([...state.visible].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
	expect(state.consumedSeq).toBe(10);
});

test("walker keeps send toolResult ids and a monotonic cursor", () => {
	const entries = [
		customMessage("c1", [1], 3),
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-08-08T00:00:00.000Z",
			message: {
				role: "toolResult",
				toolName: "send",
				details: { sent: [100, 101] },
			},
		} as never,
	];
	const state = contextStateFromEntries(entries, 7);
	expect([...state.visible].sort((a, b) => a - b)).toEqual([1, 100, 101]);
	expect(state.consumedSeq).toBe(7);
});
