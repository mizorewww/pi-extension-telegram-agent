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
	assertCurrentSchema(db);
	foldTaskUsage(db);
	return db;
}

/** One-time: databases from before the tasks usage counters get them, summed from task_usage. */
function foldTaskUsage(db: Database): void {
	const columns = new Set((db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
	if (columns.has("cost")) return;
	db.transaction(() => {
		db.exec(`ALTER TABLE tasks ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE tasks ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE tasks ADD COLUMN cost REAL NOT NULL DEFAULT 0;`);
		if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_usage'").get()) {
			db.exec(`UPDATE tasks SET
				input_tokens = (SELECT COALESCE(SUM(u.input_tokens + u.cache_read + u.cache_write), 0) FROM task_usage u WHERE u.task_id = tasks.task_id),
				output_tokens = (SELECT COALESCE(SUM(u.output_tokens), 0) FROM task_usage u WHERE u.task_id = tasks.task_id),
				cost = (SELECT COALESCE(SUM(u.cost), 0) FROM task_usage u WHERE u.task_id = tasks.task_id);
				DROP TABLE task_usage;`);
		}
	})();
}

/** Databases created before the current schema are not migrated; fail before touching them. */
function assertCurrentSchema(db: Database): void {
	const columns = (table: string) =>
		new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
	if (!columns("messages").has("reply_snapshot") || !columns("llm_runs").has("send_samples")) {
		throw new Error("database predates the current schema; move data/agent.db aside to start fresh");
	}
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
