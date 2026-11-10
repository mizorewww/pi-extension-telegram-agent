// The only configuration source: trusted `telegram.config.ts` in TG_CONFIG_DIR plus `.env`
// (`key: value`) for Telegram/TinyFish/Gemini secrets. LLM credentials stay in Pi's auth store.
// Validation collects every error and throws one ConfigError listing them all.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createJiti } from "jiti";
import { Type, type Static } from "typebox";
import { compile } from "@earendil-works/pi-schema";
import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import type { BoxConfig } from "./sandbox/box.ts";
import type { TasksConfig } from "./tasks/manager.ts";
import { loadPiModelDefaults, type PiModelDefaults } from "./agent/model-settings.ts";
import { DEFAULT_DECIDER_THRESHOLD } from "./agent/decider.ts";

/** Pi keeps this much room for the next response; compaction_threshold must leave it free. */
export const MIN_COMPACTION_RESERVE = 16_384;

type CacheRetention = "none" | "short" | "long";
/** "off": placeholders only; "hybrid": the chat model describes each new medium once as text. */
export type MediaMode = "off" | "hybrid";

const text = Type.String({ pattern: "\\S" });
const positive = Type.Number({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const reasoning = Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const configSchema = Type.Object(
	{
		group_peer_id: Type.Union([Type.String(), Type.Number()]),
		name: Type.Optional(Type.String()),
		token_env: text,
		persona_path: text,
		provider: Type.Optional(text),
		model: Type.Optional(text),
		reasoning_effort: Type.Optional(reasoning),
		cache_retention: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("short"), Type.Literal("long")])),
		compaction_threshold: Type.Optional(positive),
		compaction_keep_recent: Type.Optional(positive),
		cooldown_ms: Type.Optional(Type.Number({ minimum: 0 })),
		provider_timeout_ms: Type.Optional(Type.Number({ minimum: 1000, maximum: 3_600_000 })),
		provider_retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
		decider: Type.Optional(
			Type.Object(
				{
					model: Type.String({ pattern: "^[^/\\s]+/\\S+$" }),
					threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
				},
				{ additionalProperties: false },
			),
		),
		tools: Type.Optional(
			Type.Partial(
				Type.Object(
					{
						send: Type.Boolean(),
						search: Type.Boolean(),
						semantic: Type.Boolean(),
						codemode: Type.Boolean(),
						sandbox: Type.Boolean(),
						tasks: Type.Boolean(),
					},
					{ additionalProperties: false },
				),
			),
		),
		sticker_sets: Type.Optional(Type.Array(text)),
		context_window: Type.Optional(Type.Integer({ minimum: MIN_COMPACTION_RESERVE * 2, maximum: 10_000_000 })),
		media: Type.Optional(
			Type.Partial(
				Type.Object(
					{
						mode: Type.Union([Type.Literal("off"), Type.Literal("hybrid")]),
						max_per_turn: Type.Integer({ minimum: 0, maximum: 16 }),
						concurrency: Type.Integer({ minimum: 1, maximum: 16 }),
					},
					{ additionalProperties: false },
				),
			),
		),
		sandbox: Type.Optional(
			Type.Partial(
				Type.Object(
					{
						image: text,
						docker_host: text,
						memory: text,
						cpus: Type.Number({ minimum: 0.1, maximum: 64 }),
						pids: Type.Integer({ minimum: 16, maximum: 65_536 }),
						network: Type.Boolean(),
					},
					{ additionalProperties: false },
				),
			),
		),
		tasks: Type.Optional(
			Type.Object(
				{
					workflows: Type.Record(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" }), text, {
						minProperties: 1,
						additionalProperties: false,
					}),
					max_running: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
					timeout_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440 })),
				},
				{ additionalProperties: false },
			),
		),
		raw_update_retention_days: Type.Optional(Type.Number({ minimum: 1, maximum: 3650 })),
		message_event_retention_days: Type.Optional(Type.Number({ minimum: 1, maximum: 3650 })),
		telegram_admins: Type.Optional(
			Type.Array(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), { uniqueItems: true }),
		),
	},
	{ additionalProperties: false },
);
const configValidator = compile(configSchema);
export type TelegramConfigInput = Static<typeof configSchema>;
export type TelegramAdmin = number;

/** A classifier model that decides whether an unaddressed message deserves a reply. */
export interface DeciderConfig {
	provider: string;
	model: string;
	threshold: number;
}

export interface BotConfig {
	name: string;
	token: string;
	personaPath: string;
	/** Quiet time after a turn before unaddressed messages are judged again. */
	cooldownMs: number;
	/** Null: every unaddressed message gets a turn. */
	decider: DeciderConfig | null;
	provider: string;
	model: string;
	reasoningEffort: ThinkingLevel;
	compactionThreshold: number;
	compactionKeepRecent: number;
	cacheRetention: CacheRetention;
	providerTimeoutMs: number;
	providerRetries: number;
	tools: { send: boolean; search: boolean; semantic: boolean; codemode: boolean; sandbox: boolean; tasks: boolean };
	stickerSets: string[];
}

export interface RetentionConfig {
	rawUpdateDays: number;
	messageEventDays: number;
}

export interface AppConfig {
	configDir: string;
	dataDir: string;
	dbPath: string;
	groupPeerId: number;
	/** `-100<groupPeerId>`: the one chat id ingestion accepts and every send targets. */
	groupChatId: number;
	bot: BotConfig;
	tinyfishApiKey: string;
	geminiApiKey: string;
	contextWindow: number;
	media: { mode: MediaMode; maxPerTurn: number; concurrency: number };
	/** Work box settings; null when the deployment has no sandbox section. */
	sandbox: BoxConfig | null;
	/** Background task workflows; null when the deployment has no tasks section. */
	tasks: TasksConfig | null;
	retention: RetentionConfig;
	/** Deny-by-default allowlist for mutating Telegram control commands. */
	telegramAdmins: TelegramAdmin[];
}

export class ConfigError extends Error {
	constructor(public readonly errors: string[]) {
		super(`invalid configuration:\n${errors.join("\n")}`);
		this.name = "ConfigError";
	}
}

export function parseEnvFile(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(path)) return out;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
		if (m) out[m[1]!] = m[2]!.trim();
	}
	return out;
}

/**
 * Accept a bare positive peer id, its negative form, or the `-100…` chat id. The prefix is only
 * stripped when enough digits remain to be a real peer id. NaN when not a positive integer.
 */
export function normalizePeerId(raw: string | number): number {
	let digits = String(raw).trim().replace(/^-/, "");
	if (digits.startsWith("100") && digits.length > 11) digits = digits.slice(3);
	const n = Number(digits);
	return Number.isInteger(n) && n > 0 ? n : NaN;
}

function resolvePath(rootDir: string, p: string): string {
	if (isAbsolute(p)) return resolve(p);
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return resolve(rootDir, p);
}

const configJiti = createJiti(import.meta.url, { interopDefault: false, moduleCache: false });

export function configDirectory(): string {
	return resolve(process.env.TG_CONFIG_DIR || "/etc/pi-telegram-agent");
}

export function stateDirectory(): string {
	return resolve(process.env.TG_STATE_DIR || "/var/lib/pi-telegram-agent");
}

export function defaultConfigPath(rootDir = configDirectory()): string {
	return join(rootDir, "telegram.config.ts");
}

export function loadConfigSource(path: string): TelegramConfigInput {
	if (!existsSync(path)) {
		throw new ConfigError([
			`[config] missing configuration: ${path}`,
			"[config] copy telegram.config.example.ts to telegram.config.ts and fill it in",
		]);
	}
	let loaded: unknown;
	try {
		loaded = configJiti.evalModule(readFileSync(path, "utf8"), { filename: path, async: false });
	} catch (error) {
		throw new ConfigError([
			`[config] ${path}: unable to load trusted TypeScript: ${error instanceof Error ? error.message : String(error)}`,
		]);
	}
	const source = loaded && typeof loaded === "object" && "default" in loaded ? loaded.default : loaded;
	if (!configValidator.check(source))
		throw new ConfigError(configValidator.errors(source).map((error) => `[config] ${error.path}: ${error.message}`));
	return source as TelegramConfigInput;
}

/** Shape and range checks that need no Pi state; secrets are only checked for presence. */
function validate(
	rootDir: string,
	raw: TelegramConfigInput,
	env: Record<string, string | undefined>,
	identityOnly: boolean,
): string[] {
	const errors: string[] = [];
	if (!identityOnly && !env[raw.token_env]) errors.push(`[config] token_env: missing env key ${raw.token_env}`);
	const persona = resolvePath(rootDir, raw.persona_path);
	if (!existsSync(persona) || !statSync(persona).isFile())
		errors.push("[config] persona_path: persona must be a readable file");
	if (raw.tools?.sandbox && !raw.sandbox) errors.push("[config] tools.sandbox: needs sandbox configuration");
	if (raw.tools?.tasks && (!raw.tools.sandbox || !raw.tasks))
		errors.push("[config] tools.tasks: needs sandbox and tasks configuration");
	if (raw.tasks) {
		if (!raw.sandbox) errors.push("[config] tasks require sandbox configuration");
		for (const [name, dir] of Object.entries(raw.tasks.workflows))
			if (!existsSync(join(resolvePath(rootDir, dir), "AGENTS.md")))
				errors.push(`[config] workflow ${name}: directory must contain AGENTS.md`);
	}
	return errors;
}

export interface LoadConfigOptions {
	/** Explicit runtime data directory for embedders; independent of the configuration directory. */
	stateDir?: string;
	/** Explicit trusted local .ts source; config writes validate a temporary copy through it. */
	configPath?: string;
	/** Deterministic injection for tests/embedders; production reads merged Pi settings. */
	piModelDefaults?: PiModelDefaults;
	/**
	 * Offline diagnostics: never consult Pi settings or require secrets. Model fields the file
	 * omits stay empty and tokens are blank.
	 */
	identityOnly?: boolean;
}

export function loadConfig(rootDir = configDirectory(), options: LoadConfigOptions = {}): AppConfig {
	rootDir = resolve(rootDir);
	const identityOnly = options.identityOnly === true;
	const env = identityOnly ? {} : { ...parseEnvFile(join(rootDir, ".env")), ...process.env };
	const raw = loadConfigSource(options.configPath ?? defaultConfigPath(rootDir));
	const errors = validate(rootDir, raw, env, identityOnly);
	if (errors.length > 0) throw new ConfigError(errors);

	const str = (value?: string) => value?.trim();
	const needsPiDefaults = !identityOnly && (str(raw.provider) == null || str(raw.model) == null);
	const pi =
		options.piModelDefaults ??
		(needsPiDefaults ? loadPiModelDefaults(rootDir) : { provider: undefined, model: undefined });
	const provider = str(raw.provider) ?? pi.provider ?? "";
	// A provider switch without a model must not inherit Pi's model for another provider.
	const model = str(raw.model) ?? (str(raw.provider) && str(raw.provider) !== pi.provider ? "" : (pi.model ?? ""));
	if (!identityOnly && !provider) errors.push("[config] provider: select one in config or Pi /model");
	if (!identityOnly && !model)
		errors.push(`[config] provider "${provider}" has no model; select both in config or Pi /model`);

	const contextWindow = raw.context_window ?? 65_536;
	const maxThreshold = contextWindow - MIN_COMPACTION_RESERVE;
	const media = raw.media ?? {};
	const mediaMode = media.mode ?? "off";
	const groupPeerId = normalizePeerId(String(raw.group_peer_id ?? ""));
	if (!Number.isFinite(groupPeerId)) errors.push("[config] group_peer_id: required (bare positive peer id)");
	const compactionThreshold = raw.compaction_threshold ?? Math.floor(contextWindow / 2);
	if (compactionThreshold > maxThreshold)
		errors.push(
			`[config] compaction_threshold ${compactionThreshold}: effective trigger is capped at ${maxThreshold} (context_window ${contextWindow} minus ${MIN_COMPACTION_RESERVE} reserve); use a value <= ${maxThreshold}`,
		);
	const tools = raw.tools ?? {};
	const deciderSlash = raw.decider?.model.indexOf("/") ?? -1;
	const bot: BotConfig = {
		name: str(raw.name) || "bot",
		token: identityOnly ? "" : (env[raw.token_env] ?? ""),
		personaPath: resolvePath(rootDir, raw.persona_path),
		cooldownMs: raw.cooldown_ms ?? 2000,
		decider: raw.decider
			? {
					provider: raw.decider.model.slice(0, deciderSlash),
					model: raw.decider.model.slice(deciderSlash + 1),
					threshold: raw.decider.threshold ?? DEFAULT_DECIDER_THRESHOLD,
				}
			: null,
		provider,
		model,
		reasoningEffort: raw.reasoning_effort ?? "off",
		compactionThreshold,
		compactionKeepRecent: raw.compaction_keep_recent ?? 20_000,
		cacheRetention: raw.cache_retention ?? "short",
		providerTimeoutMs: raw.provider_timeout_ms ?? 300_000,
		providerRetries: raw.provider_retries ?? 2,
		tools: {
			send: tools.send !== false,
			search: tools.search === true,
			semantic: tools.semantic === true,
			codemode: tools.codemode === true,
			sandbox: tools.sandbox === true,
			tasks: tools.tasks === true,
		},
		stickerSets: [...(raw.sticker_sets ?? [])],
	};
	const tinyfishApiKey = env.tiny_fish_api_key ?? "";
	if (!identityOnly && !tinyfishApiKey && bot.tools.search)
		errors.push('[config] tools.search: needs "tiny_fish_api_key" in .env');
	const geminiApiKey = env.gemini_api_key ?? "";
	if (!identityOnly && !geminiApiKey && bot.tools.semantic)
		errors.push('[config] tools.semantic: needs "gemini_api_key" in .env');
	if (bot.tools.semantic && !bot.tools.codemode)
		errors.push("[config] tools.semantic: needs tools.codemode (tg_messages)");
	if (errors.length > 0) throw new ConfigError(errors);

	const dataDir = resolve(options.stateDir ?? stateDirectory());
	return {
		configDir: rootDir,
		dataDir,
		dbPath: join(dataDir, "agent.db"),
		groupPeerId,
		groupChatId: Number(`-100${groupPeerId}`),
		bot,
		tinyfishApiKey,
		geminiApiKey,
		contextWindow,
		media: {
			mode: mediaMode,
			maxPerTurn: media.max_per_turn ?? 2,
			concurrency: media.concurrency ?? 2,
		},
		sandbox: raw.sandbox === undefined ? null : sandboxConfig(raw.sandbox),
		tasks: raw.tasks === undefined ? null : tasksConfig(rootDir, raw.tasks),
		retention: {
			rawUpdateDays: raw.raw_update_retention_days ?? 30,
			messageEventDays: raw.message_event_retention_days ?? 365,
		},
		telegramAdmins: raw.telegram_admins ?? [],
	};
}

function sandboxConfig(raw: NonNullable<TelegramConfigInput["sandbox"]>): BoxConfig {
	return {
		image: raw.image ?? "tg-box:4",
		dockerHost: raw.docker_host ?? "unix:///run/tgbox/docker.sock",
		memory: raw.memory ?? "1g",
		cpus: raw.cpus ?? 2,
		pids: raw.pids ?? 256,
		network: raw.network ?? true,
	};
}

function tasksConfig(rootDir: string, raw: NonNullable<TelegramConfigInput["tasks"]>): TasksConfig {
	return {
		workflows: Object.fromEntries(
			Object.entries(raw.workflows).map(([name, dir]) => [name, resolvePath(rootDir, dir)]),
		),
		maxRunning: raw.max_running ?? 2,
		timeoutMs: (raw.timeout_minutes ?? 45) * 60_000,
	};
}
