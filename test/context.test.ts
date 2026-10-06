// Session resume identity and context-window accounting that Pi cannot see on its own.

import { expect, test } from "bun:test";
import { findCutPoint, SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import {
	buildContextFingerprint,
	canResumeContextSession,
	type ContextFingerprintInput,
} from "../src/agent/context-fingerprint.ts";
import {
	NO_SEND_MARKER,
	applyAssistantPersistencePolicy,
	compactionTextBudget,
} from "../src/agent/extensions/index.ts";

test("a changed fingerprint or a missing session file prevents resume", () => {
	const original = buildContextFingerprint({ personaSha256: "persona-a" } as ContextFingerprintInput);
	const changed = buildContextFingerprint({ personaSha256: "persona-b" } as ContextFingerprintInput);
	const manifest = { contextFingerprint: original, sessionFile: "/retained/session.jsonl" };
	expect(canResumeContextSession(manifest, original, true)).toBe(true);
	expect(canResumeContextSession(manifest, changed, true)).toBe(false);
	expect(canResumeContextSession(manifest, original, false)).toBe(false);
});

test("compaction cut charges context images so keepRecentTokens bounds the retained window", () => {
	// Regression: images live in custom-message details and are only materialized at
	// projection, so Pi's chars/4 cut point counted them as zero and retained an unbounded
	// image tail; production compacted after nearly every turn without shrinking.
	const manager = SessionManager.inMemory("/tmp/unused");
	const contextEntry = (text: string, images: number) =>
		manager.appendCustomMessageEntry("telegram_context_v2", text, false, {
			version: 4,
			consumedSeq: 1,
			providerText: text,
			blocks: [
				{ type: "text", text },
				...Array.from({ length: images }, (_, index) => ({
					type: "image",
					name: `img-${index}.jpg`,
					mime: "image/jpeg",
				})),
			],
			stickerCandidates: "",
			visibleMessageIds: [1],
			events: [],
		});
	const reply = () =>
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 1,
		} as never);
	contextEntry("old text ".repeat(50), 0);
	reply();
	const firstImageBatch = contextEntry("photo album", 8);
	reply();
	contextEntry("more photos", 8);
	reply();
	const latest = contextEntry("latest", 0);
	reply();
	const entries = manager.getBranch();
	// Pi's own cut keeps the whole tail: text alone is far below 20k estimated tokens.
	const piCut = findCutPoint(entries, 0, entries.length, 20_000);
	expect(entries[piCut.firstKeptEntryIndex]!.id).toBe(entries[0]!.id);
	// 16 images ≈ 17.6k charged tokens plus text: still under 20k, so Pi's cut stands.
	expect(compactionTextBudget(entries, 20_000)).toBe(20_000);
	const budget = compactionTextBudget(entries, 6_000);
	expect(budget).toBeLessThan(6_000);
	const cut = findCutPoint(entries, 0, entries.length, budget);
	// ~5 images fit; the cut moves past the first album and the discarded turns are summarized.
	const keptIndex = cut.firstKeptEntryIndex;
	expect(keptIndex).toBeGreaterThan(entries.findIndex((entry) => entry.id === firstImageBatch));
	expect(keptIndex).toBeLessThanOrEqual(entries.findIndex((entry) => entry.id === latest));
	const summarized = entries.slice(0, keptIndex).flatMap(sessionEntryToContextMessages);
	expect(summarized.length).toBeGreaterThanOrEqual(3);
	expect(JSON.stringify(summarized)).toContain("old text");
	expect(JSON.stringify(summarized)).toContain("photo album");
	// Never earlier than Pi's cut, and the summary covers every discarded entry once.
	expect(keptIndex).toBeGreaterThanOrEqual(piCut.firstKeptEntryIndex);
	expect(summarized.length).toBe(
		entries.slice(0, keptIndex).filter((entry) => entry.type === "message" || entry.type === "custom_message").length,
	);
});

test("unpublished assistant prose is absent from the next context", () => {
	let unpublished = "";
	let displayed: unknown = null;
	const result = applyAssistantPersistencePolicy(
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "real chain of thought" },
				{ type: "text", text: "private draft that was never sent" },
			],
		} as never,
		(text) => {
			unpublished = text;
		},
		(message) => {
			displayed = message.content;
		},
	);

	expect(unpublished).toBe("private draft that was never sent");
	expect(displayed).toEqual([
		{ type: "thinking", thinking: "real chain of thought" },
		{ type: "text", text: "private draft that was never sent" },
	]);
	expect((result as { content: unknown }).content).toEqual([{ type: "text", text: NO_SEND_MARKER }]);
	expect(JSON.stringify(result)).not.toContain("private draft");
});
