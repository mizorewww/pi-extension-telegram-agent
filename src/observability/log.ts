import { openSync, closeSync, readSync, existsSync, statSync, renameSync, rmSync, chmodSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

export const LOG_SCHEMA_VERSION = 1;
const MAX_LOG_FIELDS = 24;
const MAX_LOG_STRING = 256;
const MAX_LOG_LINE_BYTES = 4096;

const SENSITIVE_KEY =
	/(?:^|_)(?:token|secret|password|authorization|cookie|api[_-]?key|prompt|content|body|response|query|url|path|stack|persona)(?:$|_)/i;
const TELEGRAM_TOKEN = /\b\d{5,}:[A-Za-z0-9_-]{10,}\b/g;
const PROVIDER_KEY = /\b(?:sk|tf)-[A-Za-z0-9_-]{8,}\b/gi;
const URL = /\bhttps?:\/\/[^\s]+/gi;
const ABSOLUTE_PATH = /(?:^|\s)(?:\/[A-Za-z0-9._-]+){2,}/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export interface LogRecord {
	schema: number;
	ts: string;
	level: LogLevel;
	component: string;
	event: string;
	fields?: Record<string, string | number | boolean | null>;
}

function safeName(input: string, fallback: string): string {
	const normalized = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "_")
		.slice(0, 64);
	return normalized || fallback;
}

function redactString(input: string): string {
	return input
		.replace(CONTROL, "")
		.replace(TELEGRAM_TOKEN, "[redacted-token]")
		.replace(PROVIDER_KEY, "[redacted-key]")
		.replace(URL, "[redacted-url]")
		.replace(ABSOLUTE_PATH, " [redacted-path]")
		.slice(0, MAX_LOG_STRING);
}

function safeScalar(key: string, value: unknown): string | number | boolean | null | undefined {
	if (SENSITIVE_KEY.test(key)) return "[redacted]";
	if (value == null) return null;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "string") return redactString(value);
	if (typeof value === "bigint") return value.toString().slice(0, MAX_LOG_STRING);
	if (value instanceof Error) return safeName(value.name, "error");
	return undefined;
}

function sanitizeLogFields(fields: LogFields = {}): Record<string, string | number | boolean | null> {
	const output: Record<string, string | number | boolean | null> = {};
	for (const [rawKey, value] of Object.entries(fields).slice(0, MAX_LOG_FIELDS)) {
		const key = safeName(rawKey, "field").slice(0, 48);
		const scalar = safeScalar(key, value);
		if (scalar !== undefined) output[key] = scalar;
	}
	return output;
}

function formatLogRecord(
	level: LogLevel,
	component: string,
	event: string,
	fields: LogFields = {},
	now = new Date(),
): string {
	const safeFields = sanitizeLogFields(fields);
	const record: LogRecord = {
		schema: LOG_SCHEMA_VERSION,
		ts: now.toISOString(),
		level,
		component: safeName(component, "unknown"),
		event: safeName(event, "unknown"),
		...(Object.keys(safeFields).length > 0 ? { fields: safeFields } : {}),
	};
	let line = JSON.stringify(record);
	if (Buffer.byteLength(line) > MAX_LOG_LINE_BYTES) {
		line = JSON.stringify({ ...record, fields: { truncated: true } });
	}
	return `${line}\n`;
}

export type LogSink = (line: string) => void;

let sink: LogSink = (line) => {
	process.stdout.write(line);
};

/** Test seam and foreground embedding hook. Production keeps the stdout JSONL sink. */
export function setLogSink(next: LogSink): () => void {
	const previous = sink;
	sink = next;
	return () => {
		sink = previous;
	};
}

export function writeLog(level: LogLevel, component: string, event: string, fields: LogFields = {}): void {
	try {
		sink(formatLogRecord(level, component, event, fields));
	} catch {
		// Observability must never change the business outcome.
	}
}

export const log = {
	debug: (component: string, event: string, fields?: LogFields) => writeLog("debug", component, event, fields),
	info: (component: string, event: string, fields?: LogFields) => writeLog("info", component, event, fields),
	warn: (component: string, event: string, fields?: LogFields) => writeLog("warn", component, event, fields),
	error: (component: string, event: string, fields?: LogFields) => writeLog("error", component, event, fields),
} as const;

export function errorCategory(error: unknown): string {
	if (error instanceof Error) return safeName(error.name, "error");
	return typeof error === "string" ? "string_error" : "unknown_error";
}

/** systemd ExecStartPre: fixed 8 MiB / three archives, private permissions. */
export function rotateLogFile(logPath: string): void {
	if (existsSync(logPath) && statSync(logPath).size >= 8 * 1024 * 1024) {
		rmSync(`${logPath}.3`, { force: true });
		for (let index = 2; index >= 1; index--)
			if (existsSync(`${logPath}.${index}`)) renameSync(`${logPath}.${index}`, `${logPath}.${index + 1}`);
		renameSync(logPath, `${logPath}.1`);
	}
	for (const suffix of ["", ".1", ".2", ".3"]) if (existsSync(logPath + suffix)) chmodSync(logPath + suffix, 0o600);
}

export function readStructuredLogTail(logPath: string, maxBytes = 64 * 1024, maxRecords = 100): LogRecord[] {
	if (!existsSync(logPath)) return [];
	let fd: number | null = null;
	try {
		fd = openSync(logPath, "r");
		const size = statSync(logPath).size;
		const start = Math.max(0, size - maxBytes);
		const buffer = Buffer.alloc(size - start);
		readSync(fd, buffer, 0, buffer.length, start);
		const raw = buffer.toString("utf8");
		const lines = raw.split("\n");
		if (start > 0) lines.shift();
		return lines
			.slice(-maxRecords - 1)
			.flatMap((line): LogRecord[] => {
				try {
					const parsed = JSON.parse(line) as Partial<LogRecord>;
					if (
						parsed.schema !== LOG_SCHEMA_VERSION ||
						typeof parsed.ts !== "string" ||
						typeof parsed.level !== "string" ||
						typeof parsed.component !== "string" ||
						typeof parsed.event !== "string"
					)
						return [];
					return [parsed as LogRecord];
				} catch {
					return [];
				}
			})
			.slice(-maxRecords);
	} catch {
		return [];
	} finally {
		if (fd != null)
			try {
				closeSync(fd);
			} catch {
				/* already closed */
			}
	}
}
