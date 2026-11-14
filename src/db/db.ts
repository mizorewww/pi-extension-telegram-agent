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

export function openDb(dbPath: string, _botUserId?: number): Database {
	if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath, { timeout: 5_000 });
	db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 1000;");
	if (hasColumn(db, "raw_updates", "bot_id")) throw new Error("database holds the obsolete v1.0 multi-bot archive");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	if (!hasColumn(db, "messages", "reply_snapshot"))
		throw new Error("database predates the current Telegram archive schema");
	return db;
}

function hasColumn(db: Database, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(({ name }) => name === column);
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
