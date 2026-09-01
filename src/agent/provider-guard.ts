/**
 * Provider call guard: bounded per-attempt timeout with exponential backoff retry.
 *
 * Wraps the Pi StreamFn so a wedged upstream (no response head, hung body) can
 * never pin a bot's turn forever. Each attempt races the call against an abort
 * timer; on timeout the attempt is aborted and retried (when both the retry
 * budget and the caller allow it). After the budget is exhausted or the caller
 * aborts, a synthetic error stream is returned so the agent loop ends the turn
 * cleanly via the Pi event protocol (stopReason "error"/"aborted").
 *
 * The body-freeze case (request settled, stream idle) is covered by passing
 * `timeoutMs`/`signal` into the wrapped Pi call: the provider aborts the fetch,
 * decodes the error in-stream and ends the turn on its own. Retries here only
 * re-arm attempts whose Promise never settle.
 */

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";

export interface ProviderGuardOptions {
	/** Per-attempt wall-clock budget in ms. */
	timeoutMs: number;
	/** Extra attempts after the initial call (0 = no retries). */
	maxRetries: number;
	/** Exponential backoff base in ms: delay = min(base * 2^(attempt-1), capMs). */
	baseBackoffMs: number;
	/** Backoff cap in ms. */
	maxBackoffMs: number;
	/** Called before each backoff sleep, attempt is 1-indexed. */
	onRetry?: (attempt: number, delayMs: number) => void;
}

/** Each attempt receives the merged caller+timeout abort signal so a timed-out request is aborted. */
export type GuardedCall = (signal: AbortSignal) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** Model data needed to fabricate a terminal AssistantMessage for synthetic streams. */
export interface ProviderGuardModel {
	api: Api;
	provider: string;
	id: string;
}

export const PROVIDER_RETRY_BASE_MS = 10_000;
export const PROVIDER_RETRY_MAX_BACKOFF_MS = 60_000;

const TIMEOUT_REASON = "provider_timeout";

function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Terminal error stream following the Pi event protocol; the agent loop closes the turn on it. */
export function syntheticProviderErrorStream(
	model: ProviderGuardModel,
	stopReason: "error" | "aborted",
	errorMessage: string,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
	stream.push({ type: "error", reason: stopReason, error: message });
	stream.end(message);
	return stream;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Run a StreamFn call with a per-attempt timeout and exponential backoff retry.
 * Never rejects: timeouts and exhausted budgets degrade to synthetic error
 * streams, matching the StreamFn contract ("failures encoded in the stream").
 */
export function guardProviderCall(
	call: GuardedCall,
	requestModel: Model<Api>,
	callerSignal: AbortSignal | undefined,
	options: ProviderGuardOptions,
): Promise<AssistantMessageEventStream> {
	const { timeoutMs, maxRetries, baseBackoffMs, maxBackoffMs, onRetry } = options;
	return (async () => {
		let attempt = 0;
		for (;;) {
			const timer = AbortSignal.timeout(timeoutMs);
			const signal = callerSignal ? AbortSignal.any([callerSignal, timer]) : timer;
			const outcome = await Promise.race([
				Promise.resolve()
					.then(() => call(signal))
					.then(
						(stream) => ({ kind: "stream" as const, stream }),
						(error) => ({ kind: "threw" as const, error: error instanceof Error ? error : new Error(String(error)) }),
					),
				new Promise<{ kind: "timeout" }>((resolve) => {
					timer.addEventListener("abort", () => resolve({ kind: "timeout" }), { once: true });
				}),
				new Promise<{ kind: "caller-aborted" }>((resolve) => {
					if (callerSignal?.aborted) return resolve({ kind: "caller-aborted" });
					callerSignal?.addEventListener("abort", () => resolve({ kind: "caller-aborted" }), { once: true });
				}),
			]);
			if (outcome.kind === "stream") return outcome.stream;
			if (outcome.kind === "caller-aborted") {
				return syntheticProviderErrorStream(requestModel, "aborted", "provider call aborted");
			}
			if (outcome.kind === "threw") {
				// Violates StreamFn contract only for non-provider exceptions; degrade to an error stream.
				return syntheticProviderErrorStream(
					requestModel,
					callerSignal?.aborted ? "aborted" : "error",
					`provider call failed: ${outcome.error.message}`,
				);
			}
			// Timed out. Respect caller cancellation and the retry budget.
			if (callerSignal?.aborted || attempt >= maxRetries) {
				return syntheticProviderErrorStream(
					requestModel,
					callerSignal?.aborted ? "aborted" : "error",
					callerSignal?.aborted
						? "provider call aborted"
						: `${TIMEOUT_REASON}: no response within ${timeoutMs}ms after ${attempt + 1} attempt(s)`,
				);
			}
			attempt++;
			const delayMs = Math.min(baseBackoffMs * 2 ** (attempt - 1), maxBackoffMs);
			onRetry?.(attempt, delayMs);
			await sleep(delayMs, callerSignal);
		}
	})();
}
