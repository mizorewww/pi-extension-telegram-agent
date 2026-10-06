import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { defaultConfigPath, loadConfig, normalizePeerId, type AppConfig, type BotConfig } from "../config.ts";

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BOT_ID = /^[A-Za-z0-9_-]+$/;
const TELEGRAM_TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{20,}$/;
const MAX_PERSONA_BYTES = 256 * 1024;
const PRIVATE_MODE = 0o600;

export interface FirstRunDraft {
	groupPeerId: string;
	bot: {
		id: string;
		name: string;
		tokenEnv: string;
		token: string;
		personaText: string;
	};
}

export interface DeploymentSummary {
	configPath: string;
	groupPeerId: number;
	bots: Array<{ id: string; name: string; provider: string; model: string }>;
}

export interface ConfigSource {
	path: string;
	source: string;
}

export class OnboardingValidationError extends Error {
	readonly fields: readonly string[];

	constructor(fields: readonly string[]) {
		super(`invalid onboarding fields: ${fields.join(", ")}`);
		this.name = "OnboardingValidationError";
		this.fields = fields;
	}
}

export class OnboardingWriteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OnboardingWriteError";
	}
}

export type OnboardingWriteMode = "create" | "backup-replace";

export interface OnboardingWriteOptions {
	mode?: OnboardingWriteMode;
	/** Preflighted Pi selection to pin in newly generated configuration. */
	modelSelection?: { provider: string; model: string };
}

interface NormalizedDraft extends FirstRunDraft {
	groupPeerIdNumber: number;
	personaRelativePath: string;
}

interface InstallFile {
	path: string;
	contents: string;
	mode: number;
}

interface AtomicInstall {
	backupPaths: string[];
	rollback(): void;
	finalize(): void;
}

export function validateFirstRunDraft(draft: FirstRunDraft): NormalizedDraft {
	const invalid: string[] = [];
	const groupPeerIdNumber = normalizePeerId(draft.groupPeerId);
	if (!Number.isFinite(groupPeerIdNumber)) invalid.push("group_peer_id");
	if (!BOT_ID.test(draft.bot.id)) invalid.push("bot.id");
	if (!draft.bot.name.trim() || draft.bot.name.length > 64 || /[\r\n\0]/.test(draft.bot.name)) invalid.push("bot.name");
	if (!ENV_KEY.test(draft.bot.tokenEnv)) invalid.push("bot.token_env");
	if (!TELEGRAM_TOKEN.test(draft.bot.token)) invalid.push("bot.token");
	if (
		!draft.bot.personaText.trim() ||
		draft.bot.personaText.includes("\0") ||
		Buffer.byteLength(draft.bot.personaText, "utf8") > MAX_PERSONA_BYTES
	)
		invalid.push("bot.persona");
	if (invalid.length > 0) throw new OnboardingValidationError([...new Set(invalid)]);

	return {
		...draft,
		groupPeerIdNumber,
		bot: { ...draft.bot, name: draft.bot.name.trim() },
		personaRelativePath: `personas/${draft.bot.id}.local.md`,
	};
}

export function mergeEnvSource(source: string, updates: Readonly<Record<string, string>>): string {
	const remaining = new Map(Object.entries(updates));
	const updateKeys = new Set(remaining.keys());
	const output: string[] = [];
	for (const line of source.split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
		if (!match || !updateKeys.has(match[1]!)) {
			output.push(line);
			continue;
		}
		if (!remaining.has(match[1]!)) continue;
		output.push(`${match[1]}: ${remaining.get(match[1]!)}`);
		remaining.delete(match[1]!);
	}
	while (output.length > 0 && output.at(-1) === "") output.pop();
	if (output.length > 0 && remaining.size > 0) output.push("");
	for (const [key, value] of remaining) output.push(`${key}: ${value}`);
	return `${output.join("\n")}\n`;
}

/**
 * Render only the required fields plus what the wizard actually collected; every omitted
 * field falls through to the defaults in src/config.ts, which stay the single source of truth.
 */
function renderFirstRunConfig(draft: NormalizedDraft, modelSelection?: { provider: string; model: string }): string {
	const value = (input: string | number) => JSON.stringify(input);
	const pinnedModel = modelSelection
		? `\tprovider: ${value(modelSelection.provider)},\n\tmodel: ${value(modelSelection.model)},\n`
		: "";
	return `import { defineConfig } from "./src/config.ts";

export default defineConfig({
	group_peer_id: ${value(draft.groupPeerIdNumber)},
${pinnedModel}	bots: [{
		id: ${value(draft.bot.id)},
		name: ${value(draft.bot.name)},
		token_env: ${value(draft.bot.tokenEnv)},
		persona_path: ${value(draft.personaRelativePath)},
	}],
});
`;
}

/** Write a complete first-run deployment or replace it only after explicit confirmation upstream. */
export function writeFirstRunDeployment(
	rootDir: string,
	draft: FirstRunDraft,
	options: OnboardingWriteOptions = {},
): {
	summary: DeploymentSummary;
	backupPaths: string[];
} {
	const root = resolve(rootDir);
	const normalized = validateFirstRunDraft(draft);
	const mode = options.mode ?? "create";
	const configPath = join(root, "telegram.config.ts");
	const envPath = join(root, ".env");
	const personaPath = join(root, normalized.personaRelativePath);

	let existingEnv = "";
	if (mode === "backup-replace" && existsSync(envPath)) {
		assertRegularFile(envPath);
		existingEnv = readFileSync(envPath, "utf8");
	}
	const envSource = mergeEnvSource(existingEnv, {
		[normalized.bot.tokenEnv]: normalized.bot.token,
	});
	const files: InstallFile[] = [
		{ path: envPath, contents: envSource, mode: PRIVATE_MODE },
		{ path: configPath, contents: renderFirstRunConfig(normalized, options.modelSelection), mode: PRIVATE_MODE },
		{ path: personaPath, contents: ensureTrailingNewline(normalized.bot.personaText), mode: PRIVATE_MODE },
	];
	const transaction = installAtomically(files, mode);
	try {
		const config = loadConfig(root, { configPath });
		const summary = summarizeConfig(root, config, configPath);
		transaction.finalize();
		return { summary, backupPaths: transaction.backupPaths.map((path) => relative(root, path)) };
	} catch {
		transaction.rollback();
		throw new OnboardingWriteError("final configuration validation failed; original files were restored");
	}
}

export function validateExistingDeployment(rootDir: string): DeploymentSummary {
	const root = resolve(rootDir);
	const path = defaultConfigPath(root);
	return summarizeConfig(root, loadConfig(root), path);
}

export function readExistingConfigSource(rootDir: string): ConfigSource {
	const root = resolve(rootDir);
	const path = defaultConfigPath(root);
	if (!existsSync(path)) throw new OnboardingWriteError("no existing telegram.config.ts configuration was found");
	assertRegularFile(path);
	return { path, source: readFileSync(path, "utf8") };
}

export function validateEditedConfigSource(rootDir: string, path: string, source: string): DeploymentSummary {
	const root = resolve(rootDir);
	const target = resolve(path);
	if (dirname(target) !== root || extname(target) !== ".ts") {
		throw new OnboardingWriteError("edited configuration must be the project-root .ts source");
	}
	const extension = extname(target);
	const stem = basename(target, extension);
	const temporary = join(root, `.${stem}.edit-${randomUUID()}${extension}`);
	if (existsSync(temporary)) throw new OnboardingWriteError(`temporary file already exists: ${basename(temporary)}`);
	let created = false;
	try {
		writeFileSync(temporary, source, { encoding: "utf8", flag: "wx", mode: PRIVATE_MODE });
		created = true;
		return summarizeConfig(root, loadConfig(root, { configPath: temporary }), target);
	} finally {
		if (created) unlinkIfExists(temporary);
	}
}

export function replaceExistingConfigSource(
	rootDir: string,
	path: string,
	source: string,
	options: { confirmed: boolean },
): { summary: DeploymentSummary; backupPath: string } {
	if (!options.confirmed)
		throw new OnboardingWriteError("replacement was not confirmed; original configuration was preserved");
	const root = resolve(rootDir);
	const target = resolve(path);
	assertRegularFile(target);
	validateEditedConfigSource(root, target, source);
	const transaction = installAtomically([{ path: target, contents: source, mode: PRIVATE_MODE }], "backup-replace");
	try {
		const summary = summarizeConfig(root, loadConfig(root, { configPath: target }), target);
		transaction.finalize();
		return { summary, backupPath: relative(root, transaction.backupPaths[0]!) };
	} catch {
		transaction.rollback();
		throw new OnboardingWriteError("edited configuration validation failed; original file was restored");
	}
}

export type BotControlConfigField = "routing_p" | "sampling_cooldown_ms";

/**
 * Write one numeric bot control field through to the live config file, which stays the only
 * source of truth (the change survives restarts). The draft is validated before it replaces
 * the file; runtime edits keep no backup copies.
 */
export function updateBotConfigField(
	rootDir: string,
	botId: string,
	field: BotControlConfigField,
	value: number,
): DeploymentSummary {
	const root = resolve(rootDir);
	const { path, source } = readExistingConfigSource(root);
	const edited = replaceBotFieldValue(source, botId, field, value);
	const summary = validateEditedConfigSource(root, path, edited);
	installAtomically([{ path, contents: edited, mode: PRIVATE_MODE }], "backup-replace", false).finalize();
	return summary;
}

/** One validated file replacement for the entire model selection; caller commits its runtime next. */
export function updateBotModelConfig(
	rootDir: string,
	botId: string,
	selection: Pick<BotConfig, "provider" | "model" | "reasoningEffort">,
): Pick<AtomicInstall, "finalize" | "rollback"> {
	const root = resolve(rootDir);
	const { path, source } = readExistingConfigSource(root);
	let edited = source;
	for (const [field, value] of Object.entries({
		provider: selection.provider,
		model: selection.model,
		reasoning_effort: selection.reasoningEffort,
	}))
		edited = replaceBotFieldValue(edited, botId, field, value);
	validateEditedConfigSource(root, path, edited);
	return installAtomically([{ path, contents: edited, mode: PRIVATE_MODE }], "backup-replace", false);
}

/**
 * Text-edit one bot field inside its object block. Assumes the wizard/example config shape:
 * each bot is an object literal inside `bots: [...]` anchored by an `id: "X"` line, with
 * scalar fields rendered one per line.
 */
function replaceBotFieldValue(source: string, botId: string, field: string, value: number | string): string {
	const idLine = /^[ \t]*id:[ \t]*["']([A-Za-z0-9_-]+)["'][ \t]*,?[ \t]*(?:\/\/[^\r\n]*)?$/gm;
	const anchors = [...source.matchAll(idLine)];
	const anchor = anchors.filter((match) => match[1] === botId);
	if (anchor.length !== 1)
		throw new OnboardingWriteError(`config source must contain exactly one id anchor for bot "${botId}"`);
	const start = anchor[0]!.index!;
	const indent = anchor[0]![0].match(/^[ \t]*/)![0];
	const closing = new RegExp(`^[ \\t]{0,${Math.max(0, indent.length - 1)}}\\}`, "m").exec(source.slice(start));
	if (!closing) throw new OnboardingWriteError(`config source has no closing object for bot "${botId}"`);
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
		throw new OnboardingWriteError(`config field ${field} must be a scalar literal`);
	// Field absent (e.g. bot-level sampling_cooldown_ms falling back to the global value):
	// insert it right after the id line, matching its indent.
	const lineEnd = block.indexOf("\n");
	if (lineEnd < 0) throw new OnboardingWriteError(`config source is truncated after the id anchor for bot "${botId}"`);
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

/** Replace every file or none; wizard flows keep a copy of each replaced original beside it. */
function installAtomically(files: InstallFile[], mode: OnboardingWriteMode, keepBackups = true): AtomicInstall {
	const existing = files.map((file) => file.path).filter((path) => existsSync(path));
	if (mode === "create" && existing.length > 0)
		throw new OnboardingWriteError(
			`existing files were preserved: ${existing.map((path) => basename(path)).join(", ")}`,
		);
	for (const path of existing) assertRegularFile(path);
	const originals = new Map(existing.map((path) => [path, readFileSync(path)]));
	const nonce = randomUUID();
	const backupPaths = keepBackups ? existing.map((path) => `${path}.bak-${nonce}`) : [];
	const written: string[] = [];
	let closed = false;
	const rollback = () => {
		if (closed) return;
		closed = true;
		for (const path of written.reverse()) {
			const original = originals.get(path);
			if (original) writeAtomic(path, original, PRIVATE_MODE);
			else unlinkIfExists(path);
		}
	};
	try {
		for (const [index, backup] of backupPaths.entries())
			writeFileSync(backup, originals.get(existing[index]!)!, { flag: "wx", mode: PRIVATE_MODE });
		for (const file of files) {
			written.push(file.path);
			writeAtomic(file.path, file.contents, file.mode);
		}
	} catch {
		try {
			rollback();
		} catch {
			throw new OnboardingWriteError(
				"configuration write failed and automatic rollback was incomplete; inspect local backup files",
			);
		}
		throw new OnboardingWriteError("configuration write failed; original files were restored");
	}
	return {
		backupPaths,
		rollback,
		finalize() {
			closed = true;
		},
	};
}

function summarizeConfig(root: string, config: AppConfig, configPath: string): DeploymentSummary {
	return {
		configPath: relative(root, configPath),
		groupPeerId: config.groupPeerId,
		bots: config.bots.map((bot) => ({ id: bot.id, name: bot.name, provider: bot.provider, model: bot.model })),
	};
}

function assertRegularFile(path: string): void {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new OnboardingWriteError(`refusing non-regular local file: ${basename(path)}`);
	}
}

function unlinkIfExists(path: string): void {
	if (!existsSync(path)) return;
	unlinkSync(path);
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}
