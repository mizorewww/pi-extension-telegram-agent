// The only configuration source: trusted `telegram.config.ts` (project root) plus `.env`
// (`key: value`) for Telegram/TinyFish/router secrets. LLM credentials stay in Pi's auth store.
// Validation collects every error and throws one ConfigError listing them all.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createJiti } from "jiti";
import { Type, type Static } from "typebox";
import { compile } from "@earendil-works/pi-schema";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { BoxConfig } from "./sandbox/box.ts";
import type { TasksConfig } from "./tasks/manager.ts";
import { loadPiModelDefaults, type PiModelDefaults } from "./agent/model-settings.ts";
import {
	canonicalPiModelReference,
	DEFAULT_AUXILIARY_VISUAL_MODEL,
	DEFAULT_COMPACTION_MODEL,
} from "./agent/model-ref.ts";

/** Pi keeps this much room for the next response; compaction_threshold must leave it free. */
export const MIN_COMPACTION_RESERVE = 16_384;

type CacheRetention = "none" | "short" | "long";
/**
 * "off": placeholders only; "hybrid": a vision model describes media as text and the main model
 * views one on demand with view_image (so it must accept image input).
 */
export type MediaMode = "off" | "hybrid";

const text = Type.String({ pattern: "\\S" });
const positive = Type.Number({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const reasoning = Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const shared = Type.Partial(
	Type.Object({
		provider: text,
		model: text,
		reasoning_effort: reasoning,
		compaction_model: text,
		cache_retention: Type.Union([Type.Literal("none"), Type.Literal("short"), Type.Literal("long")]),
		compaction_threshold: positive,
		compaction_keep_recent: positive,
		cooldown_ms: Type.Number({ minimum: 0 }),
		provider_timeout_ms: Type.Number({ minimum: 1000, maximum: 3_600_000 }),
		provider_retries: Type.Integer({ minimum: 0, maximum: 5 }),
		context_image_budget_bytes: Type.Number({ minimum: 100_000, maximum: 100_000_000 }),
		max_suffix_tokens: Type.Number({ minimum: 512 }),
		max_message_tokens: Type.Number({ minimum: 128 }),
	}),
);
const botSchema = Type.Object(
	{
		...shared.properties,
		id: Type.String({ pattern: "^[A-Za-z0-9_-]+$" }),
		name: Type.Optional(Type.String()),
		token_env: text,
		persona_path: text,
		routing_p: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		tools: Type.Optional(
			Type.Partial(
				Type.Object(
					{
						send: Type.Boolean(),
						search: Type.Boolean(),
						codemode: Type.Boolean(),
						sandbox: Type.Boolean(),
						tasks: Type.Boolean(),
					},
					{ additionalProperties: false },
				),
			),
		),
		sticker_sets: Type.Optional(Type.Array(text)),
	},
	{ additionalProperties: false },
);
const configSchema = Type.Object(
	{
		...shared.properties,
		group_peer_id: Type.Union([Type.String(), Type.Number()]),
		context_window: Type.Optional(Type.Integer({ minimum: MIN_COMPACTION_RESERVE * 2, maximum: 10_000_000 })),
		media: Type.Optional(
			Type.Partial(
				Type.Object(
					{
						mode: Type.Union([Type.Literal("off"), Type.Literal("hybrid")]),
						vision_model: text,
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
					memory: Type.Optional(text),
					cpus: Type.Optional(Type.Number({ minimum: 0.1, maximum: 64 })),
				},
				{ additionalProperties: false },
			),
		),
		telemetry_retention_days: Type.Optional(Type.Number({ minimum: 1, maximum: 3650 })),
		raw_update_retention_days: Type.Optional(Type.Number({ minimum: 1, maximum: 3650 })),
		message_event_retention_days: Type.Optional(Type.Number({ minimum: 1, maximum: 3650 })),
		telegram_admins: Type.Optional(
			Type.Array(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), { uniqueItems: true }),
		),
		bots: Type.Array(botSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);
const configValidator = compile(configSchema);
type SharedConfigInput = Static<typeof shared>;
export type TelegramBotConfigInput = Static<typeof botSchema>;
export type TelegramConfigInput = Static<typeof configSchema>;
export type TelegramAdmin = number;

/** Editor types and runtime validation derive from the same schema. */
export function defineConfig<const T extends TelegramConfigInput>(config: T): T {
	return config;
}

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

export function defaultConfigPath(rootDir: string): string {
	return join(rootDir, "telegram.config.ts");
}

function loadConfigSource(path: string): TelegramConfigInput {
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
	const refs = [raw.compaction_model, raw.media?.vision_model, ...raw.bots.map((bot) => bot.compaction_model)];
	for (const ref of refs)
		if (ref != null && !canonicalPiModelReference(ref)) errors.push(`[config] invalid model reference: ${ref}`);
	const ids = new Set<string>();
	for (const bot of raw.bots) {
		if (ids.has(bot.id)) errors.push(`[config] duplicate bot id: ${bot.id}`);
		ids.add(bot.id);
		if (!identityOnly && !env[bot.token_env]) errors.push(`[config] bot ${bot.id}: missing env key ${bot.token_env}`);
		const path = resolvePath(rootDir, bot.persona_path);
		if (!existsSync(path) || !statSync(path).isFile())
			errors.push(`[config] bot ${bot.id}: persona must be a readable file`);
		if (bot.tools?.sandbox && (!bot.tools.codemode || !raw.sandbox))
			errors.push(`[config] bot ${bot.id}: sandbox needs codemode and sandbox configuration`);
		if (bot.tools?.tasks && (!bot.tools.sandbox || !raw.tasks))
			errors.push(`[config] bot ${bot.id}: tasks need sandbox and tasks configuration`);
	}
	if (raw.bots.reduce((sum, bot) => sum + (bot.routing_p ?? 0), 0) > 1)
		errors.push("[config] routing probabilities must sum to <= 1");
	if (raw.tasks) {
		if (!raw.sandbox) errors.push("[config] tasks require sandbox configuration");
		for (const [name, dir] of Object.entries(raw.tasks.workflows))
			if (!existsSync(join(resolvePath(rootDir, dir), ".pi")))
				errors.push(`[config] workflow ${name}: directory must contain .pi`);
	}
	return errors;
}

export interface LoadConfigOptions {
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

export function loadConfig(rootDir: string, options: LoadConfigOptions = {}): AppConfig {
	const identityOnly = options.identityOnly === true;
	const env = identityOnly ? {} : { ...parseEnvFile(join(rootDir, ".env")), ...process.env };
	const raw = loadConfigSource(options.configPath ?? defaultConfigPath(rootDir));
	const errors = validate(rootDir, raw, env, identityOnly);
	if (errors.length > 0) throw new ConfigError(errors);

	const rawBots = raw.bots;
	const str = (value?: string) => value?.trim();
	const needsPiDefaults =
		!identityOnly &&
		rawBots.some((bot) => str(bot.provider ?? raw.provider) == null || str(bot.model ?? raw.model) == null);
	const pi =
		options.piModelDefaults ??
		(needsPiDefaults ? loadPiModelDefaults(rootDir) : { provider: undefined, model: undefined });
	const rootProvider = str(raw.provider) ?? pi.provider;
	// A deployment-level provider switch without a model must not inherit Pi's model for another provider.
	const rootModel = str(raw.model) ?? (str(raw.provider) && str(raw.provider) !== pi.provider ? undefined : pi.model);
	if (needsPiDefaults && !rootProvider && !rootModel)
		errors.push(
			"[config] Pi default provider/model is missing; run Pi /login and select both with /model, or set them explicitly in telegram.config.ts",
		);

	const contextWindow = raw.context_window ?? 65_536;
	const maxThreshold = contextWindow - MIN_COMPACTION_RESERVE;
	const media = raw.media ?? {};
	const mediaMode = media.mode ?? "off";
	const groupPeerId = normalizePeerId(String(raw.group_peer_id ?? ""));
	if (!Number.isFinite(groupPeerId)) errors.push("[config] group_peer_id: required (bare positive peer id)");

	const bots: BotConfig[] = rawBots.map((bot) => {
		const id = bot.id;
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
		const tools = bot.tools ?? {};
		return {
			id,
			name: str(bot.name) || id,
			token: identityOnly ? "" : (env[bot.token_env] ?? ""),
			personaPath: resolvePath(rootDir, bot.persona_path),
			routingP: bot.routing_p ?? 0,
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
			stickerSets: [...(bot.sticker_sets ?? [])],
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
			visionModel: canonicalPiModelReference(media.vision_model ?? DEFAULT_AUXILIARY_VISUAL_MODEL)!,
			maxPerTurn: media.max_per_turn ?? 2,
			concurrency: media.concurrency ?? 2,
		},
		sandbox: raw.sandbox === undefined ? null : sandboxConfig(raw.sandbox),
		tasks: raw.tasks === undefined ? null : tasksConfig(rootDir, raw.tasks),
		retention: {
			telemetryDays: raw.telemetry_retention_days ?? 90,
			rawUpdateDays: raw.raw_update_retention_days ?? 30,
			messageEventDays: raw.message_event_retention_days ?? 365,
		},
		routerSecret: env.router_secret || null,
		telegramAdmins: raw.telegram_admins ?? [],
	};
}

function sandboxConfig(raw: NonNullable<TelegramConfigInput["sandbox"]>): BoxConfig {
	return {
		image: raw.image ?? "tg-box:2",
		dockerHost: raw.docker_host ?? "unix:///run/tgbox/docker.sock",
		memory: raw.memory ?? "1g",
		cpus: raw.cpus ?? 2,
		pids: raw.pids ?? 256,
		network: raw.network ?? true,
	};
}

function tasksConfig(
	rootDir: string,
	raw: NonNullable<TelegramConfigInput["tasks"]>,
): TasksConfig & { memory: string; cpus: number } {
	return {
		workflows: Object.fromEntries(
			Object.entries(raw.workflows).map(([name, dir]) => [name, resolvePath(rootDir, dir)]),
		),
		maxRunning: raw.max_running ?? 2,
		timeoutMs: (raw.timeout_minutes ?? 45) * 60_000,
		memory: raw.memory ?? "3g",
		cpus: raw.cpus ?? 2,
	};
}
