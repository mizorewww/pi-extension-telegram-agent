// Cache regression test: golden hashes lock the cache-visible protocol (docs/cache.md).
// If any of these fail, a change altered the provider-visible prefix:
// - system prompt (persona + protocol block)          => bump CACHE_SCHEMA_VERSION, new epoch
// - tool name/description/parameter schema + order    => same
// - message serialization grammar                     => same
// UI-only changes must NOT affect these hashes.

import { expect, test } from "bun:test";

// bun test forces UTC; the daemon serializes in local time. Pin the deployment TZ
// before anything calls Date so the golden hash matches production behavior.
process.env.TZ = "Asia/Singapore";

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { serializeMessageEvents, serializeMessages, type MessageRow } from "../src/agent/serialize.ts";
import {
	buildSystemPrompt,
	sha256Short,
	CACHE_SCHEMA_VERSION,
	COMPACTION_SUMMARY_PROMPT,
	SHARED_PROTOCOL,
	TOOL_CAPABILITY_DECLARATION,
} from "../src/agent/prompt.ts";
import { toolsHash } from "../src/agent/tools.ts";
import {
	appendStickerCandidateSuffix,
	recentContextStickerCandidates,
	stickerCatalogPromptBlock,
} from "../src/media/sticker-catalog.ts";
import {
	NO_SEND_MARKER,
	serializeCompactionMessages,
	TELEGRAM_CONTEXT_TYPE,
	TELEGRAM_CONTEXT_VERSION,
	TELEGRAM_EXTENSION_ORDER,
} from "../src/agent/extensions/index.ts";

const GOLDEN = {
	schemaVersion: 15,
	systemZhTemplate: "3879a9204276",
	systemEnTemplate: "dd8b0d03cef0",
	serialize: "68a17d6e5c05",
	eventSerialize: "4a57de738bf9",
	tools: "b16b54cf6564",
	compactionPrompt: "045a5241fdd7",
	extensionOrder: "e04f7032d531",
	contextProtocol: "c810cd1e5ab3",
};

test("CACHE_SCHEMA_VERSION unchanged", () => {
	expect(CACHE_SCHEMA_VERSION).toBe(GOLDEN.schemaVersion);
});

test("system prompts stable (persona + protocol)", () => {
	const a = buildSystemPrompt(readFileSync("personas/template.zh.md", "utf8"));
	const b = buildSystemPrompt(readFileSync("personas/template.en.md", "utf8"));
	expect(sha256Short(a)).toBe(GOLDEN.systemZhTemplate);
	expect(sha256Short(b)).toBe(GOLDEN.systemEnTemplate);
});

test("shared protocol declares available tools (semantic lock)", () => {
	// Guard against the capability declaration being deleted: a golden-only regen would
	// otherwise mask the regression, so lock the declaration into the protocol directly.
	expect(SHARED_PROTOCOL.includes(TOOL_CAPABILITY_DECLARATION)).toBe(true);
});

test("message serialization grammar stable", () => {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const ins = db.prepare(
		`INSERT INTO messages (chat_id, message_id, date, thread_id, sender_id, display_name, username, sender_tag, sender_chat, is_bot, text, caption, entities, reply_to_message_id, quote, forward_origin, edit_date, media, first_seen_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	);
	ins.run(
		-1004402809405,
		100,
		1754612345,
		null,
		111,
		"Alice",
		"alice",
		null,
		null,
		0,
		"这个实现是不是有问题？",
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		"A",
	);
	ins.run(
		-1004402809405,
		101,
		1754612360,
		null,
		222,
		"Bob",
		null,
		null,
		null,
		0,
		"感觉是 API 抽风",
		null,
		null,
		100,
		null,
		null,
		null,
		null,
		"A",
	);
	ins.run(
		-1004402809405,
		102,
		1754612380,
		null,
		7776264871,
		"小雪",
		"hastuyuki_bot",
		null,
		null,
		1,
		"应该保持 append-only",
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		"A",
	);
	const rows = db.query("SELECT * FROM messages ORDER BY date").all() as MessageRow[];
	const out = serializeMessages(db, rows, { visibleIds: new Set([100]) });
	expect(sha256Short(out)).toBe(GOLDEN.serialize);
});

test("quote reference renders media placeholder and missing-parent marker (v14)", () => {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const ins = db.prepare(
		`INSERT INTO messages (chat_id, message_id, date, thread_id, sender_id, display_name, username, sender_tag, sender_chat, is_bot, text, caption, entities, reply_to_message_id, quote, forward_origin, edit_date, media, first_seen_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	);
	// parents: photo (with vision text), sticker, plain text
	ins.run(
		-1004402809405,
		300,
		1754612345,
		null,
		111,
		"Alice",
		"alice",
		null,
		null,
		0,
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		JSON.stringify({ kind: "photo", file_unique_id: "uq-photo-1" }),
		"A",
	);
	ins.run(
		-1004402809405,
		301,
		1754612346,
		null,
		111,
		"Alice",
		"alice",
		null,
		null,
		0,
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		JSON.stringify({ kind: "sticker", file_unique_id: "uq-sticker-1", sticker_emoji: "😺" }),
		"A",
	);
	ins.run(
		-1004402809405,
		302,
		1754612347,
		null,
		111,
		"Alice",
		"alice",
		null,
		null,
		0,
		"父消息文本",
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		"A",
	);
	// children replying to each parent
	ins.run(
		-1004402809405,
		310,
		1754612350,
		null,
		222,
		"Bob",
		null,
		null,
		null,
		0,
		"看这个",
		null,
		null,
		300,
		null,
		null,
		null,
		null,
		"A",
	);
	ins.run(
		-1004402809405,
		311,
		1754612351,
		null,
		222,
		"Bob",
		null,
		null,
		null,
		0,
		"还有这个",
		null,
		null,
		301,
		null,
		null,
		null,
		null,
		"A",
	);
	ins.run(
		-1004402809405,
		312,
		1754612352,
		null,
		222,
		"Bob",
		null,
		null,
		null,
		0,
		"这个看不到",
		null,
		null,
		999999,
		null,
		null,
		null,
		null,
		"A",
	);
	ins.run(
		-1004402809405,
		313,
		1754612353,
		null,
		222,
		"Bob",
		null,
		null,
		null,
		0,
		"可见的",
		null,
		null,
		302,
		null,
		null,
		null,
		null,
		"A",
	);
	// vision text for the photo parent (shared media identity cache)
	db.query("INSERT INTO media (file_unique_id, kind, mime, vision) VALUES (?, 'photo', 'image/jpeg', ?)").run(
		"uq-photo-1",
		JSON.stringify({ model: "m", kind: "photo", text: "一只猫", at: 1 }),
	);
	const serializeOne = (messageId: number, visible: Set<number>, resolveVision = true): string => {
		const row = db
			.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
			.get(-1004402809405, messageId) as MessageRow;
		return serializeMessages(db, [row], { visibleIds: visible, resolveVision });
	};
	// media parent not in the visible set: media placeholder (vision resolved on the fresh-batch path)
	expect(serializeOne(310, new Set())).toContain("#310 Bob (u1) ↪ #300 @alice [图片: 一只猫]: 看这个");
	expect(serializeOne(311, new Set())).toContain("#311 Bob (u1) ↪ #301 @alice [sticker 😺]: 还有这个");
	// event-log path: resolveVision false must not leak vision text
	expect(serializeOne(310, new Set(), false)).toContain("↪ #300 @alice [图片]: 看这个");
	expect(serializeOne(310, new Set(), false)).not.toContain("一只猫");
	// missing parent: explicit marker instead of a bare id the model would hallucinate around
	expect(serializeOne(312, new Set())).toContain("#312 Bob (u1) ↪ #999999 (原消息不可见): 这个看不到");
	// visible parent: still a bare ref, no snippet
	expect(serializeOne(313, new Set([302]))).toContain("#313 Bob (u1) ↪ #302: 可见的");
	expect(serializeOne(313, new Set([302]))).not.toContain("父消息文本");
});

test("immutable event and extension protocol grammar stable", () => {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const row: MessageRow = {
		chat_id: -1004402809405,
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
	const out = serializeMessageEvents(
		db,
		[
			{
				ingestSeq: 1,
				chatId: row.chat_id,
				messageId: 200,
				revision: 0,
				kind: "message",
				eventDate: row.date,
				payload: row,
			},
			{
				ingestSeq: 2,
				chatId: row.chat_id,
				messageId: 200,
				revision: 1754612400,
				kind: "edit",
				eventDate: 1754612400,
				payload: { ...row, text: "edited", edit_date: 1754612400 },
			},
			{
				ingestSeq: 3,
				chatId: row.chat_id,
				messageId: 200,
				revision: 1,
				kind: "metadata",
				eventDate: 1754612401,
				payload: { ...row, reply_to_message_id: 199, reply_to_sender_id: 222 },
			},
			{
				ingestSeq: 4,
				chatId: row.chat_id,
				messageId: 200,
				revision: 2,
				kind: "media_update",
				eventDate: 1754612402,
				payload: { file_unique_id: "u", media_kind: "photo", text: "a cat" },
			},
		],
		{ visibleIds: new Set() },
	);
	expect(sha256Short(out)).toBe(GOLDEN.eventSerialize);
	expect(sha256Short(JSON.stringify(TELEGRAM_EXTENSION_ORDER))).toBe(GOLDEN.extensionOrder);
	expect(
		sha256Short(
			JSON.stringify({
				type: TELEGRAM_CONTEXT_TYPE,
				version: TELEGRAM_CONTEXT_VERSION,
				noSend: NO_SEND_MARKER,
			}),
		),
	).toBe(GOLDEN.contextProtocol);
});

test("complete provider tool protocol + order stable (REQ-TEST-0001 R2)", () => {
	expect(toolsHash()).toBe(GOLDEN.tools);
});

test("compaction summary prompt grammar stable (REQ-TEST-0001 R2)", () => {
	expect(sha256Short(COMPACTION_SUMMARY_PROMPT)).toBe(GOLDEN.compactionPrompt);
});

test("compaction serializes custom Telegram messages through Pi", () => {
	const conversation = serializeCompactionMessages([
		{
			role: "custom",
			customType: TELEGRAM_CONTEXT_TYPE,
			content: "telegram context survives compaction",
			display: false,
			timestamp: 0,
		},
	]);
	expect(conversation).toContain("telegram context survives compaction");
});

test("sticker catalog prompt block grammar stable (identity + format, per-bot)", () => {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const ins = db.prepare(
		`INSERT INTO media (file_unique_id, kind, mime, sticker_set, sticker_emoji, vision, short_id) VALUES (?, 'sticker', ?, ?, ?, ?, ?)`,
	);
	ins.run(
		"uq-cat-1",
		"image/webp",
		"Mikufufu",
		"😺",
		JSON.stringify({ model: "m", kind: "sticker", text: "得意的赞同，smug/amused", at: 1 }),
		"s1",
	);
	ins.run("uq-cat-2", "application/x-tgsticker", "Mikufufu", "🐱", null, "s2");
	ins.run(
		"uq-cat-b-only",
		"video/webm",
		"Mikufufu",
		"🅱️",
		JSON.stringify({ model: "m", kind: "sticker", text: "另一个 bot 的映射", at: 1 }),
		"s3",
	);
	db.query(
		"INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', 'fid-1', 'uq-cat-1'), ('A', 'fid-2', 'uq-cat-2')",
	).run();
	db.query("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('B', 'fid-3', 'uq-cat-b-only')").run();
	const block = stickerCatalogPromptBlock(db, "A", ["Mikufufu"]);
	// identity-only grammar: set + emoji + short_id, no vision description text
	expect(block).toBe(`# Sticker 目录

你可以用 send 的 sticker 参数发送以下 sticker（填 short_id，不得编造其他 id）：

- [Mikufufu] [static] 😺 s1
- [Mikufufu] [animated] 🐱 s2`);
	expect(block).not.toContain("得意的赞同");
	// deterministic across calls and isolated from other bots' mappings
	expect(stickerCatalogPromptBlock(db, "A", ["Mikufufu"])).toBe(block);
	expect(stickerCatalogPromptBlock(db, "B", ["Mikufufu"])).toContain("🅱️ s3");
	expect(stickerCatalogPromptBlock(db, "B", ["Mikufufu"])).toContain("[video]");
	expect(stickerCatalogPromptBlock(db, "B", ["Mikufufu"])).not.toContain("s1");
});

test("recent visible user stickers form a bounded final suffix", () => {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const chatId = -1004402809405;
	const insertMedia = db.prepare(
		"INSERT INTO media (file_unique_id, kind, mime, sticker_emoji, vision) VALUES (?, 'sticker', ?, ?, ?)",
	);
	const insertMapping = db.prepare("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES (?, ?, ?)");
	const insertMessage = db.prepare(
		`INSERT INTO messages
			(chat_id, message_id, date, sender_id, display_name, is_bot, media, first_seen_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'A')`,
	);
	const insertVisible = db.prepare(
		"INSERT INTO bot_visible_messages (bot_id, chat_id, message_id, context_epoch) VALUES ('A', ?, ?, 1)",
	);

	for (let index = 1; index <= 10; index++) {
		const fileUniqueId = `user-sticker-${index}`;
		insertMedia.run(
			fileUniqueId,
			index === 10 ? "video/webm" : index === 9 ? "application/x-tgsticker" : "image/webp",
			"😺",
			JSON.stringify({ model: "m", kind: "sticker", text: `emotion-${index}`, at: 1 }),
		);
		insertMapping.run("A", `file-${index}`, fileUniqueId);
		insertMessage.run(
			chatId,
			index,
			100 + index,
			index,
			`user-${index}`,
			0,
			JSON.stringify({ kind: "sticker", file_unique_id: fileUniqueId, sticker_emoji: "😺" }),
		);
		if (index <= 5) insertVisible.run(chatId, index);
	}

	insertMedia.run(
		"bot-sticker",
		"image/webp",
		"🤖",
		JSON.stringify({ model: "m", kind: "sticker", text: "bot", at: 1 }),
	);
	insertMapping.run("A", "bot-file", "bot-sticker");
	insertMessage.run(
		chatId,
		11,
		111,
		999,
		"bot",
		1,
		JSON.stringify({ kind: "sticker", file_unique_id: "bot-sticker", sticker_emoji: "🤖" }),
	);
	insertMedia.run(
		"other-bot-only",
		"video/webm",
		"🅱️",
		JSON.stringify({ model: "m", kind: "sticker", text: "B only", at: 1 }),
	);
	insertMapping.run("B", "b-file", "other-bot-only");
	insertMessage.run(
		chatId,
		12,
		112,
		12,
		"user-12",
		0,
		JSON.stringify({ kind: "sticker", file_unique_id: "other-bot-only", sticker_emoji: "🅱️" }),
	);

	const block = recentContextStickerCandidates(db, "A", chatId, 1, [6, 7, 8, 9, 10, 11, 12]);
	expect(block).toBe(`Available stickers (recent context):
s10 [video] = 😺 emotion-10
s9 [animated] = 😺 emotion-9
s8 [static] = 😺 emotion-8
s7 [static] = 😺 emotion-7
s6 [static] = 😺 emotion-6
s5 [static] = 😺 emotion-5
s4 [static] = 😺 emotion-4
s3 [static] = 😺 emotion-3`);
	expect(block).not.toContain("bot");
	expect(block).not.toContain("B only");
	const providerText = appendStickerCandidateSuffix("serialized messages", block);
	expect(providerText).toBe(`serialized messages

${block}`);
	expect(providerText.endsWith(block)).toBe(true);
});
