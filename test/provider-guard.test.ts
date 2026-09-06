import { expect, test } from "bun:test";
import {
	createAssistantMessageEventStream,
	isRetryableAssistantError,
	retryAssistantCall,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { guardProviderCall, providerRetryPolicy } from "../src/agent/provider-guard.ts";

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

test("caller cancellation is terminal and a pre-aborted request never starts", async () => {
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	const result = await guardProviderCall(
		() => {
			calls++;
			return createAssistantMessageEventStream();
		},
		model,
		controller.signal,
		{ timeoutMs: 1000 },
	).result();
	expect(result.stopReason).toBe("aborted");
	expect(calls).toBe(0);
});

test("successful streams retain their terminal result and cancel their watchdog", async () => {
	const upstream = createAssistantMessageEventStream();
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const result = {
		role: "assistant" as const,
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop" as const,
		timestamp: 1,
	};
	const stream = guardProviderCall(() => upstream, model, undefined, { timeoutMs: 10 });
	upstream.push({ type: "done", reason: "stop", message: result });
	expect(await stream.result()).toBe(result);
	await Bun.sleep(20);
	expect(await stream.result()).toBe(result);
});

test("zero-retry policy disables native Pi session and summary retries", async () => {
	const policy = providerRetryPolicy(0);
	const settings = SettingsManager.inMemory({ retry: { ...policy, provider: { maxRetries: 0 } } });
	expect(settings.getRetrySettings()).toMatchObject({ enabled: false, maxRetries: 0 });
	expect(settings.getProviderRetrySettings().maxRetries).toBe(0);
	let calls = 0;
	const result = await retryAssistantCall(
		() =>
			guardProviderCall(
				() => {
					calls++;
					throw new Error("503 service unavailable");
				},
				model,
				undefined,
				{ timeoutMs: 10 },
			).result(),
		policy,
		undefined,
	);
	expect(result.stopReason).toBe("error");
	expect(calls).toBe(1);
});
