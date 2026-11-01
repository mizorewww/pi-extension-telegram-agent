// The only configuration source: trusted `telegram.config.ts` (project root) plus `.env`
// (`key: value`) for Telegram/TinyFish/router secrets. LLM credentials stay in Pi's auth store.
// Validation collects every error and throws one ConfigError listing them all.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createJiti } from "jiti";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { BoxConfig } from "./sandbox/box.ts";
import type { TasksConfig } from "./tasks/manager.ts";
import { isPiThinkingLevel, loadPiModelDefaults, type PiModelDefaults } from "./agent/model-settings.ts";
import {
	canonicalPiModelReference,
	DEFAULT_AUXILIARY_VISUAL_MODEL,
	DEFAULT_COMPACTION_MODEL,
} from "./agent/model-ref.ts";

/** Pi keeps this much room for the next response; compaction_threshold must leave it free. */
export const MIN_COMPACTION_RESERVE = 16_384;

type CacheRetention = "none" | "short" | "long";
/** "off": placeholders only; "describe": a vision model describes media as text; "context": images go to the main model. */
export type MediaMode = "off" | "describe" | "context" | "hybrid";

/** Modes that attach image blocks for the chat model, which must then accept image input. */
export function mediaNeedsImageInput(mode: MediaMode): boolean {
	return mode === "context" || mode === "hybrid";
}

/** Modes whose context is text plus vision descriptions from media.vision_model. */
export function mediaUsesVision(mode: MediaMode): boolean {
	return mode === "describe" || mode === "hybrid";
}

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
	/** Pause after a spontaneous (probability) reply before the bot may join in again. */
	cooldown_ms?: number;
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
	tools?: { send?: boolean; search?: boolean; codemode?: boolean; sandbox?: boolean; tasks?: boolean };
	sticker_sets?: readonly string[];
}

/** Trusted local deployment config. Secret values belong in .env, never here. */
export interface TelegramConfigInput extends SharedConfigInput {
	group_peer_id: string | number;
	/** Cap on the main model's effective context window; compaction_threshold defaults to half of it. */
	context_window?: number;
	media?: {
		mode?: MediaMode;
		/** "describe" only: the vision model as provider/model:effort. */
		vision_model?: string;
		/** Media per turn: described ("describe", default 2) or attached as images ("context", default 4). */
		max_per_turn?: number;
		/** Parallel media jobs: vision calls ("describe") or downloads/frame extraction ("context"). */
		concurrency?: number;
	};
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

/** Numeric Telegram user id; usernames can change hands, ids cannot. */
export type TelegramAdmin = number;

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
	/** viewImage is not a toggle: it follows media.mode "hybrid". */
	tools: { send: boolean; search: boolean; codemode: boolean; sandbox: boolean; tasks: boolean; viewImage: boolean };
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
	contextWindow: number;
	media: { mode: MediaMode; visionModel: string; maxPerTurn: number; concurrency: number };
	/** Work box settings; null when the deployment has no sandbox section. */
	sandbox: BoxConfig | null;
	/** Background task workflows; null when the deployment has no tasks section. */
	tasks: (TasksConfig & { memory: string; cpus: number }) | null;
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
	cooldown_ms: range(0, MAX),
	provider_timeout_ms: range(1_000, 3_600_000),
	provider_retries: range(0, 5, true),
	context_image_budget_bytes: range(100_000, 100_000_000),
	max_suffix_tokens: range(512, MAX),
	max_message_tokens: range(128, MAX),
};
const ROOT_RULES: Record<string, Rule> = {
	...SHARED_RULES,
	context_window: range(MIN_COMPACTION_RESERVE * 2, 10_000_000, true),
	telemetry_retention_days: range(1, 3650),
	raw_update_retention_days: range(1, 3650),
	message_event_retention_days: range(1, 3650),
};
const BOT_RULES: Record<string, Rule> = { ...SHARED_RULES, routing_p: range(0, 1) };
const MEDIA_RULES: Record<string, Rule> = {
	mode: oneOf("off", "describe", "context", "hybrid"),
	vision_model: modelRef,
	max_per_turn: range(0, 16, true),
	concurrency: range(1, 16, true),
};
const SANDBOX_RULES: Record<string, Rule> = {
	image: nonEmpty,
	docker_host: nonEmpty,
	memory: nonEmpty,
	cpus: range(0.1, 64),
	pids: range(16, 65_536, true),
	network: boolean,
};
const TASKS_RULES: Record<string, Rule> = {
	max_running: range(1, 8, true),
	timeout_minutes: range(1, 24 * 60, true),
	memory: nonEmpty,
	cpus: range(0.1, 64),
};
const TOOL_RULES: Record<string, Rule> = {
	send: boolean,
	search: boolean,
	codemode: boolean,
	sandbox: boolean,
	tasks: boolean,
};
const ROOT_KEYS = new Set([
	...Object.keys(ROOT_RULES),
	"group_peer_id",
	"media",
	"sandbox",
	"tasks",
	"telegram_admins",
	"bots",
]);
const BOT_KEYS = new Set([
	...Object.keys(BOT_RULES),
	"id",
	"name",
	"token_env",
	"persona_path",
	"tools",
	"sticker_sets",
]);
/** Removed or renamed fields fail loudly with their replacement instead of being ignored. */
const REPLACED_KEYS: Record<string, string> = {
	sampling_cooldown_ms: "renamed to cooldown_ms",
	auxiliary_visual_model: "moved to media.vision_model",
	vision: 'merged into media: use media.mode "describe" with media.max_per_turn / media.concurrency',
	db_path: "removed; the database is always data/agent.db",
	router_secret_env: "removed; the .env key is always router_secret",
	tinyfish_key_env: "removed; the .env key is always tiny_fish_api_key",
	max_images_per_turn: "renamed to max_per_turn",
	download_concurrency: "renamed to concurrency",
};

/** Reject keys a section does not define; a typo must never silently fall back to a default. */
function checkKeys(errors: string[], at: string, source: Raw, known: ReadonlySet<string>): void {
	for (const key of Object.keys(source)) {
		if (known.has(key)) continue;
		const hint = REPLACED_KEYS[key];
		errors.push(`[config] ${at}${key}: ${hint ?? "unknown field"}`);
	}
}

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
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
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
	checkKeys(errors, "", raw, ROOT_KEYS);
	checkFields(errors, "", raw, ROOT_RULES);
	if (raw.media !== undefined) {
		if (isObject(raw.media)) {
			checkKeys(errors, "media.", raw.media, new Set(Object.keys(MEDIA_RULES)));
			checkFields(errors, "media.", raw.media, MEDIA_RULES);
		} else errors.push("[config] media: expected object");
	}
	if (raw.tasks !== undefined) {
		if (isObject(raw.tasks)) {
			checkKeys(errors, "tasks.", raw.tasks, new Set([...Object.keys(TASKS_RULES), "workflows"]));
			checkFields(errors, "tasks.", raw.tasks, TASKS_RULES);
			const workflows = raw.tasks.workflows;
			if (!isObject(workflows) || Object.keys(workflows).length === 0)
				errors.push("[config] tasks.workflows: expected { name: directory } with at least one workflow");
			else
				for (const [name, dir] of Object.entries(workflows)) {
					if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name))
						errors.push(`[config] tasks.workflows.${name}: names are lowercase letters, digits, - or _`);
					if (typeof dir !== "string" || !existsSync(join(resolvePath(rootDir, dir), ".pi")))
						errors.push(`[config] tasks.workflows.${name}: expected a directory containing .pi`);
				}
			if (raw.sandbox === undefined) errors.push("[config] tasks: requires a top-level sandbox section");
		} else errors.push("[config] tasks: expected object");
	}
	if (raw.sandbox !== undefined) {
		if (isObject(raw.sandbox)) {
			checkKeys(errors, "sandbox.", raw.sandbox, new Set(Object.keys(SANDBOX_RULES)));
			checkFields(errors, "sandbox.", raw.sandbox, SANDBOX_RULES);
		} else errors.push("[config] sandbox: expected object");
	}
	if (raw.group_peer_id !== undefined && !Number.isFinite(normalizePeerId(String(raw.group_peer_id))))
		errors.push(
			`[config] group_peer_id: expected a bare positive peer id (e.g. 4402809405, or -1004402809405), got ${JSON.stringify(raw.group_peer_id)}`,
		);
	if (raw.telegram_admins !== undefined) {
		if (!Array.isArray(raw.telegram_admins)) {
			errors.push("[config] telegram_admins: expected an array of numeric Telegram user ids");
		} else {
			const seen = new Set<TelegramAdmin>();
			raw.telegram_admins.forEach((value, index) => {
				const admin = normalizeTelegramAdmin(value);
				if (admin == null)
					errors.push(
						`[config] telegram_admins[${index}]: expected a numeric Telegram user id (usernames can change hands), got ${JSON.stringify(value)}`,
					);
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
		checkKeys(errors, `${at}.`, bot, BOT_KEYS);
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
			if (isObject(bot.tools)) {
				checkKeys(errors, `${at}.tools.`, bot.tools, new Set(Object.keys(TOOL_RULES)));
				checkFields(errors, `${at}.tools.`, bot.tools, TOOL_RULES);
			} else errors.push(`[config] ${at}.tools: expected object {send?, search?, codemode?, sandbox?}`);
			const tools = isObject(bot.tools) ? bot.tools : {};
			if (tools.sandbox === true && tools.codemode !== true)
				errors.push(`[config] ${at}.tools.sandbox: requires tools.codemode (sandbox tools are called from scripts)`);
			if (tools.tasks === true && (tools.sandbox !== true || raw.tasks === undefined))
				errors.push(`[config] ${at}.tools.tasks: requires tools.sandbox and a top-level tasks section`);
			if (tools.sandbox === true && raw.sandbox === undefined)
				errors.push(`[config] ${at}.tools.sandbox: requires a top-level sandbox section`);
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
	const mediaMode = (media.mode as MediaMode | undefined) ?? "off";
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
		const compactionThreshold = setting("compaction_threshold", Math.floor(contextWindow / 2));
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
			samplingCooldownMs: setting("cooldown_ms", 2000),
			provider,
			model,
			reasoningEffort: setting<ThinkingLevel>("reasoning_effort", "off"),
			compactionThreshold,
			compactionKeepRecent: setting("compaction_keep_recent", 20_000),
			compactionModel: canonicalPiModelReference(setting("compaction_model", DEFAULT_COMPACTION_MODEL))!,
			cacheRetention: setting<CacheRetention>("cache_retention", "short"),
			contextImageBudgetBytes: setting("context_image_budget_bytes", 10_000_000),
			providerTimeoutMs: setting("provider_timeout_ms", 300_000),
			providerRetries: setting("provider_retries", 2),
			maxSuffixTokens: setting("max_suffix_tokens", 12_000),
			maxMessageTokens: setting("max_message_tokens", 4_096),
			tools: {
				send: tools.send !== false,
				search: tools.search === true,
				codemode: tools.codemode === true,
				sandbox: tools.sandbox === true,
				tasks: tools.tasks === true,
				viewImage: mediaMode === "hybrid",
			},
			stickerSets: [...((bot.sticker_sets as string[] | undefined) ?? [])],
		};
	});
	const tinyfishApiKey = env.tiny_fish_api_key ?? "";
	if (!identityOnly && !tinyfishApiKey && bots.some((bot) => bot.tools.search))
		errors.push('[config] tools.search: needs "tiny_fish_api_key" in .env');
	if (errors.length > 0) throw new ConfigError(errors);

	const dataDir = join(rootDir, "data");
	return {
		dataDir,
		dbPath: join(dataDir, "agent.db"),
		groupPeerId,
		groupChatId: Number(`-100${groupPeerId}`),
		bots,
		tinyfishApiKey,
		contextWindow,
		media: {
			mode: mediaMode,
			visionModel: canonicalPiModelReference(
				(media.vision_model as string | undefined) ?? DEFAULT_AUXILIARY_VISUAL_MODEL,
			)!,
			maxPerTurn: (media.max_per_turn as number | undefined) ?? (mediaMode === "context" ? 4 : 2),
			concurrency: (media.concurrency as number | undefined) ?? 2,
		},
		sandbox: raw.sandbox === undefined ? null : sandboxConfig(raw.sandbox as Raw),
		tasks: raw.tasks === undefined ? null : tasksConfig(rootDir, raw.tasks as Raw),
		retention: {
			telemetryDays: (raw.telemetry_retention_days as number | undefined) ?? 90,
			rawUpdateDays: (raw.raw_update_retention_days as number | undefined) ?? 30,
			messageEventDays: (raw.message_event_retention_days as number | undefined) ?? 365,
		},
		routerSecret: env.router_secret || null,
		telegramAdmins: ((raw.telegram_admins as unknown[] | undefined) ?? []).map(
			(value) => normalizeTelegramAdmin(value)!,
		),
	};
}

function sandboxConfig(raw: Raw): BoxConfig {
	return {
		image: (raw.image as string | undefined) ?? "tg-box:2",
		dockerHost: (raw.docker_host as string | undefined) ?? "unix:///run/tgbox/docker.sock",
		memory: (raw.memory as string | undefined) ?? "1g",
		cpus: (raw.cpus as number | undefined) ?? 2,
		pids: (raw.pids as number | undefined) ?? 256,
		network: (raw.network as boolean | undefined) ?? true,
	};
}

function tasksConfig(rootDir: string, raw: Raw): TasksConfig & { memory: string; cpus: number } {
	return {
		workflows: Object.fromEntries(
			Object.entries(raw.workflows as Record<string, string>).map(([name, dir]) => [name, resolvePath(rootDir, dir)]),
		),
		maxRunning: (raw.max_running as number | undefined) ?? 2,
		timeoutMs: ((raw.timeout_minutes as number | undefined) ?? 45) * 60_000,
		memory: (raw.memory as string | undefined) ?? "3g",
		cpus: (raw.cpus as number | undefined) ?? 2,
	};
}
