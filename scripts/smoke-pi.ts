// Smoke test: Bun runtime × Pi SDK × one configured provider/model.
// Creates a headless AgentSession, sends one prompt, prints reply + usage.
// Usage: bun run scripts/smoke-pi.ts --bot <id>
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import { createSharedModelRuntime } from "../src/agent/model-runtime.ts";
import { selectConfiguredBot } from "./bot-selection.ts";

const config = loadConfig(process.cwd());
const bot = selectConfiguredBot(config.bots, process.argv.slice(2));
const modelRuntime = await createSharedModelRuntime([bot]);
const model = modelRuntime.getModel(bot.provider, bot.model);
if (!model) throw new Error(`model not found: ${bot.provider}/${bot.model}`);

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
	settingsManager: SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } }),
	resourceLoader: loader,
	noTools: "all",
});

let thinking = "";
let text = "";
let usage: unknown = null;
session.subscribe((e) => {
	if (e.type === "message_update") {
		const ev = e.assistantMessageEvent;
		if (ev.type === "thinking_delta") thinking += ev.delta;
		if (ev.type === "text_delta") text += ev.delta;
	}
	if (e.type === "message_end" && e.message.role === "assistant") {
		usage = e.message.usage;
	}
});

await session.prompt("What is 2+2? Answer with just the number.");
console.log("TEXT:", text.trim());
console.log("THINKING (first 120):", thinking.slice(0, 120));
console.log("USAGE:", JSON.stringify(usage));
await session.dispose();
console.log("SMOKE OK");
process.exit(0);
