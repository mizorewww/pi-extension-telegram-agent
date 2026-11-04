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

export function openDb(dbPath: string): Database {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	assertCurrentSchema(db);
	return db;
}

/** Only the Telegram archive schema matters here; Pi owns runtime persistence. */
function assertCurrentSchema(db: Database): void {
	const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
	if (!columns.some((column) => column.name === "reply_snapshot")) {
		throw new Error("database predates the current Telegram archive schema");
	}
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

export function getBotState(db: Database, botId: string, key: string): string | null {
	const row = db.prepare("SELECT value FROM bot_state WHERE bot_id = ? AND key = ?").get(botId, key) as
		| {
				value: string;
		  }
		| undefined;
	return row?.value ?? null;
}

export function setBotState(db: Database, botId: string, key: string, value: string): void {
	db.prepare(
		"INSERT INTO bot_state (bot_id, key, value) VALUES (?, ?, ?) ON CONFLICT(bot_id, key) DO UPDATE SET value = excluded.value",
	).run(botId, key, value);
}
