// SQLite access layer (node:sqlite).

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync as Database } from "node:sqlite";

export { DatabaseSync as Database } from "node:sqlite";

export function transaction<T>(db: Database, action: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = action();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

const SCHEMA_PATH = join(import.meta.dirname, "schema.sql");

/** `botUserId` is the configured bot's Telegram id; a v1.0 multi-bot archive keeps only its rows. */
export function openDb(dbPath: string, botUserId?: number): Database {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL;");
	if (hasColumn(db, "raw_updates", "bot_id")) {
		if (botUserId == null) throw new Error("database holds the multi-bot archive; start the daemon once to migrate it");
		migrateToSingleBot(db, botUserId);
	}
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	if (!hasColumn(db, "messages", "reply_snapshot"))
		throw new Error("database predates the current Telegram archive schema");
	return db;
}

function hasColumn(db: Database, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(({ name }) => name === column);
}

/** One-shot v1.0 -> v1.1 move: per-bot tables collapse onto the bot this deployment now runs. */
function migrateToSingleBot(db: Database, botUserId: number): void {
	const owner = db
		.prepare("SELECT bot_id FROM bot_state WHERE key = 'bot_user_id' AND value = ?")
		.get(String(botUserId)) as { bot_id: string } | undefined;
	const bot = owner?.bot_id ?? null;
	// node:sqlite enforces foreign keys by default; the tables are rebuilt in dependency order.
	db.exec("PRAGMA foreign_keys = OFF;");
	transaction(db, () => {
		db.exec(`
			CREATE TABLE raw_updates_v2 (update_id INTEGER PRIMARY KEY, received_at INTEGER NOT NULL, json TEXT NOT NULL);
			CREATE TABLE pending_telegram_dispatch_v2 (
				update_id INTEGER PRIMARY KEY REFERENCES raw_updates(update_id),
				kind TEXT NOT NULL CHECK (kind IN ('inserted', 'edited', 'enriched')),
				chat_id INTEGER NOT NULL,
				message_id INTEGER NOT NULL
			);
			CREATE TABLE media_file_ids_v2 (file_id TEXT PRIMARY KEY, file_unique_id TEXT NOT NULL);
		`);
		for (const sql of [
			"INSERT INTO raw_updates_v2 SELECT update_id, received_at, json FROM raw_updates WHERE bot_id = ?",
			"INSERT INTO pending_telegram_dispatch_v2 SELECT update_id, kind, chat_id, message_id FROM pending_telegram_dispatch WHERE bot_id = ?",
			"INSERT OR IGNORE INTO media_file_ids_v2 SELECT file_id, file_unique_id FROM media_file_ids WHERE bot_id = ?",
			"INSERT OR REPLACE INTO daemon_state (key, value) SELECT key, value FROM bot_state WHERE bot_id = ?",
			"INSERT OR REPLACE INTO daemon_state (key, value) SELECT 'box_reset_at', value FROM daemon_state WHERE key = 'box_reset_at:' || ?",
		])
			db.prepare(sql).run(bot);
		db.exec(`
			DELETE FROM daemon_state WHERE key = 'router_secret' OR key LIKE 'box_reset_at:%';
			DROP TABLE pending_telegram_dispatch;
			DROP TABLE raw_updates;
			DROP TABLE media_file_ids;
			DROP TABLE bot_state;
			DROP TABLE IF EXISTS routing_claims;
			ALTER TABLE raw_updates_v2 RENAME TO raw_updates;
			ALTER TABLE pending_telegram_dispatch_v2 RENAME TO pending_telegram_dispatch;
			ALTER TABLE media_file_ids_v2 RENAME TO media_file_ids;
			ALTER TABLE messages DROP COLUMN first_seen_by;
		`);
	});
}

export function getDaemonState(db: Database, key: string): string | null {
	const row = db.prepare("SELECT value FROM daemon_state WHERE key = ?").get(key) as { value: string } | undefined;
	return row?.value ?? null;
}

export function setDaemonState(db: Database, key: string, value: string): void {
	db.prepare(
		"INSERT INTO daemon_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(key, value);
}
