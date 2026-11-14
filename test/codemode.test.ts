// Security invariant: native code mode exposes no host/model APIs and only the conversation's callable tools.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { telegramCodemode } from "../src/agent/extensions/codemode.ts";

async function runScript(code: string) {
	const models = createModels();
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const registry = createRegistry();
	let sends = 0;
	registry.install(
		defineExtension({
			name: "fixture",
			tools: [
				defineTool({
					name: "send",
					description: "Simulate a send",
					parameters: obj({}),
					execute: async () => {
						sends++;
						return { output: [{ type: "text", text: "ok" }], control: { terminate: true } };
					},
				}),
				defineTool({
					name: "probe",
					description: "Return pong",
					parameters: obj({}),
					callers: ["tools"],
					execute: async () => ({ output: [{ type: "text", text: "pong" }] }),
				}),
				defineTool({
					name: "private",
					description: "Never callable by scripts",
					parameters: obj({}),
					callers: ["model"],
					execute: async () => {
						throw new Error("must not run");
					},
				}),
			],
		}),
	);
	registry.install(telegramCodemode());
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	try {
		const root = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
		});
		await (await root.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		const view = await root.context(BACKGROUND_CONTEXT);
		const result = view.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
		assert.ok(result);
		return {
			text:
				typeof result.content === "string"
					? result.content
					: result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
			sends,
			requests: faux.state.callCount,
		};
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

test("code mode has no host or model APIs and cannot call model-only tools", { timeout: 30_000 }, async () => {
	const result = await runScript(
		"return [typeof fetch, typeof process, typeof require, typeof Bun, typeof models, 'private' in tools, await tools.probe({})].join(',')",
	);
	assert.match(result.text, /undefined,undefined,undefined,undefined,undefined,false,pong/);
});

test("nested send does not prematurely terminate its code mode script", { timeout: 30_000 }, async () => {
	const result = await runScript("await tools.send({}); await tools.send({}); return 'both sent'");
	assert.equal(result.sends, 2);
	assert.match(result.text, /both sent/);
	assert.equal(result.requests, 2);
});
