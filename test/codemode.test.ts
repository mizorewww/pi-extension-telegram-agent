// Codemode boundary: scripts get no host capabilities and reach only callable tools.

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { makeCodemodeExtension } from "../src/agent/extensions/codemode.ts";
import { TOOL_DEFS, TOOL_EXPOSURE } from "../src/agent/tools.ts";

const model = {
	id: "test-model",
	name: "test",
	api: "openai-responses",
	provider: "test",
	baseUrl: "http://unused",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 65536,
	maxTokens: 4096,
};

function assistant(content: unknown[], stopReason: "stop" | "toolUse") {
	return {
		role: "assistant" as const,
		content,
		api: "openai-responses" as const,
		provider: "test",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/** Run one codemode script through a real Pi session; returns the script result and send calls. */
async function runScript(
	code: string,
): Promise<{ text: string; images: number; sendCalls: number; declared: string[]; modelCalls: number }> {
	const root = mkdtempSync(join(tmpdir(), "tg-codemode-"));
	let sendCalls = 0;
	const send = TOOL_DEFS[0];
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		systemPrompt: "Deterministic fixture.",
		extensionFactories: [makeCodemodeExtension()],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		model: model as never,
		modelRuntime: {
			getModel: () => model,
			hasConfiguredAuth: () => true,
			getAuth: async () => ({ auth: { apiKey: "fixture" } }),
		} as unknown as ModelRuntime,
		sessionManager: SessionManager.inMemory(root),
		resourceLoader: loader,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		customTools: [
			{
				name: send.name,
				label: send.label,
				description: send.description,
				parameters: send.parameters,
				exposure: TOOL_EXPOSURE.send,
				execute: async () => {
					sendCalls++;
					return { content: [{ type: "text" as const, text: "ok" }], details: {}, terminate: true };
				},
			},
			{
				name: "probe",
				label: "probe",
				description: "Returns pong.",
				parameters: Type.Object({}),
				exposure: "codemode",
				execute: async () => ({ content: [{ type: "text" as const, text: "pong" }], details: {} }),
			},
		],
		noTools: "builtin",
		tools: ["+codemode"],
	});
	let calls = 0;
	const declared = session.getActiveToolNames();
	session.agent.streamFunction = () => {
		const stream = createAssistantMessageEventStream();
		const message =
			calls++ === 0
				? assistant([{ type: "toolCall", id: "call-1", name: "codemode", arguments: { code } }], "toolUse")
				: assistant([{ type: "text", text: "done" }], "stop");
		stream.push({ type: "done", reason: message.stopReason, message } as never);
		return stream;
	};
	try {
		await session.prompt("go");
		const result = session.messages.find((m) => m.role === "toolResult" && m.toolName === "codemode") as
			| { content: { type: string; text?: string }[] }
			| undefined;
		if (!result) throw new Error("codemode did not run");
		return {
			text: result.content.map((block) => block.text ?? "").join(""),
			images: result.content.filter((block) => block.type === "image").length,
			sendCalls,
			declared,
			modelCalls: calls,
		};
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}

test("codemode scripts have no host capabilities but reach codemode tools", async () => {
	const result = await runScript(
		"return [typeof fetch, typeof process, typeof require, typeof Bun, await tools.probe({})].join(',')",
	);
	expect(result.text).toContain("undefined,undefined,undefined,undefined,pong");
	expect(result.declared.sort()).toEqual(["codemode", "send"]);
}, 30_000);
