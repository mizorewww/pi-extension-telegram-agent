import {
	createAgentSessionServices,
	getAgentDir,
	type ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

/** The subset of Pi's ModelRuntime the daemon reads; Pi 0.86.0 always provides all three. */
export type ConfigurableModelRuntime = Pick<ModelRuntime, "getModel" | "hasConfiguredAuth" | "getProviderAuthStatus">;

export type PiModelConfigurationCategory =
	| "runtime_unavailable"
	| "unknown_model"
	| "unauthenticated_provider"
	| "unsupported_reasoning_effort"
	| "image_input_unsupported";

export interface PiModelSelection {
	provider: string;
	model: string;
	thinkingLevel?: ModelThinkingLevel;
	purpose?: string;
}

export interface ModelReasoningCapabilities {
	provider: string;
	model: string;
	requested: ModelThinkingLevel;
	effective: ModelThinkingLevel;
	supported: ModelThinkingLevel[];
	valid: boolean;
}

export class PiModelConfigurationError extends Error {
	constructor(
		readonly category: PiModelConfigurationCategory,
		readonly provider: string,
		readonly model: string,
		readonly reasoning?: ModelReasoningCapabilities,
		readonly purpose?: string,
		detail?: string,
	) {
		const target = `${provider}/${model}${purpose ? ` (${purpose})` : ""}`;
		const base = reasoning
			? `Pi model configuration invalid (${category}): ${target} requested ${reasoning.requested}; supported: ${reasoning.supported.join(", ")}. Use Pi /model, then restart.`
			: `Pi model unavailable (${category}): ${target}. Use Pi /login and /model, then restart.`;
		super(detail ? `${base} Cause: ${detail}` : base);
		this.name = "PiModelConfigurationError";
	}
}

/** Read Pi's model-specific reasoning contract without sending a provider request. */
export function inspectModelReasoning(model: Model<Api>, requested: ModelThinkingLevel): ModelReasoningCapabilities {
	const supported = getSupportedThinkingLevels(model);
	const effective = clampThinkingLevel(model, requested);
	return {
		provider: model.provider,
		model: model.id,
		requested,
		effective,
		supported,
		valid: supported.includes(requested),
	};
}

/** Validate a Pi-owned model/auth pair without reading or injecting credential material. */
export function assertBotModelConfigured(bot: PiModelSelection, runtime: ConfigurableModelRuntime): void {
	const model = runtime.getModel(bot.provider, bot.model);
	if (!model) {
		throw new PiModelConfigurationError("unknown_model", bot.provider, bot.model, undefined, bot.purpose);
	}
	if (bot.thinkingLevel != null) {
		const reasoning = inspectModelReasoning(model, bot.thinkingLevel);
		if (!reasoning.valid) {
			throw new PiModelConfigurationError(
				"unsupported_reasoning_effort",
				bot.provider,
				bot.model,
				reasoning,
				bot.purpose,
			);
		}
	}
	if (!runtime.hasConfiguredAuth(bot.provider)) {
		throw new PiModelConfigurationError("unauthenticated_provider", bot.provider, bot.model, undefined, bot.purpose);
	}
}

/**
 * Build the daemon's shared model runtime through Pi's resource loader so user-installed
 * provider extensions participate in the same catalog/auth/cost contract as interactive Pi.
 * Project extensions stay excluded: bot sessions own a fixed cache-visible extension set.
 */
export async function createInstalledPiModelRuntime(
	options: { cwd?: string; agentDir?: string } = {},
): Promise<ModelRuntime> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager,
		resourceLoaderOptions: {
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});
	return services.modelRuntime;
}

/** Create exactly one Pi-owned runtime and preflight every configured bot before Telegram starts. */
export async function createSharedModelRuntime(
	bots: readonly PiModelSelection[],
	create: () => Promise<ModelRuntime> = () => createInstalledPiModelRuntime(),
): Promise<ModelRuntime> {
	let runtime: ModelRuntime;
	try {
		runtime = await create();
		const registered = new Set(runtime.getRegisteredProviderIds());
		const selectedExtensionProviders = [...new Set(bots.map((bot) => bot.provider))].filter((provider) =>
			registered.has(provider),
		);
		if (selectedExtensionProviders.length > 0) {
			await runtime.refresh({ allowNetwork: true, providers: selectedExtensionProviders });
		}
	} catch (error) {
		// Untrusted provider/extension failure text: attach only a bounded single-line message, never a stack.
		const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 200);
		throw new PiModelConfigurationError(
			"runtime_unavailable",
			"<startup>",
			"<startup>",
			undefined,
			undefined,
			detail || undefined,
		);
	}
	for (const bot of bots) assertBotModelConfigured(bot, runtime);
	return runtime;
}

export type PiAuthSource = "stored" | "environment" | "configured";

/** Return only Pi's fixed non-sensitive auth source category. */
export function piAuthSource(runtime: ConfigurableModelRuntime, provider: string): PiAuthSource {
	const status = runtime.getProviderAuthStatus(provider);
	if (status?.configured && (status.source === "stored" || status.source === "environment")) return status.source;
	return "configured";
}

export type PiProviderFailureCategory =
	| PiModelConfigurationCategory
	| "oauth_refresh_failed"
	| "provider_auth_failed"
	| "provider_timeout"
	| "provider_aborted"
	| "provider_request_failed";

/** Collapse untrusted provider/OAuth error text into a bounded non-secret category. */
export function classifyPiProviderFailure(error: unknown): PiProviderFailureCategory {
	if (error instanceof PiModelConfigurationError) return error.category;
	if (typeof DOMException !== "undefined" && error instanceof DOMException) {
		if (error.name === "TimeoutError") return "provider_timeout";
		if (error.name === "AbortError") return "provider_aborted";
	}
	const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	if (/oauth|refresh/i.test(text)) return "oauth_refresh_failed";
	if (/\bauth\b|unauthori[sz]ed|forbidden|\b401\b|\b403\b/i.test(text)) return "provider_auth_failed";
	if (/timeout|timed out/i.test(text)) return "provider_timeout";
	if (/abort/i.test(text)) return "provider_aborted";
	return "provider_request_failed";
}
