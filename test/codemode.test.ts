// Codemode boundary: scripts get no host capabilities and reach only callable tools, a send inside
// a script does not end the turn, scripts never persist images, and Pi delivers steered messages
// after the running tool call.

import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
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
import { CODEMODE_IMAGE_OMITTED, makeCodemodeExtension } from "../src/agent/extensions/codemode.ts";
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

test("a send inside a script posts without ending the turn", async () => {
	const result = await runScript('await tools.send({ message: "我去查一下" }); return "still working";');
	expect(result.sendCalls).toBe(1);
	expect(result.text).toContain("still working");
	// The model was called again after the script: the nested send's terminate did not end the turn.
	expect(result.modelCalls).toBe(2);
}, 30_000);

test("codemode output never persists images", async () => {
	const pixel =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const picture = await runScript(`image("${pixel}")`);
	expect(picture.images).toBe(0);
	expect(picture.text).toContain(CODEMODE_IMAGE_OMITTED);
}, 30_000);

test("Pi delivers a steered custom message after the running tool call, before the next model call", async () => {
	const root = mkdtempSync(join(tmpdir(), "tg-steer-"));
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		systemPrompt: "Deterministic fixture.",
	});
	await loader.reload();
	let release: () => void = () => {};
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
		noTools: "builtin",
		customTools: [
			{
				name: "slow",
				label: "slow",
				description: "Waits.",
				parameters: Type.Object({}),
				execute: async () => {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return { content: [{ type: "text" as const, text: "done" }], details: {} };
				},
			},
		],
	});
	const seen: string[][] = [];
	session.agent.streamFunction = (_model, context) => {
		seen.push(context.messages.map((m) => JSON.stringify(m.content)));
		const stream = createAssistantMessageEventStream();
		const message =
			seen.length === 1
				? assistant([{ type: "toolCall", id: "call-1", name: "slow", arguments: {} }], "toolUse")
				: assistant([{ type: "text", text: "ok" }], "stop");
		stream.push({ type: "done", reason: message.stopReason, message } as never);
		return stream;
	};
	try {
		const run = session.prompt("go");
		while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
		await new Promise((resolve) => setTimeout(resolve, 10));
		await session.sendCustomMessage(
			{ customType: "telegram_context_v2", content: "[12:00:00] #77 Bob: 新消息", display: false, details: {} },
			{ deliverAs: "steer" },
		);
		release();
		await run;
		expect(seen).toHaveLength(2);
		expect(seen[1]!.join("\n")).toContain("#77");
		expect(session.sessionManager.buildContextEntries().some((entry) => entry.type === "custom_message")).toBe(true);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
