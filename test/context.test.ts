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

test("compaction cut charges viewed images so keepRecentTokens bounds the retained window", () => {
	// Regression: images live in view_image details and are only materialized at projection, so
	// Pi's chars/4 cut point counted them as zero and retained an unbounded image tail;
	// production compacted after nearly every turn without shrinking.
	const manager = SessionManager.inMemory("/tmp/unused");
	const contextEntry = (text: string, images: number) => {
		const id = manager.appendCustomMessageEntry("telegram_context_v2", text, false, {
			version: 5,
			consumedSeq: 1,
			providerText: text,
			stickerCandidates: "",
			visibleMessageIds: [1],
			events: [],
		});
		if (images > 0) {
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: `view-${id}`, name: "view_image", arguments: { message_id: 1 } }],
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
				stopReason: "toolUse",
				timestamp: 1,
			} as never);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: `view-${id}`,
				toolName: "view_image",
				content: [{ type: "text", text: "#1 [图片]" }],
				details: {
					messageId: 1,
					images: Array.from({ length: images }, (_, index) => ({ name: `img-${index}.jpg`, mime: "image/jpeg" })),
				},
				isError: false,
				timestamp: 1,
			} as never);
		}
		return id;
	};
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

test("trimming a resumed session keeps Pi's provider context byte-identical", async () => {
	const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { trimSessionBeforeCompaction } = await import("../src/agent/session-trim.ts");
	const dir = mkdtempSync(join(tmpdir(), "tg-trim-"));
	try {
		const manager = SessionManager.create(dir, dir);
		manager.appendModelChange("p", "m");
		manager.appendThinkingLevelChange("high");
		const ids = Array.from({ length: 6 }, (_, i) =>
			manager.appendMessage({ role: "user", content: `turn ${i}`, timestamp: i }),
		);
		manager.appendCompaction("summary", ids[3]!, 1000);
		manager.appendMessage({ role: "user", content: "after", timestamp: 9 });
		const file = manager.getSessionFile()!;
		const before = JSON.stringify(SessionManager.open(file, dir, dir).buildSessionContext());
		expect(trimSessionBeforeCompaction(file, dir, dir)).toBe(true);
		expect(JSON.stringify(SessionManager.open(file, dir, dir).buildSessionContext())).toBe(before);
		expect(trimSessionBeforeCompaction(file, dir, dir)).toBe(false);
		expect(readdirSync(dir).filter((name) => name.includes(".pre-trim-"))).toHaveLength(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("view_image results persist only references, project images byte-stably, and count everywhere", async () => {
	const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { contextImageBytes, projectTelegramContext } = await import("../src/agent/extensions/index.ts");
	const { createContextImageResolver } = await import("../src/media/context-media.ts");
	const { contextStateFromEntries } = await import("../src/agent/context-state.ts");
	const dir = mkdtempSync(join(tmpdir(), "tg-view-image-"));
	try {
		writeFileSync(join(dir, "abc#ctx.jpg"), Buffer.alloc(1234, 7));
		const manager = SessionManager.inMemory(dir);
		manager.appendMessage({
			role: "toolResult",
			toolName: "view_image",
			toolCallId: "call-1",
			content: [{ type: "text", text: "[12:00:00] #42 Alice (@alice): look [图片]\n[attached 1 image(s) of #42]" }],
			details: { messageId: 42, images: [{ name: "abc#ctx.jpg", mime: "image/jpeg" }] },
			isError: false,
			timestamp: 1,
		});
		const entries = manager.buildContextEntries();
		// Persisted bytes never contain image data.
		expect(JSON.stringify(entries)).not.toContain('"data":');
		const resolve = createContextImageResolver(dir);
		const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
		const first = JSON.stringify(projectTelegramContext(messages, resolve));
		const second = JSON.stringify(projectTelegramContext(messages, resolve));
		expect(first).toBe(second);
		expect(first).toContain('"type":"image"');
		expect(contextImageBytes(entries, dir)).toBe(1234);
		expect(contextStateFromEntries(entries).visible.has(42)).toBe(true);
		// Without a resolver (text-only model) the result stays text.
		expect(JSON.stringify(projectTelegramContext(messages))).not.toContain('"type":"image"');
		// The retention budget charges the viewed image like a batch image.
		expect(compactionTextBudget(entries, 1000)).toBeLessThan(1000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
