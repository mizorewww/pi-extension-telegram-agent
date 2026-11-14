import {
	createAgentSessionServices,
	getAgentDir,
	type ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";

export type PiModelDefaults = ReturnType<typeof loadPiModelDefaults>;

/** Read Pi's merged global/project defaults without copying or exposing credential data. */
export function loadPiModelDefaults(projectRoot: string, agentDir = getAgentDir()) {
	const settings = SettingsManager.create(projectRoot, agentDir);
	const loadErrors = settings.drainErrors();
	if (loadErrors.length > 0) {
		throw new Error(
			`Pi settings unavailable (${[...new Set(loadErrors.map((error) => error.scope))].join(",")}). Fix Pi settings, then restart.`,
		);
	}
	return { provider: settings.getDefaultProvider(), model: settings.getDefaultModel() };
}

/** The subset of Pi's ModelRuntime the daemon reads; Pi always provides all three. */
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

export class PiModelConfigurationError extends Error {
	readonly category: PiModelConfigurationCategory;
	constructor(category: PiModelConfigurationCategory, provider: string, model: string, purpose?: string) {
		super(
			`Pi model configuration invalid (${category}): ${provider}/${model}${purpose ? ` (${purpose})` : ""}. Check Pi /login and /model, then restart.`,
		);
		this.name = "PiModelConfigurationError";
		this.category = category;
	}
}

/** Pi owns catalog/auth; startup rejects unsupported configuration before polling Telegram. */
export function assertBotModelConfigured(bot: PiModelSelection, runtime: ConfigurableModelRuntime): void {
	const model = runtime.getModel(bot.provider, bot.model);
	const fail = (category: PiModelConfigurationCategory): never => {
		throw new PiModelConfigurationError(category, bot.provider, bot.model, bot.purpose);
	};
	if (!model) fail("unknown_model");
	if (bot.thinkingLevel != null && !getSupportedThinkingLevels(model!).includes(bot.thinkingLevel)) {
		fail("unsupported_reasoning_effort");
	}
	if (!runtime.hasConfiguredAuth(bot.provider)) fail("unauthenticated_provider");
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
	} catch {
		// Provider extensions can throw credential-bearing text; expose only the fixed category.
		throw new PiModelConfigurationError("runtime_unavailable", "<startup>", "<startup>");
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
	| "provider_request_too_large"
	| "provider_request_failed";

/** Collapse untrusted provider/OAuth error text into a bounded non-secret category. */
export function classifyPiProviderFailure(error: unknown): PiProviderFailureCategory {
	if (error instanceof PiModelConfigurationError) return error.category;
	if (error instanceof DOMException) {
		if (error.name === "TimeoutError") return "provider_timeout";
		if (error.name === "AbortError") return "provider_aborted";
	}
	const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	if (/oauth|refresh/i.test(text)) return "oauth_refresh_failed";
	if (/\bauth\b|unauthori[sz]ed|forbidden|\b401\b|\b403\b/i.test(text)) return "provider_auth_failed";
	if (/timeout|timed out/i.test(text)) return "provider_timeout";
	if (/abort/i.test(text)) return "provider_aborted";
	if (/request_too_large/i.test(text)) return "provider_request_too_large";
	return "provider_request_failed";
}
