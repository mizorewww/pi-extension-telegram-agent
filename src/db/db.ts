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
	return db;
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
