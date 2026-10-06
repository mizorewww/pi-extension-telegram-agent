// The only configuration source: trusted `telegram.config.ts` (project root) plus `.env`
// (`key: value`) for Telegram/TinyFish/router secrets. LLM credentials stay in Pi's auth store.
// Validation collects every error and throws one ConfigError listing them all.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createJiti } from "jiti";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isPiThinkingLevel, loadPiModelDefaults, type PiModelDefaults } from "./agent/model-settings.ts";
import {
	canonicalPiModelReference,
	DEFAULT_AUXILIARY_VISUAL_MODEL,
	DEFAULT_COMPACTION_MODEL,
} from "./agent/model-ref.ts";

/** Pi keeps this much room for the next response; compaction_threshold must leave it free. */
export const MIN_COMPACTION_RESERVE = 16_384;

type CacheRetention = "none" | "short" | "long";
type MediaMode = "vision" | "context";

/** Settings a bot inherits from the deployment level unless it overrides them. */
interface SharedConfigInput {
	provider?: string;
	model?: string;
	reasoning_effort?: ThinkingLevel;
	/** Cheap task model used only for compaction: provider/model:effort. */
	compaction_model?: string;
	cache_retention?: CacheRetention;
	compaction_threshold?: number;
	compaction_keep_recent?: number;
	/** Probability-route cooldown after a completed turn. */
	sampling_cooldown_ms?: number;
	/** Per-attempt provider timeout before the request is aborted and retried. */
	provider_timeout_ms?: number;
	/** Extra Pi attempts for retryable provider failures (0 disables automatic retries). */
	provider_retries?: number;
	/** On-disk bytes of context images that trigger an extra compaction. */
	context_image_budget_bytes?: number;
	max_suffix_tokens?: number;
	max_message_tokens?: number;
}

export interface TelegramBotConfigInput extends SharedConfigInput {
	/** Stable local id used by commands, sessions, routing and telemetry. */
	id: string;
	/** Display name and name trigger; defaults to id. */
	name?: string;
	/** Name of the .env entry holding this bot's Telegram token. */
	token_env: string;
	/** Absolute, home-relative or project-relative trusted Markdown file. */
	persona_path: string;
	/** Probability for unaddressed human messages; all bots together must total <= 1. */
	routing_p?: number;
	tools?: { send?: boolean; search?: boolean; run_js?: boolean };
	sticker_sets?: readonly string[];
}

/** Trusted local deployment config. Secret values belong in .env, never here. */
export interface TelegramConfigInput extends SharedConfigInput {
	group_peer_id: string | number;
	router_secret_env?: string;
	db_path?: string;
	tinyfish_key_env?: string;
	/** Vision-mode task model: provider/model:effort. */
	auxiliary_visual_model?: string;
	/** Cap on the main model's effective context window; also caps compaction_threshold. */
	context_window?: number;
	media?: { mode?: MediaMode; max_images_per_turn?: number; download_concurrency?: number };
	vision?: { enabled?: boolean; foreground_media_limit?: number; concurrency?: number };
	telemetry_retention_days?: number;
	raw_update_retention_days?: number;
	message_event_retention_days?: number;
	telegram_admins?: readonly TelegramAdmin[];
	bots: readonly TelegramBotConfigInput[];
}

/** Identity helper that supplies editor types without changing runtime configuration bytes. */
export function defineConfig<const T extends TelegramConfigInput>(config: T): T {
	return config;
}

export type TelegramAdmin = number | `@${string}`;

export interface BotConfig {
	id: string;
	name: string;
	token: string;
	personaPath: string;
	routingP: number;
	samplingCooldownMs: number;
	provider: string;
	model: string;
	reasoningEffort: ThinkingLevel;
	compactionThreshold: number;
	compactionKeepRecent: number;
	compactionModel: string;
	cacheRetention: CacheRetention;
	contextImageBudgetBytes: number;
	providerTimeoutMs: number;
	providerRetries: number;
	maxSuffixTokens: number;
	maxMessageTokens: number;
	tools: { send: boolean; search: boolean; runJs: boolean };
	stickerSets: string[];
}

export interface RetentionConfig {
	telemetryDays: number;
	rawUpdateDays: number;
	messageEventDays: number;
}

export interface AppConfig {
	dataDir: string;
	dbPath: string;
	groupPeerId: number;
	/** `-100<groupPeerId>`: the one chat id ingestion accepts and every send targets. */
	groupChatId: number;
	bots: BotConfig[];
	tinyfishApiKey: string;
	auxiliaryVisualModel: string;
	vision: { enabled: boolean; foregroundMediaLimit: number; concurrency: number };
	contextWindow: number;
	media: { mode: MediaMode; maxImagesPerTurn: number; downloadConcurrency: number };
	retention: RetentionConfig;
	/** Generated and persisted by the daemon when absent. */
	routerSecret: string | null;
	/** Deny-by-default allowlist for mutating Telegram control commands. */
	telegramAdmins: TelegramAdmin[];
}

export class ConfigError extends Error {
	constructor(public readonly errors: string[]) {
		super(`invalid configuration:\n${errors.join("\n")}`);
		this.name = "ConfigError";
	}
}

type Raw = Record<string, unknown>;
type Rule = { check: (value: unknown) => boolean; expected: string };

const range = (min: number, max: number, integer = false): Rule => ({
	check: (value) =>
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= min &&
		value <= max &&
		(!integer || Number.isSafeInteger(value)),
	expected: `${integer ? "an integer" : "a number"} in [${min}, ${max}]`,
});
const nonEmpty: Rule = {
	check: (value) => typeof value === "string" && value.trim() !== "",
	expected: "a non-empty string",
};
const modelRef: Rule = {
	check: (value) => typeof value === "string" && canonicalPiModelReference(value) != null,
	expected: "provider/model:effort",
};
const oneOf = (...values: readonly unknown[]): Rule => ({
	check: (value) => values.includes(value),
	expected: values.map((value) => JSON.stringify(value)).join(" | "),
});
const thinking: Rule = { check: isPiThinkingLevel, expected: "a Pi thinking level" };
const boolean: Rule = { check: (value) => typeof value === "boolean", expected: "a boolean" };
const MAX = Number.MAX_SAFE_INTEGER;

/** Per-bot overrides are checked against the same bounds as the deployment level. */
const SHARED_RULES: Record<keyof SharedConfigInput, Rule> = {
	provider: nonEmpty,
	model: nonEmpty,
	reasoning_effort: thinking,
	compaction_model: modelRef,
	cache_retention: oneOf("none", "short", "long"),
	compaction_threshold: range(1, MAX),
	compaction_keep_recent: range(1, MAX),
	sampling_cooldown_ms: range(0, MAX),
	provider_timeout_ms: range(1_000, 3_600_000),
	provider_retries: range(0, 5, true),
	context_image_budget_bytes: range(100_000, 100_000_000),
	max_suffix_tokens: range(512, MAX),
	max_message_tokens: range(128, MAX),
};
const ROOT_RULES: Record<string, Rule> = {
	...SHARED_RULES,
	auxiliary_visual_model: modelRef,
	context_window: range(MIN_COMPACTION_RESERVE * 2, 10_000_000, true),
	telemetry_retention_days: range(1, 3650),
	raw_update_retention_days: range(1, 3650),
	message_event_retention_days: range(1, 3650),
};
const BOT_RULES: Record<string, Rule> = { ...SHARED_RULES, routing_p: range(0, 1) };
const NESTED_RULES: Record<string, Record<string, Rule>> = {
	media: {
		mode: oneOf("vision", "context"),
		max_images_per_turn: range(0, 16, true),
		download_concurrency: range(1, 16, true),
	},
	vision: { enabled: boolean, foreground_media_limit: range(0, 16, true), concurrency: range(1, 16, true) },
};

function checkFields(errors: string[], at: string, source: Raw, rules: Record<string, Rule>): void {
	for (const [key, rule] of Object.entries(rules)) {
		const value = source[key];
		if (value !== undefined && !rule.check(value))
			errors.push(`[config] ${at}${key}: expected ${rule.expected}, got ${JSON.stringify(value)}`);
	}
}

const isObject = (value: unknown): value is Raw => value != null && typeof value === "object" && !Array.isArray(value);

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

function normalizeTelegramAdmin(value: unknown): TelegramAdmin | null {
	if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
	if (typeof value !== "string") return null;
	const username = value.trim().toLowerCase();
	return /^@[a-z0-9_]{5,32}$/.test(username) ? (username as `@${string}`) : null;
}

function resolvePath(rootDir: string, p: string): string {
	if (isAbsolute(p)) return resolve(p);
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return resolve(rootDir, p);
}

const configJiti = createJiti(import.meta.url, { interopDefault: false, moduleCache: false });

export function defaultConfigPath(rootDir: string): string {
	return join(rootDir, "telegram.config.ts");
}

function loadConfigSource(path: string): Raw {
	if (!existsSync(path)) {
		throw new ConfigError([
			`[config] missing configuration: ${path}`,
			"[config] copy telegram.config.example.ts to telegram.config.ts, or run /tg config",
		]);
	}
	let loaded: unknown;
	try {
		loaded = configJiti(path);
	} catch (error) {
		throw new ConfigError([
			`[config] ${path}: unable to load trusted TypeScript: ${error instanceof Error ? error.message : String(error)}`,
		]);
	}
	const source = isObject(loaded) && "default" in loaded ? loaded.default : loaded;
	if (!isObject(source)) throw new ConfigError([`[config] ${path}: default export must be a configuration object`]);
	return source;
}

/** Shape and range checks that need no Pi state; secrets are only checked for presence. */
function validate(rootDir: string, raw: Raw, env: Record<string, string>, identityOnly: boolean): string[] {
	const errors: string[] = [];
	checkFields(errors, "", raw, ROOT_RULES);
	for (const [key, rules] of Object.entries(NESTED_RULES)) {
		if (raw[key] === undefined) continue;
		if (isObject(raw[key])) checkFields(errors, `${key}.`, raw[key], rules);
		else errors.push(`[config] ${key}: expected object`);
	}
	if (raw.group_peer_id !== undefined && !Number.isFinite(normalizePeerId(String(raw.group_peer_id))))
		errors.push(
			`[config] group_peer_id: expected a bare positive peer id (e.g. 4402809405, or -1004402809405), got ${JSON.stringify(raw.group_peer_id)}`,
		);
	if (raw.telegram_admins !== undefined) {
		if (!Array.isArray(raw.telegram_admins)) {
			errors.push("[config] telegram_admins: expected an array of positive user ids or @usernames");
		} else {
			const seen = new Set<TelegramAdmin>();
			raw.telegram_admins.forEach((value, index) => {
				const admin = normalizeTelegramAdmin(value);
				if (admin == null)
					errors.push(`[config] telegram_admins[${index}]: expected a positive integer user id or @username`);
				else if (seen.has(admin)) errors.push(`[config] telegram_admins[${index}]: duplicate identity ${admin}`);
				else seen.add(admin);
			});
		}
	}
	const bots = Array.isArray(raw.bots) ? raw.bots : [];
	if (bots.length === 0) errors.push("[config] bots: must be a non-empty array");
	const ids = new Map<string, number>();
	let routingSum = 0;
	bots.forEach((bot: unknown, index) => {
		const at = `bots[${index}]`;
		if (!isObject(bot)) {
			errors.push(`[config] ${at}: must be an object`);
			return;
		}
		checkFields(errors, `${at}.`, bot, BOT_RULES);
		if (typeof bot.routing_p === "number" && Number.isFinite(bot.routing_p)) routingSum += bot.routing_p;
		if (typeof bot.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(bot.id)) {
			errors.push(`[config] ${at}.id: expected [A-Za-z0-9_-]+ string, got ${JSON.stringify(bot.id)}`);
		} else if (ids.has(bot.id)) {
			errors.push(`[config] ${at}.id: duplicate bot id "${bot.id}" (also bots[${ids.get(bot.id)}])`);
		} else ids.set(bot.id, index);
		if (typeof bot.token_env !== "string" || !bot.token_env)
			errors.push(`[config] ${at}.token_env: required (env key name holding the bot token)`);
		else if (!identityOnly && !env[bot.token_env])
			errors.push(`[config] ${at}.token_env: env key "${bot.token_env}" not found in .env`);
		if (typeof bot.persona_path !== "string" || !bot.persona_path) {
			errors.push(`[config] ${at}.persona_path: required`);
		} else {
			const path = resolvePath(rootDir, bot.persona_path);
			if (!existsSync(path) || !statSync(path).isFile())
				errors.push(`[config] ${at}.persona_path: file not readable: ${path}`);
		}
		if (bot.tools !== undefined) {
			if (isObject(bot.tools))
				checkFields(errors, `${at}.tools.`, bot.tools, { send: boolean, search: boolean, run_js: boolean });
			else errors.push(`[config] ${at}.tools: expected object {send?, search?, run_js?}`);
		}
		if (
			bot.sticker_sets !== undefined &&
			(!Array.isArray(bot.sticker_sets) || bot.sticker_sets.some((set) => typeof set !== "string" || !set))
		)
			errors.push(
				`[config] ${at}.sticker_sets: expected array of Telegram sticker set names, got ${JSON.stringify(bot.sticker_sets)}`,
			);
	});
	if (routingSum > 1)
		errors.push(`[config] bots routing_p: probabilities must sum to <= 1, got ${routingSum.toFixed(3)}`);
	return errors;
}

export interface LoadConfigOptions {
	/** Explicit trusted local .ts source, primarily for validating an editor draft. */
	configPath?: string;
	/** In-memory values used by onboarding validation; values override file/process env. */
	env?: Record<string, string>;
	/** Deterministic injection for tests/embedders; production reads merged Pi settings. */
	piModelDefaults?: PiModelDefaults;
	/**
	 * Offline diagnostics: never consult Pi settings or require secrets. Model fields the file
	 * omits stay empty and tokens are blank.
	 */
	identityOnly?: boolean;
}

export function loadConfig(rootDir: string, options: LoadConfigOptions = {}): AppConfig {
	const env = { ...parseEnvFile(join(rootDir, ".env")) };
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, options.env);
	const identityOnly = options.identityOnly === true;
	const raw = loadConfigSource(options.configPath ?? defaultConfigPath(rootDir));
	const errors = validate(rootDir, raw, env, identityOnly);
	if (errors.length > 0) throw new ConfigError(errors);

	const rawBots = raw.bots as Raw[];
	const str = (value: unknown) => (typeof value === "string" ? value.trim() : undefined);
	const needsPiDefaults =
		!identityOnly &&
		rawBots.some((bot) => str(bot.provider ?? raw.provider) == null || str(bot.model ?? raw.model) == null);
	const pi =
		options.piModelDefaults ??
		(needsPiDefaults ? loadPiModelDefaults(rootDir) : { provider: undefined, model: undefined, thinkingLevel: "off" });
	const rootProvider = str(raw.provider) ?? pi.provider;
	// A deployment-level provider switch without a model must not inherit Pi's model for another provider.
	const rootModel = str(raw.model) ?? (str(raw.provider) && str(raw.provider) !== pi.provider ? undefined : pi.model);
	if (needsPiDefaults && !rootProvider && !rootModel)
		errors.push(
			"[config] Pi default provider/model is missing; run Pi /login and select both with /model, or set them explicitly in telegram.config.ts",
		);

	const contextWindow = (raw.context_window as number | undefined) ?? 65_536;
	const maxThreshold = contextWindow - MIN_COMPACTION_RESERVE;
	const media = (raw.media ?? {}) as Raw;
	const vision = (raw.vision ?? {}) as Raw;
	const groupPeerId = normalizePeerId(String(raw.group_peer_id ?? ""));
	if (!Number.isFinite(groupPeerId)) errors.push("[config] group_peer_id: required (bare positive peer id)");

	const bots: BotConfig[] = rawBots.map((bot) => {
		const id = bot.id as string;
		const setting = <T>(key: keyof SharedConfigInput, fallback: T): T => (bot[key] ?? raw[key] ?? fallback) as T;
		const botProvider = str(bot.provider);
		const provider = botProvider ?? rootProvider ?? "";
		const model = str(bot.model) ?? (botProvider && botProvider !== rootProvider ? "" : (rootModel ?? ""));
		if (!identityOnly && !provider)
			errors.push(`[config] bot "${id}" has no provider; select one in config or Pi /model`);
		if (!identityOnly && !model)
			errors.push(
				`[config] bot "${id}" selects provider "${provider}" without a model; select both in config or Pi /model`,
			);
		const compactionThreshold = setting("compaction_threshold", 32_768);
		if (compactionThreshold > maxThreshold)
			errors.push(
				`[config] bot "${id}" compaction_threshold ${compactionThreshold}: effective trigger is capped at ${maxThreshold} (context_window ${contextWindow} minus ${MIN_COMPACTION_RESERVE} reserve); use a value <= ${maxThreshold}`,
			);
		const tools = (bot.tools ?? {}) as Raw;
		return {
			id,
			name: str(bot.name) || id,
			token: identityOnly ? "" : (env[bot.token_env as string] ?? ""),
			personaPath: resolvePath(rootDir, bot.persona_path as string),
			routingP: (bot.routing_p as number | undefined) ?? 0,
			samplingCooldownMs: setting("sampling_cooldown_ms", 2000),
			provider,
			model,
			reasoningEffort: setting<ThinkingLevel>("reasoning_effort", "off"),
			compactionThreshold,
			compactionKeepRecent: setting("compaction_keep_recent", 1),
			compactionModel: canonicalPiModelReference(setting("compaction_model", DEFAULT_COMPACTION_MODEL))!,
			cacheRetention: setting<CacheRetention>("cache_retention", "short"),
			contextImageBudgetBytes: setting("context_image_budget_bytes", 10_000_000),
			providerTimeoutMs: setting("provider_timeout_ms", 300_000),
			providerRetries: setting("provider_retries", 2),
			maxSuffixTokens: setting("max_suffix_tokens", 12_000),
			maxMessageTokens: setting("max_message_tokens", 4_096),
			tools: { send: tools.send !== false, search: tools.search === true, runJs: tools.run_js === true },
			stickerSets: [...((bot.sticker_sets as string[] | undefined) ?? [])],
		};
	});
	const tinyfishKeyEnv = str(raw.tinyfish_key_env) ?? "tiny_fish_api_key";
	const tinyfishApiKey = env[tinyfishKeyEnv] ?? "";
	if (!identityOnly && !tinyfishApiKey && bots.some((bot) => bot.tools.search))
		errors.push(
			`[config] tinyfish_key_env "${tinyfishKeyEnv}": env key "${tinyfishKeyEnv}" is empty or missing in .env`,
		);
	if (errors.length > 0) throw new ConfigError(errors);

	const dataDir = join(rootDir, "data");
	return {
		dataDir,
		dbPath: typeof raw.db_path === "string" ? resolvePath(rootDir, raw.db_path) : join(dataDir, "agent.db"),
		groupPeerId,
		groupChatId: Number(`-100${groupPeerId}`),
		bots,
		tinyfishApiKey,
		auxiliaryVisualModel: canonicalPiModelReference(
			(raw.auxiliary_visual_model as string | undefined) ?? DEFAULT_AUXILIARY_VISUAL_MODEL,
		)!,
		vision: {
			enabled: vision.enabled === true,
			foregroundMediaLimit: (vision.foreground_media_limit as number | undefined) ?? 2,
			concurrency: (vision.concurrency as number | undefined) ?? 2,
		},
		contextWindow,
		media: {
			mode: media.mode === "context" ? "context" : "vision",
			maxImagesPerTurn: (media.max_images_per_turn as number | undefined) ?? 4,
			downloadConcurrency: (media.download_concurrency as number | undefined) ?? 2,
		},
		retention: {
			telemetryDays: (raw.telemetry_retention_days as number | undefined) ?? 90,
			rawUpdateDays: (raw.raw_update_retention_days as number | undefined) ?? 30,
			messageEventDays: (raw.message_event_retention_days as number | undefined) ?? 365,
		},
		routerSecret: env[str(raw.router_secret_env) ?? "router_secret"] || null,
		telegramAdmins: ((raw.telegram_admins as unknown[] | undefined) ?? []).map(
			(value) => normalizeTelegramAdmin(value)!,
		),
	};
}
