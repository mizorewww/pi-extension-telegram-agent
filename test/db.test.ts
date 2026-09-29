import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.ts";
import { ingestUpdate } from "../src/telegram/ingest.ts";

const cleanup = new Set<string>();

afterEach(() => {
	for (const path of cleanup) {
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				unlinkSync(`${path}${suffix}`);
			} catch {}
		}
	}
	cleanup.clear();
});

describe("database migrations", () => {
	test("reply snapshots upgrade old triggers without rewriting existing events", () => {
		const path = join(tmpdir(), `tg-reply-migration-${process.pid}-${Date.now()}.db`);
		cleanup.add(path);
		const legacy = openDb(path);
		legacy.exec(`DROP TRIGGER trg_messages_event_insert;
			DROP TRIGGER trg_messages_event_edit;
			DROP TRIGGER trg_messages_event_metadata;
			ALTER TABLE messages DROP COLUMN reply_snapshot;
			INSERT INTO messages (chat_id, message_id, date, text, first_seen_by) VALUES (-1, 1, 1, 'old', 'A');
			INSERT INTO message_events (event_key, chat_id, message_id, revision, kind, event_date, payload_json)
			VALUES ('message:-1:1', -1, 1, 0, 'message', 1, '{"text":"old"}');`);
		// Existing trigger names must be replaced, not skipped by CREATE IF NOT EXISTS.
		for (const name of ["insert", "edit", "metadata"]) {
			legacy.exec(`CREATE TRIGGER trg_messages_event_${name} AFTER INSERT ON messages BEGIN SELECT 1; END;`);
		}
		const history = legacy.query("SELECT * FROM message_events").get();
		legacy.close();
		for (let pass = 0; pass < 2; pass++) {
			const db = openDb(path);
			try {
				expect(db.query("SELECT * FROM message_events WHERE message_id = 1").get()).toEqual(history);
				const message = {
					chat: { id: -1 },
					message_id: pass + 2,
					date: 10,
					from: { id: 42, first_name: "Human" },
					text: "question",
					reply_to_message: { message_id: 99, from: { id: 42 }, text: "archived body" },
				};
				ingestUpdate(db, "A", { update_id: 10 + pass * 3, message }, -1, false);
				ingestUpdate(
					db,
					"A",
					{ update_id: 11 + pass * 3, edited_message: { ...message, text: "edited", edit_date: 20 } },
					-1,
					false,
				);
				db.query("UPDATE messages SET reply_snapshot = ? WHERE message_id = 1").run(JSON.stringify({ text: "filled" }));
				const events = db
					.query(
						"SELECT kind, json_extract(payload_json, '$.reply_snapshot') snapshot FROM message_events WHERE message_id = ? ORDER BY ingest_seq",
					)
					.all(message.message_id) as { kind: string; snapshot: string }[];
				expect(events.map((event) => event.kind)).toEqual(["message", "edit"]);
				for (const event of events) expect(JSON.parse(event.snapshot).text).toBe("archived body");
				expect(
					db
						.query(
							"SELECT json_extract(payload_json, '$.reply_snapshot') snapshot FROM message_events WHERE kind = 'metadata'",
						)
						.all(),
				).toEqual([{ snapshot: '{"text":"filled"}' }]);
			} finally {
				db.close();
			}
		}
	});

	test("REQ-UI-0009 adds cache_write once and preserves legacy telemetry", () => {
		const path = join(tmpdir(), `tg-legacy-telemetry-${process.pid}-${Date.now()}.db`);
		cleanup.add(path);
		const legacy = new Database(path, { create: true });
		legacy.exec(`CREATE TABLE llm_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			bot_id TEXT NOT NULL,
			ts INTEGER NOT NULL,
			model TEXT NOT NULL,
			epoch INTEGER NOT NULL,
			context_tokens INTEGER,
			cache_read INTEGER,
			cache_miss INTEGER,
			output_tokens INTEGER,
			reasoning_tokens INTEGER,
			latency_ms INTEGER,
			cost REAL,
			compaction INTEGER NOT NULL DEFAULT 0,
			system_hash TEXT,
			tools_hash TEXT,
			messages_hash TEXT
		)`);
		legacy
			.query(
				"INSERT INTO llm_runs (bot_id, ts, model, epoch, context_tokens, cache_read, cache_miss, output_tokens, cost) VALUES ('A', 1, 'm', 1, 100, 80, 20, 5, 0.01)",
			)
			.run();
		legacy.close();

		for (let pass = 0; pass < 2; pass++) {
			const db = openDb(path);
			const columns = db.query("PRAGMA table_info(llm_runs)").all() as { name: string }[];
			expect(columns.filter((column) => column.name === "cache_write")).toHaveLength(1);
			expect(db.query("SELECT cache_read, cache_write, cache_miss FROM llm_runs WHERE id = 1").get()).toEqual({
				cache_read: 80,
				cache_write: 0,
				cache_miss: 20,
			});
			db.close();
		}
	});
});

test("migrates control identity once and preserves it after audit retention", () => {
	const path = join(tmpdir(), `tg-control-migration-${process.pid}-${Date.now()}.db`);
	cleanup.add(path);
	const legacy = new Database(path);
	legacy.exec(
		`CREATE TABLE agent_events (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)`,
	);
	legacy
		.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('A', 1, 'telegram_control_claim', ?)")
		.run(JSON.stringify({ chat_id: -100123, message_id: 88 }));
	legacy.close();
	for (let pass = 0; pass < 2; pass++) {
		const db = openDb(path);
		expect(db.query("SELECT * FROM telegram_control_messages").all()).toEqual([{ chat_id: -100123, message_id: 88 }]);
		db.exec("DELETE FROM agent_events");
		db.close();
	}
});
