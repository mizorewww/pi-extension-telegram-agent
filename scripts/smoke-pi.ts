// Opt-in real provider smoke using the production Models and Durable harness. Never sends Telegram.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { contentText } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.ts";
import { createSharedModelRuntime } from "../src/agent/model-runtime.ts";
import { guardModels } from "../src/agent/provider-guard.ts";
import { selectConfiguredBot } from "./bot-selection.ts";
const config = loadConfig(process.cwd());
const bot = selectConfiguredBot(config.bots, process.argv.slice(2));
const models = guardModels(await createSharedModelRuntime([bot]), () => ({ timeoutMs: bot.providerTimeoutMs }));
const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
try {
	const conversation = await harness.root(context, {
		agent: { model: { provider: bot.provider, modelId: bot.model }, thinkingLevel: bot.reasoningEffort },
	});
	const settled = await (
		await conversation.submit({ type: "input", content: "What is 2+2? Answer with just the number." }, context)
	).wait(context);
	if (settled.status !== "done" || settled.type !== "input")
		throw new Error("provider did not complete the smoke request");
	const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	if (contentText(entry?.model?.[0]?.content ?? []).trim() !== "4")
		throw new Error("provider returned an unexpected answer");
	console.log("PASS: native Pi provider request completed");
} finally {
	await harness.close(context);
}
