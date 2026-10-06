// Golden hashes lock the cache-visible protocol (docs/cache.md). A failure means the provider
// prefix changed: confirm it is intended, bump CACHE_SCHEMA_VERSION, then update GOLDEN.

import { expect, test } from "bun:test";

// bun test forces UTC; the daemon serializes in local time. Pin the deployment TZ first.
process.env.TZ = "Asia/Singapore";

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { serializeMessageEvents, type MessageRow } from "../src/agent/serialize.ts";
import {
	buildSystemPrompt,
	sha256Short,
	CACHE_SCHEMA_VERSION,
	COMPACTION_SUMMARY_PROMPT,
	TELEGRAM_TURN_PROMPT,
	REPLY_RECOVERY_PROMPT,
	SHARED_PROTOCOL,
	TOOL_CAPABILITY_DECLARATION,
} from "../src/agent/prompt.ts";
import { TOOL_DEFS, toolProtocolHash } from "../src/agent/tools.ts";
import { recentContextStickerCandidates, stickerCatalogPromptBlock } from "../src/media/sticker-catalog.ts";
import {
	NO_SEND_MARKER,
	buildCompactionContent,
	projectTelegramContext,
	serializeCompactionMessages,
	TELEGRAM_CONTEXT_TYPE,
	TELEGRAM_CONTEXT_VERSION,
	TELEGRAM_EXTENSION_ORDER,
} from "../src/agent/extensions/index.ts";

const GOLDEN = {
	schemaVersion: 25,
	systemZhTemplate: "929f455372f8",
	systemEnTemplate: "e3368b9e6674",
	eventSerialize: "a05c0584eb08",
	tools: "d627213eee54",
	compactionPrompt: "04da95f62da0",
	multimodalCompaction: "e2da2b8b68fa",
	replyRecovery: "4fc7e277e338",
	telegramTurn: "43bb809c775c",
	extensionOrder: "e04f7032d531",
	contextProtocol: "2e1c7762b239",
};

const CHAT_ID = -1004402809405;

function schemaDb(): Database {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	return db;
}

function contextMessage(id: number, providerText: string, stickerCandidates = "", blocks?: unknown[]) {
	return {
		role: "custom",
		customType: TELEGRAM_CONTEXT_TYPE,
		content: providerText,
		display: false,
		timestamp: id,
		details: {
			version: TELEGRAM_CONTEXT_VERSION,
			consumedSeq: id,
			providerText,
			blocks: blocks ?? [{ type: "text", text: providerText }],
			stickerCandidates,
			visibleMessageIds: [id],
			events: [],
		},
	};
}

test("prompt, tool and protocol hashes are stable", () => {
	expect(CACHE_SCHEMA_VERSION).toBe(GOLDEN.schemaVersion);
	expect(sha256Short(buildSystemPrompt(readFileSync("personas/template.zh.md", "utf8")))).toBe(GOLDEN.systemZhTemplate);
	expect(sha256Short(buildSystemPrompt(readFileSync("personas/template.en.md", "utf8")))).toBe(GOLDEN.systemEnTemplate);
	// A golden-only regen must not silently drop the capability declaration.
	expect(SHARED_PROTOCOL.includes(TOOL_CAPABILITY_DECLARATION)).toBe(true);
	expect(toolProtocolHash(TOOL_DEFS)).toBe(GOLDEN.tools);
	expect(sha256Short(COMPACTION_SUMMARY_PROMPT)).toBe(GOLDEN.compactionPrompt);
	expect(sha256Short(REPLY_RECOVERY_PROMPT)).toBe(GOLDEN.replyRecovery);
	expect(sha256Short(TELEGRAM_TURN_PROMPT)).toBe(GOLDEN.telegramTurn);
	expect(sha256Short(JSON.stringify(TELEGRAM_EXTENSION_ORDER))).toBe(GOLDEN.extensionOrder);
	expect(
		sha256Short(
			JSON.stringify({ type: TELEGRAM_CONTEXT_TYPE, version: TELEGRAM_CONTEXT_VERSION, noSend: NO_SEND_MARKER }),
		),
	).toBe(GOLDEN.contextProtocol);
});

test("immutable event serialization grammar is stable", () => {
	const row: MessageRow = {
		chat_id: CHAT_ID,
		message_id: 200,
		date: 1754612345,
		thread_id: null,
		sender_id: 111,
		display_name: "Alice",
		username: "alice",
		sender_tag: null,
		sender_chat: null,
		is_bot: 0,
		text: "original",
		caption: null,
		entities: null,
		rich_message: null,
		reply_to_message_id: null,
		reply_to_sender_id: null,
		quote: null,
		forward_origin: null,
		edit_date: null,
		media: null,
	};
	const event = (ingestSeq: number, kind: string, revision: number, eventDate: number, payload: unknown) =>
		({ ingestSeq, chatId: CHAT_ID, messageId: 200, revision, kind, eventDate, payload }) as never;
	const out = serializeMessageEvents(
		schemaDb(),
		[
			event(1, "message", 0, row.date, row),
			event(2, "edit", 1754612400, 1754612400, { ...row, text: "edited", edit_date: 1754612400 }),
			event(3, "metadata", 1, 1754612401, {
				...row,
				reply_to_message_id: 199,
				reply_to_sender_id: 222,
				reply_snapshot: JSON.stringify({
					display_name: "Bob",
					username: "bob",
					text: "An archived parent whose full text exceeds forty characters: keep this ending.",
					media: null,
				}),
				quote: JSON.stringify({
					text: "A selected quote exceeding the former sixty-character limit: retain the final words.",
				}),
			}),
			event(4, "media_update", 2, 1754612402, { file_unique_id: "u", media_kind: "photo", text: "a cat" }),
		],
		{ visibleIds: new Set() },
	);
	expect(sha256Short(out)).toBe(GOLDEN.eventSerialize);
});

test("summary input keeps image order but never sticker candidates or private reasoning", () => {
	const content = buildCompactionContent(
		[
			contextMessage(12, "photo #12", "must not enter summary", [
				{ type: "text", text: "photo #12" },
				{ type: "image", name: "fixture.png", mime: "image/png" },
			]),
		] as never,
		"previous summary",
		() => ({ type: "image", data: "Zml4dHVyZQ==", mimeType: "image/png" }),
	);
	expect(sha256Short(JSON.stringify(content))).toBe(GOLDEN.multimodalCompaction);
	// A summary that records the bot's guesses turns one misreading into a durable "fact".
	const messages = [
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "speculation-canary" },
				{ type: "toolCall", id: "c1", name: "send", arguments: { message: "public-reply" } },
			],
			timestamp: 1,
		},
	] as never;
	const text = serializeCompactionMessages(messages);
	expect(text).toContain("public-reply");
	expect(text).not.toContain("speculation-canary");
	expect(JSON.stringify(buildCompactionContent(messages, undefined, () => null))).not.toContain("speculation-canary");
});

test("sticker candidates ride a separate labelled message after only the last context batch", () => {
	const projected = projectTelegramContext([
		contextMessage(42, "older-batch", "stale-candidate"),
		contextMessage(43, "newest-batch", "newest-candidate"),
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "send",
			content: [{ type: "text", text: "ok" }],
			details: { sent: [100, 101] },
			isError: false,
			timestamp: 3,
		},
	] as never);
	// Glued to the chat text, the list read as if the last speaker had pasted it.
	expect(projected.map((message: any) => message.content)).toEqual([
		"older-batch",
		"newest-batch",
		"newest-candidate",
		[{ type: "text", text: "ok sent_message_ids=#100,#101" }],
	]);
	expect(projected[2]).toMatchObject({ role: "custom", customType: "telegram_sticker_candidates" });
});

test("sticker catalog and candidate grammar only expose stickers this bot can send", () => {
	const db = schemaDb();
	const media = db.prepare(
		"INSERT INTO media (file_unique_id, kind, mime, sticker_set, sticker_emoji, vision, short_id) VALUES (?, 'sticker', 'image/webp', ?, ?, ?, ?)",
	);
	const vision = (text: string) => JSON.stringify({ model: "m", kind: "sticker", text, at: 1 });
	media.run("cat-1", "Mikufufu", "😺", vision("得意的赞同，smug/amused"), "s1");
	media.run("cat-2", "Mikufufu", "🐱", null, "s2");
	media.run("cat-b", "Mikufufu", "🅱️", vision("另一个 bot 的映射"), "s3");
	media.run("user-1", null, "😺", vision("emotion-1"), "s4");
	media.run("user-b", null, "🅱️", vision("B only"), "s5");
	const map = db.prepare("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES (?, ?, ?)");
	for (const [bot, file] of [
		["A", "cat-1"],
		["A", "cat-2"],
		["B", "cat-b"],
		["A", "user-1"],
		["B", "user-b"],
	])
		map.run(bot, `fid-${file}`, file);
	const message = db.prepare(
		"INSERT INTO messages (chat_id, message_id, date, sender_id, display_name, is_bot, media, first_seen_by) VALUES (?, ?, ?, ?, 'u', 0, ?, 'A')",
	);
	for (const [id, file] of [
		[1, "user-1"],
		[2, "user-b"],
	] as const)
		message.run(
			CHAT_ID,
			id,
			100 + id,
			id,
			JSON.stringify({ kind: "sticker", file_unique_id: file, sticker_emoji: "😺" }),
		);

	expect(stickerCatalogPromptBlock(db, "A", ["Mikufufu"])).toBe(
		"# Sticker 目录\n\ns1: 😺 得意的赞同，smug/amused\ns2: 🐱",
	);
	expect(stickerCatalogPromptBlock(db, "B", ["Mikufufu"])).toBe("# Sticker 目录\n\ns3: 🅱️ 另一个 bot 的映射");
	expect(recentContextStickerCandidates(db, "A", CHAT_ID, 1, [1, 2])).toBe(
		"〔系统附注〕近期群里出现过、你也能发送的 sticker：\ns4: 😺 emotion-1",
	);
});
