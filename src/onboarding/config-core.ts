// Write-through edits of telegram.config.ts for the group /model command. The file
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

/** One validated file replacement for the entire model selection; caller commits its runtime next. */
export function updateBotModelConfig(
	rootDir: string,
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
		edited = replaceTopLevelValue(edited, field, value);
	validateConfigSource(root, edited);
	writeAtomic(path, edited, PRIVATE_MODE);
	return { finalize() {}, rollback: () => writeAtomic(path, source, PRIVATE_MODE) };
}

/**
 * Text-edit one top-level scalar field. Assumes the example config shape: top-level fields one per
 * line at the indent of the required `token_env:` line; nested blocks such as `decider` sit deeper.
 */
function replaceTopLevelValue(source: string, field: string, value: string): string {
	const anchor = /^([ \t]*)token_env:/m.exec(source);
	if (!anchor) throw new ConfigWriteError("config source has no top-level token_env line");
	const indent = anchor[1]!;
	const rendered = JSON.stringify(value);
	const fieldPattern = new RegExp(
		`^(${indent}${field}:[ \\t]*)(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')(?=[ \\t]*[,\\r\\n])`,
		"m",
	);
	if (fieldPattern.test(source)) return source.replace(fieldPattern, (_match, prefix: string) => prefix + rendered);
	if (new RegExp(`^${indent}${field}:`, "m").test(source))
		throw new ConfigWriteError(`config field ${field} must be a string literal`);
	return source.replace(anchor[0], `${indent}${field}: ${rendered},\n${anchor[0]}`);
}

/** Write through a same-directory temporary file so readers never see a partial file. */
function writeAtomic(path: string, contents: string | Buffer, mode: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
	writeFileSync(temporary, contents, { flag: "wx", mode });
	chmodSync(temporary, mode);
	renameSync(temporary, path);
}
