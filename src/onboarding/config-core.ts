// Write-through edits of telegram.config.ts for the group /set and /model commands. The file
// stays in the resolved configuration directory; validate a temporary sibling before replacing it.

import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { defaultConfigPath, loadConfig, type BotConfig } from "../config.ts";

const PRIVATE_MODE = 0o600;

export class ConfigWriteError extends Error {}

function readConfigSource(root: string): { path: string; source: string } {
	const path = defaultConfigPath(root);
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isFile()) throw new ConfigWriteError("telegram.config.ts must be a regular file");
	return { path, source: readFileSync(path, "utf8") };
}

/** Load the edited source from a temporary sibling so a broken edit never reaches the real file. */
function validateConfigSource(root: string, source: string): void {
	const temporary = join(root, `.telegram.config.edit-${randomUUID()}.ts`);
	writeFileSync(temporary, source, { encoding: "utf8", flag: "wx", mode: PRIVATE_MODE });
	try {
		loadConfig(root, { configPath: temporary });
	} finally {
		rmSync(temporary, { force: true });
	}
}

export type BotControlConfigField = "routing_p" | "cooldown_ms";

/**
 * Write one numeric bot control field through to the live config file, which stays the only
 * source of truth (the change survives restarts). The draft is validated before it replaces
 * the file.
 */
export function updateBotConfigField(
	rootDir: string,
	botId: string,
	field: BotControlConfigField,
	value: number,
): void {
	const root = resolve(rootDir);
	const { path, source } = readConfigSource(root);
	const edited = replaceBotFieldValue(source, botId, field, value);
	validateConfigSource(root, edited);
	writeAtomic(path, edited, PRIVATE_MODE);
}

/** One validated file replacement for the entire model selection; caller commits its runtime next. */
export function updateBotModelConfig(
	rootDir: string,
	botId: string,
	selection: Pick<BotConfig, "provider" | "model" | "reasoningEffort">,
): { finalize(): void; rollback(): void } {
	const root = resolve(rootDir);
	const { path, source } = readConfigSource(root);
	let edited = source;
	for (const [field, value] of Object.entries({
		provider: selection.provider,
		model: selection.model,
		reasoning_effort: selection.reasoningEffort,
	}))
		edited = replaceBotFieldValue(edited, botId, field, value);
	validateConfigSource(root, edited);
	writeAtomic(path, edited, PRIVATE_MODE);
	return { finalize() {}, rollback: () => writeAtomic(path, source, PRIVATE_MODE) };
}

/**
 * Text-edit one bot field inside its object block. Assumes the example config shape:
 * each bot is an object literal inside `bots: [...]` anchored by an `id: "X"` line, with
 * scalar fields rendered one per line.
 */
function replaceBotFieldValue(source: string, botId: string, field: string, value: number | string): string {
	const idLine = /^[ \t]*id:[ \t]*["']([A-Za-z0-9_-]+)["'][ \t]*,?[ \t]*(?:\/\/[^\r\n]*)?$/gm;
	const anchors = [...source.matchAll(idLine)];
	const anchor = anchors.filter((match) => match[1] === botId);
	if (anchor.length !== 1)
		throw new ConfigWriteError(`config source must contain exactly one id anchor for bot "${botId}"`);
	const start = anchor[0]!.index!;
	const indent = anchor[0]![0].match(/^[ \t]*/)![0];
	const closing = new RegExp(`^[ \\t]{0,${Math.max(0, indent.length - 1)}}\\}`, "m").exec(source.slice(start));
	if (!closing) throw new ConfigWriteError(`config source has no closing object for bot "${botId}"`);
	const end = start + closing.index;
	const block = source.slice(start, end);
	const fieldPattern = new RegExp(
		`^(${indent}${field}:[ \\t]*)(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[0-9][0-9_.]*)(?=[ \\t]*[,\\r\\n])`,
		"m",
	);
	const rendered = JSON.stringify(value);
	if (fieldPattern.test(block)) {
		return (
			source.slice(0, start) +
			block.replace(fieldPattern, (_match, prefix: string) => prefix + rendered) +
			source.slice(end)
		);
	}
	if (new RegExp(`^${indent}${field}:`, "m").test(block))
		throw new ConfigWriteError(`config field ${field} must be a scalar literal`);
	// Field absent (e.g. bot-level cooldown_ms falling back to the global value):
	// insert it right after the id line, matching its indent.
	const lineEnd = block.indexOf("\n");
	if (lineEnd < 0) throw new ConfigWriteError(`config source is truncated after the id anchor for bot "${botId}"`);
	const inserted = `${block.slice(0, lineEnd + 1)}${indent}${field}: ${rendered},\n${block.slice(lineEnd + 1)}`;
	return source.slice(0, start) + inserted + source.slice(end);
}

/** Write through a same-directory temporary file so readers never see a partial file. */
function writeAtomic(path: string, contents: string | Buffer, mode: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
	writeFileSync(temporary, contents, { flag: "wx", mode });
	chmodSync(temporary, mode);
	renameSync(temporary, path);
}
