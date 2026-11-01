// tg_messages is a read-only view of the configured group only: control commands and other chats
// never leak, paging is gapless, and filters cannot be turned into SQL wildcards.

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { queryMessages } from "../src/tools/messages.ts";

const CHAT = -1001;

function db(): Database {
	const d = new Database(":memory:");
	d.exec(readFileSync("src/db/schema.sql", "utf8"));
	const insert = d.query(
		`INSERT INTO messages (chat_id, message_id, date, sender_id, display_name, username, is_bot, text, first_seen_by)
		 VALUES (?, ?, ?, ?, 'Alice', ?, 0, ?, 'A')`,
	);
	for (let id = 1; id <= 25; id++) insert.run(CHAT, id, 1_754_600_000 + id, 7, "alice", `hello ${id}`);
	insert.run(CHAT, 26, 1_754_600_026, 7, "alice", "/compact");
	insert.run(CHAT, 27, 1_754_600_027, 8, null, "100% sure");
	insert.run(-2002, 28, 1_754_600_028, 7, "alice", "other chat hello");
	d.query("INSERT INTO telegram_control_messages (chat_id, message_id) VALUES (?, 26)").run(CHAT);
	return d;
}

test("tg_messages never returns control messages or other chats", () => {
	const ids = queryMessages(db(), CHAT, { limit: 500 }).rows.map((row) => row.id);
	expect(ids).not.toContain(26);
	expect(ids).not.toContain(28);
	expect(ids).toHaveLength(26);
});

test("tg_messages pages without gaps and escapes LIKE wildcards", () => {
	const d = db();
	const seen: number[] = [];
	let before: number | undefined;
	for (;;) {
		const page = queryMessages(d, CHAT, { text_contains: "hello", limit: 10, before_id: before });
		seen.push(...page.rows.map((row) => row.id));
		if (page.next_before_id === null) break;
		before = page.next_before_id;
	}
	expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => 25 - i));
	expect(queryMessages(d, CHAT, { text_contains: "%" }).rows.map((row) => row.id)).toEqual([27]);
	expect(queryMessages(d, CHAT, { text_contains: "_" }).rows).toHaveLength(0);
});

test("attachments render with their sanitized file name, size and length", async () => {
	const { normalizeMessage } = await import("../src/telegram/normalize.ts");
	const { serializeMessageEvents } = await import("../src/agent/serialize.ts");
	const d = db();
	const row = normalizeMessage({
		message_id: 90,
		date: 1_754_600_090,
		chat: { id: CHAT },
		from: { id: 7, first_name: "Alice", username: "alice" },
		document: { file_id: "f", file_unique_id: "u", file_name: 'report\n"final".pdf', file_size: 1_258_291 },
	});
	expect(row.media?.file_name).toBe('report "final".pdf');
	const voice = normalizeMessage({
		message_id: 91,
		date: 1_754_600_091,
		chat: { id: CHAT },
		from: { id: 7, first_name: "Alice", username: "alice" },
		voice: { file_id: "v", file_unique_id: "w", duration: 12 },
	});
	const text = serializeMessageEvents(
		d,
		[row, voice].map((message, i) => ({
			ingestSeq: i + 1,
			chatId: CHAT,
			messageId: message.message_id,
			revision: 0,
			kind: "message" as const,
			eventDate: message.date,
			payload: { ...message, media: JSON.stringify(message.media) } as never,
		})),
		{ visibleIds: new Set() },
	);
	expect(text).toContain(`[document "report 'final'.pdf" 1.2 MB]`);
	expect(text).toContain("[voice 12s]");
});

test("the full-text index finds CJK substrings, ranks by relevance and backfills old databases", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { openDb } = await import("../src/db/db.ts");
	const d = db();
	const insert = d.query(
		`INSERT INTO messages (chat_id, message_id, date, sender_id, display_name, username, is_bot, text, first_seen_by)
		 VALUES (?, ?, ?, 7, 'Alice', 'alice', 0, ?, 'A')`,
	);
	insert.run(CHAT, 100, 1_754_600_100, "周末去吃海底捞火锅店吧");
	insert.run(CHAT, 101, 1_754_600_101, "火锅店火锅店，还是火锅店");
	insert.run(CHAT, 102, 1_754_600_102, "/compact 火锅店");
	d.query("INSERT INTO telegram_control_messages (chat_id, message_id) VALUES (?, 102)").run(CHAT);
	expect(queryMessages(d, CHAT, { text_contains: "火锅店" }).rows.map((row) => row.id)).toEqual([101, 100]);
	expect(queryMessages(d, CHAT, { text_contains: "火锅店", order: "relevance" }).rows[0]!.id).toBe(101);
	expect(queryMessages(d, CHAT, { text_contains: "火锅" }).rows.map((row) => row.id)).toEqual([101, 100]);
	d.query("UPDATE messages SET text = '改成别的了' WHERE chat_id = ? AND message_id = 100").run(CHAT);
	expect(queryMessages(d, CHAT, { text_contains: "火锅店" }).rows.map((row) => row.id)).toEqual([101]);

	const dir = mkdtempSync(join(tmpdir(), "tg-fts-"));
	try {
		const path = join(dir, "agent.db");
		const first = openDb(path);
		first.exec("DROP TRIGGER messages_fts_insert");
		first.query("DELETE FROM daemon_state WHERE key = 'messages_fts_version'").run();
		first
			.query(
				`INSERT INTO messages (chat_id, message_id, date, is_bot, text, first_seen_by) VALUES (?, 1, 1, 0, '旧数据库里的消息', 'A')`,
			)
			.run(CHAT);
		first.close();
		const reopened = openDb(path);
		expect(queryMessages(reopened, CHAT, { text_contains: "数据库里" }).rows.map((row) => row.id)).toEqual([1]);
		reopened.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
