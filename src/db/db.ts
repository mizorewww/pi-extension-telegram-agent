// SQLite access layer (bun:sqlite). See docs/data-model.md.

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SCHEMA_PATH = join(import.meta.dir, "schema.sql");

export function openDb(dbPath: string): Database {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath, { create: true });
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	migrate(db);
	return db;
}

/** Idempotent column migrations for existing dev databases. */
function migrate(db: Database): void {
	const messageCols = (db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
	if (!messageCols.includes("rich_message")) {
		db.exec("ALTER TABLE messages ADD COLUMN rich_message TEXT");
	}
	if (!messageCols.includes("reply_to_sender_id")) {
		db.exec("ALTER TABLE messages ADD COLUMN reply_to_sender_id INTEGER");
	}
	const revisionCols = (db.query("PRAGMA table_info(message_revisions)").all() as { name: string }[]).map(
		(c) => c.name,
	);
	if (!revisionCols.includes("rich_message")) {
		db.exec("ALTER TABLE message_revisions ADD COLUMN rich_message TEXT");
	}
	const mediaCols = (db.query("PRAGMA table_info(media)").all() as { name: string }[]).map((c) => c.name);
	if (!mediaCols.includes("short_id")) {
		db.exec("ALTER TABLE media ADD COLUMN short_id TEXT");
		db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_media_short_id ON media(short_id)");
	}
	// v16: context-media mode derives per-identity images/frames into context_files alongside
	// the existing vision-mode description column. Migration is additive only.
	if (!mediaCols.includes("context_files")) {
		db.exec("ALTER TABLE media ADD COLUMN context_files TEXT");
	}
	const runCols = (db.query("PRAGMA table_info(llm_runs)").all() as { name: string }[]).map((c) => c.name);
	if (!runCols.includes("cache_write")) {
		db.exec("ALTER TABLE llm_runs ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0");
	}
	const runMigrations: ReadonlyArray<readonly [string, string]> = [
		["cache_read_estimated", "INTEGER"],
		["provider", "TEXT"],
		["api", "TEXT"],
		["session_id_hash", "TEXT"],
		["cache_retention", "TEXT"],
		["full_payload_hash", "TEXT"],
		["first_divergent_segment", "TEXT"],
		["first_divergent_message_index", "INTEGER"],
		["first_divergent_byte_offset", "INTEGER"],
		["trigger_message_id", "INTEGER"],
		["public_send_count", "INTEGER NOT NULL DEFAULT 0"],
		["vision_calls", "INTEGER NOT NULL DEFAULT 0"],
		["images_attached", "INTEGER NOT NULL DEFAULT 0"],
		["tool_followup_rounds", "INTEGER NOT NULL DEFAULT 0"],
		["input_events", "INTEGER NOT NULL DEFAULT 0"],
		["input_tokens_estimated", "INTEGER NOT NULL DEFAULT 0"],
		["rows_scanned", "INTEGER NOT NULL DEFAULT 0"],
		["system_tokens", "INTEGER NOT NULL DEFAULT 0"],
		["tools_tokens", "INTEGER NOT NULL DEFAULT 0"],
		["compacted_history_tokens", "INTEGER NOT NULL DEFAULT 0"],
		["message_tokens", "INTEGER NOT NULL DEFAULT 0"],
		["thinking_ms", "INTEGER NOT NULL DEFAULT 0"],
		["send_ms", "INTEGER NOT NULL DEFAULT 0"],
		["send_samples", "INTEGER NOT NULL DEFAULT 0"],
	];
	for (const [column, sqlType] of runMigrations) {
		if (!runCols.includes(column)) {
			db.exec(`ALTER TABLE llm_runs ADD COLUMN ${column} ${sqlType}`);
		}
	}
	db.transaction(() => {
		if (getDaemonState(db, "control_identity_migrated") === "1") return;
		db.exec(`INSERT OR IGNORE INTO telegram_control_messages (chat_id, message_id)
            SELECT json_extract(payload, '$.chat_id'), json_extract(payload, '$.message_id') FROM agent_events
            WHERE kind IN ('telegram_control_claim', 'telegram_control_reply')
              AND json_type(payload, '$.chat_id') = 'integer' AND json_type(payload, '$.message_id') = 'integer'`);
		setDaemonState(db, "control_identity_migrated", "1");
	})();
	backfillMessageEvents(db);
}

const MESSAGE_EVENT_BACKFILL_KEY = "message_events_backfill_max_seq";

function messagePayloadSql(prefix: "NEW" | "m"): string {
	return `json_object(
		'chat_id', ${prefix}.chat_id,
		'message_id', ${prefix}.message_id,
		'date', ${prefix}.date,
		'thread_id', ${prefix}.thread_id,
		'sender_id', ${prefix}.sender_id,
		'display_name', ${prefix}.display_name,
		'username', ${prefix}.username,
		'sender_tag', ${prefix}.sender_tag,
		'sender_chat', ${prefix}.sender_chat,
		'is_bot', ${prefix}.is_bot,
		'text', ${prefix}.text,
		'caption', ${prefix}.caption,
		'entities', ${prefix}.entities,
		'rich_message', ${prefix}.rich_message,
		'reply_to_message_id', ${prefix}.reply_to_message_id,
		'reply_to_sender_id', ${prefix}.reply_to_sender_id,
		'quote', ${prefix}.quote,
		'forward_origin', ${prefix}.forward_origin,
		'edit_date', ${prefix}.edit_date,
		'media', ${prefix}.media
	)`;
}

/** One-time immutable baseline for databases created before message_events existed. */
function backfillMessageEvents(db: Database): void {
	const marker = db.query("SELECT value FROM daemon_state WHERE key = ?").get(MESSAGE_EVENT_BACKFILL_KEY) as {
		value: string;
	} | null;
	if (marker) return;
	const migrateBaseline = db.transaction(() => {
		db.exec(`
			INSERT OR IGNORE INTO message_events
				(event_key, chat_id, message_id, revision, kind, event_date, payload_json)
			SELECT 'message:' || m.chat_id || ':' || m.message_id,
			       m.chat_id, m.message_id, 0, 'message', m.date, ${messagePayloadSql("m")}
			  FROM messages m
			 ORDER BY m.date, m.message_id
		`);
		const row = db.query("SELECT COALESCE(MAX(ingest_seq), 0) AS seq FROM message_events").get() as { seq: number };
		const botIds = db
			.query(`
			SELECT bot_id FROM bot_state
			UNION SELECT bot_id FROM raw_updates
			UNION SELECT bot_id FROM agent_events
			UNION SELECT bot_id FROM llm_runs
		`)
			.all() as { bot_id: string }[];
		const insertCursor = db.query(
			"INSERT OR IGNORE INTO bot_cursors (bot_id, chat_id, consumed_seq, updated_at) VALUES (?, ?, ?, ?)",
		);
		const chatIds = db.query("SELECT DISTINCT chat_id FROM messages").all() as { chat_id: number }[];
		for (const bot of botIds) {
			for (const chat of chatIds) insertCursor.run(bot.bot_id, chat.chat_id, row.seq, Date.now());
		}
		db.query("INSERT INTO daemon_state (key, value) VALUES (?, ?)").run(MESSAGE_EVENT_BACKFILL_KEY, String(row.seq));
	});
	migrateBaseline();
}

export function getDaemonState(db: Database, key: string): string | null {
	const row = db.query("SELECT value FROM daemon_state WHERE key = ?").get(key) as { value: string } | null;
	return row?.value ?? null;
}

export function setDaemonState(db: Database, key: string, value: string): void {
	db.query(
		"INSERT INTO daemon_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(key, value);
}

export function getBotState(db: Database, botId: string, key: string): string | null {
	const row = db.query("SELECT value FROM bot_state WHERE bot_id = ? AND key = ?").get(botId, key) as {
		value: string;
	} | null;
	return row?.value ?? null;
}

export function setBotState(db: Database, botId: string, key: string, value: string): void {
	db.query(
		"INSERT INTO bot_state (bot_id, key, value) VALUES (?, ?, ?) ON CONFLICT(bot_id, key) DO UPDATE SET value = excluded.value",
	).run(botId, key, value);
}
