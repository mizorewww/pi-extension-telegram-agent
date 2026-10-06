// The provider watchdog turns hangs into retryable errors and proxy 413s into Pi overflow recovery.

import { expect, test } from "bun:test";
import {
	createAssistantMessageEventStream,
	isRetryableAssistantError,
	isContextOverflow,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import { guardProviderCall } from "../src/agent/provider-guard.ts";
import { classifyPiProviderFailure } from "../src/agent/model-runtime.ts";

const model = {
	id: "test",
	name: "test",
	api: "openai-completions",
	provider: "test",
	reasoning: false,
	input: ["text"],
	contextWindow: 65536,
	maxTokens: 4096,
	baseUrl: "http://unused",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model<Api>;

for (const phase of ["creation", "body"] as const) {
	test(`deadline closes a hanging ${phase} and aborts the request without retrying`, async () => {
		let calls = 0;
		let signal: AbortSignal | undefined;
		const stream = guardProviderCall(
			(incoming) => {
				calls++;
				signal = incoming;
				return phase === "creation" ? new Promise(() => {}) : createAssistantMessageEventStream();
			},
			model,
			undefined,
			{ timeoutMs: 10 },
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(signal?.aborted).toBe(true);
		expect(calls).toBe(1);
	});
}

for (const phase of ["throw", "stream"] as const) {
	test(`HTTP 413 from ${phase} enters Pi overflow recovery without retrying the request`, async () => {
		let calls = 0;
		const result = await guardProviderCall(
			() => {
				calls++;
				const errorMessage = "GetChatMessage HTTP 413: <html>413 Request Entity Too Large</html>";
				if (phase === "throw") throw new Error(errorMessage);
				const stream = createAssistantMessageEventStream();
				stream.push({
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage,
						timestamp: Date.now(),
					},
				});
				return stream;
			},
			model,
			undefined,
			{ timeoutMs: 1000 },
		).result();
		expect(isContextOverflow(result, model.contextWindow)).toBe(true);
		expect(classifyPiProviderFailure(result.errorMessage)).toBe("provider_request_too_large");
		expect(calls).toBe(1);
	});
}
