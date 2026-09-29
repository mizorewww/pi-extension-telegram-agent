// Opt-in provider smoke. One synthetic prompt, no Telegram sends or persistent session.
// Usage: bun run scripts/smoke-pi.ts --bot <id>
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { contentText } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.ts";
import { createSharedModelRuntime } from "../src/agent/model-runtime.ts";
import { guardProviderCall, providerRetryPolicy } from "../src/agent/provider-guard.ts";
import { selectConfiguredBot } from "./bot-selection.ts";

/** Pi resolves prompt() even on provider failure; require a fresh, complete, correct answer. */
export async function runSmokePrompt(session: Pick<AgentSession, "prompt" | "messages">) {
	const before = session.messages.length;
	await session.prompt("What is 2+2? Answer with just the number.");
	const result = session.messages.slice(before).at(-1);
	if (result?.role !== "assistant" || result.stopReason !== "stop" || contentText(result.content).trim() !== "4") {
		throw new Error("SMOKE FAILED: expected a completed assistant response containing only 4.");
	}
	return result;
}

async function main(): Promise<void> {
	const config = loadConfig(process.cwd());
	const bot = selectConfiguredBot(config.bots, process.argv.slice(2));
	const modelRuntime = await createSharedModelRuntime([
		{ provider: bot.provider, model: bot.model, thinkingLevel: bot.reasoningEffort },
	]);
	const model = modelRuntime.getModel(bot.provider, bot.model)!;
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: `${config.dataDir}/pi-smoke`,
		systemPrompt: "You are a concise assistant. Answer in one short sentence.",
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		model,
		thinkingLevel: bot.reasoningEffort,
		modelRuntime,
		sessionManager: SessionManager.inMemory(process.cwd()),
		settingsManager: SettingsManager.inMemory({
			cacheWarming: "off",
			compaction: { enabled: false },
			retry: { ...providerRetryPolicy(0), provider: { maxRetries: 0 } },
		}),
		resourceLoader: loader,
		noTools: "all",
	});
	const stream = session.agent.streamFunction;
	session.agent.streamFunction = (requestModel, context, options) =>
		guardProviderCall(
			(signal) => stream(requestModel, context, { ...options, signal, cacheRetention: bot.cacheRetention }),
			requestModel,
			options?.signal,
			{ timeoutMs: bot.providerTimeoutMs },
		);
	try {
		const result = await runSmokePrompt(session);
		console.log("SMOKE OK", JSON.stringify({ provider: bot.provider, model: bot.model, usage: result.usage }));
	} finally {
		await session.dispose();
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch {
		console.error("SMOKE FAILED: check model configuration, provider availability, and response validity.");
		process.exitCode = 1;
	}
}
