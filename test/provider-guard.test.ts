// Provider call guard unit tests: per-attempt timeout, exponential backoff
// retry, and clean degradation to synthetic error/aborted streams (Pi event
// protocol). In-memory only; no daemon, no network.

import { expect, test } from "bun:test";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { guardProviderCall, syntheticProviderErrorStream } from "../src/agent/provider-guard.ts";

function fakeModel(): Model<Api> {
	return {
		id: "test-model",
		name: "test",
		api: "openai-completions",
		provider: "test",
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.1 },
		contextWindow: 131_072,
		maxTokens: 4096,
	} as unknown as Model<Api>;
}

interface CallLog {
	attempts: number;
	signalsSeen: number;
}

/** A fake StreamFn whose first `hangFor` attempts never settle; later attempts return a terminal stream. */
function hangingCall(
	log: CallLog,
	hangFor: number,
): (signal: AbortSignal) => AssistantMessageEventStream | Promise<AssistantMessageEventStream> {
	return (_signal) => {
		log.attempts++;
		if (log.attempts <= hangFor) return new Promise<AssistantMessageEventStream>(() => {});
		return Promise.resolve(okStream());
	};
}

function okStream(): AssistantMessageEventStream {
	const s = createAssistantMessageEventStream();
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
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
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
	s.push({ type: "start", partial: message });
	s.end(message);
	return s;
}

async function collectResult(stream: AssistantMessageEventStream): Promise<AssistantMessage> {
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	return stream.result();
}

test("returns the first settled stream when the call completes in time", async () => {
	const log: CallLog = { attempts: 0, signalsSeen: 0 };
	const stream = await guardProviderCall(hangingCall(log, 0), fakeModel(), undefined, {
		timeoutMs: 5_000,
		maxRetries: 2,
		baseBackoffMs: 10,
		maxBackoffMs: 100,
	});
	expect(log.attempts).toBe(1);
	const result = await collectResult(stream);
	expect(result.stopReason).toBe("stop");
});

test("retries with exponential backoff after a timeout and recovers", async () => {
	const log: CallLog = { attempts: 0, signalsSeen: 0 };
	const delays: number[] = [];
	const stream = await guardProviderCall(hangingCall(log, 2), fakeModel(), undefined, {
		timeoutMs: 30,
		maxRetries: 2,
		baseBackoffMs: 10,
		maxBackoffMs: 500,
		onRetry: (_attempt, delayMs) => delays.push(delayMs),
	});
	expect(log.attempts).toBe(3); // initial + 2 retries
	expect(delays).toEqual([10, 20]); // exponential: 10ms then 20ms
	const result = await collectResult(stream);
	expect(result.stopReason).toBe("stop");
});

test("degrades to a synthetic error stream when retries are exhausted", async () => {
	const log: CallLog = { attempts: 0, signalsSeen: 0 };
	const stream = await guardProviderCall(hangingCall(log, 99), fakeModel(), undefined, {
		timeoutMs: 20,
		maxRetries: 1,
		baseBackoffMs: 5,
		maxBackoffMs: 100,
	});
	expect(log.attempts).toBe(2); // initial + 1 retry
	const result = await collectResult(stream);
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("provider_timeout");
	expect(result.errorMessage).toContain("20ms");
});

test("does not retry when the caller has aborted", async () => {
	const log: CallLog = { attempts: 0, signalsSeen: 0 };
	const controller = new AbortController();
	const promise = guardProviderCall(hangingCall(log, 99), fakeModel(), controller.signal, {
		timeoutMs: 30_000,
		maxRetries: 5,
		baseBackoffMs: 5,
		maxBackoffMs: 100,
	});
	// Abort before any timeout could fire; the guard must return an aborted stream immediately.
	setTimeout(() => controller.abort(), 5);
	const result = await collectResult(await promise);
	expect(log.attempts).toBe(1); // no retry once the caller cancelled
	expect(result.stopReason).toBe("aborted");
});

test("a throwing call degrades to an error stream instead of rejecting", async () => {
	const stream = await guardProviderCall(
		() => {
			throw new Error("boom");
		},
		fakeModel(),
		undefined,
		{
			timeoutMs: 5_000,
			maxRetries: 0,
			baseBackoffMs: 10,
			maxBackoffMs: 100,
		},
	);
	const result = await collectResult(stream);
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("boom");
});

test("synthetic error stream follows the Pi event protocol", async () => {
	const stream = syntheticProviderErrorStream(fakeModel(), "aborted", "provider call aborted");
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	expect(events).toEqual(["error"]);
	const result = await stream.result();
	expect(result.stopReason).toBe("aborted");
	expect(result.errorMessage).toBe("provider call aborted");
});
