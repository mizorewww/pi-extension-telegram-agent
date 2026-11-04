/** Pi owns retries; Chord bounds a provider that ignores cancellation or never closes its stream. */
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { lazyStream, type Api, type AssistantMessageEventStream, type Model, type Models } from "@earendil-works/pi-ai";

/** Pi's overflow classifier recognizes request_too_large, but not a proxy's HTML HTTP 413. */
function normalizeSizeError(message: string): string {
	return /\b(?:HTTP\s+413|413\s+(?:Request Entity Too Large|Payload Too Large)|request entity too large|payload too large)\b/i.test(
		message,
	)
		? "request_too_large: provider request exceeds transport size limit"
		: message;
}

export function guardProviderCall(
	call: (signal: AbortSignal) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
	model: Model<Api>,
	callerSignal: AbortSignal | undefined,
	options: { timeoutMs: number },
): AssistantMessageEventStream {
	const deadline = new AbortController();
	const timer = setTimeout(
		() => deadline.abort(new Error("provider_timeout: request deadline exceeded")),
		options.timeoutMs,
	);
	const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
	const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
	return lazyStream(model, async () =>
		(async function* () {
			try {
				signal.throwIfAborted();
				const stream = await awaitWithContext(Promise.resolve(call(signal)), context);
				const iterator = stream[Symbol.asyncIterator]();
				while (true) {
					const next = await awaitWithContext(iterator.next(), context);
					if (next.done) break;
					const event = next.value;
					if (event.type === "error") event.error.errorMessage = normalizeSizeError(event.error.errorMessage ?? "");
					yield event;
					if (event.type === "done" || event.type === "error") return;
				}
				const result = await awaitWithContext(stream.result(), context);
				if (result.stopReason === "pending") throw new Error("provider returned an unfinished response");
				if (result.stopReason === "error" || result.stopReason === "aborted") {
					result.errorMessage = normalizeSizeError(result.errorMessage ?? "");
					yield { type: "error" as const, reason: result.stopReason, error: result };
				} else yield { type: "done" as const, reason: result.stopReason, message: result };
			} catch (error) {
				const failed = lazyStream(model, async () => {
					throw new Error(normalizeSizeError(error instanceof Error ? error.message : "provider request failed"));
				});
				for await (const event of failed) {
					if (event.type === "error" && callerSignal?.aborted) {
						event.reason = "aborted";
						event.error.stopReason = "aborted";
					}
					yield event;
				}
			} finally {
				clearTimeout(timer);
				deadline.abort();
			}
		})(),
	);
}

/** Guard both generation and native compaction while keeping Pi's catalog, auth and routing untouched. */
export function guardModels(models: Models, getOptions: () => { timeoutMs: number; contextWindow?: number }): Models {
	const stream: Models["streamSimple"] = (model, context, options) =>
		guardProviderCall(
			(signal) => models.streamSimple(model, context, { ...options, signal }),
			model,
			options?.signal,
			getOptions(),
		);
	return new Proxy(models, {
		get(target, property) {
			if (property === "getModel")
				return (...args: Parameters<Models["getModel"]>) => {
					const model = models.getModel(...args);
					const limit = getOptions().contextWindow;
					return model && limit != null ? { ...model, contextWindow: Math.min(model.contextWindow, limit) } : model;
				};
			if (property === "streamSimple") return stream;
			if (property === "completeSimple") return (...args: Parameters<typeof stream>) => stream(...args).result();
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
