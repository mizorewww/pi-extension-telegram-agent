/** One request deadline across stream creation and consumption. Pi owns all retries. */
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type RetryPolicy,
} from "@earendil-works/pi-ai";

export function providerRetryPolicy(maxRetries: number): RetryPolicy {
	return { enabled: maxRetries > 0, maxRetries, baseDelayMs: 10_000 };
}

export type GuardedCall = (signal: AbortSignal) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

function failure(model: Model<Api>, stopReason: "error" | "aborted", errorMessage: string): AssistantMessage {
	return {
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
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

/** Never repeats a request; even an uncooperative provider cannot hold the consumer open. */
export function guardProviderCall(
	call: GuardedCall,
	model: Model<Api>,
	callerSignal: AbortSignal | undefined,
	options: { timeoutMs: number },
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	const controller = new AbortController();
	let finished = false;
	const cleanup = () => {
		finished = true;
		clearTimeout(timer);
		callerSignal?.removeEventListener("abort", cancel);
	};
	const fail = (reason: "error" | "aborted", message: string) => {
		if (finished) return;
		cleanup();
		const result = failure(model, reason, message);
		output.push({ type: "error", reason, error: result });
		output.end(result);
		controller.abort();
	};
	const cancel = () => fail("aborted", "provider call aborted");
	const timer = setTimeout(() => fail("error", "provider_timeout: request deadline exceeded"), options.timeoutMs);
	callerSignal?.addEventListener("abort", cancel, { once: true });
	if (callerSignal?.aborted) cancel();
	void (async () => {
		try {
			if (finished) return;
			const stream = await call(controller.signal);
			for await (const event of stream) {
				if (finished) return;
				output.push(event);
				if (event.type === "done" || event.type === "error") {
					cleanup();
					output.end();
					return;
				}
			}
			if (!finished) {
				const result = await stream.result();
				if (finished) return;
				cleanup();
				output.end(result);
			}
		} catch (error) {
			fail("error", error instanceof Error ? error.message : "provider request failed");
		}
	})();
	return output;
}
