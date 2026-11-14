// Pi-native prompt cache warming for the main conversation.
import {
	type Api,
	type AssistantMessage,
	CACHE_WARMING_MAX_AGE_MS,
	CACHE_WARMING_MAX_IDLE_AGE_MS,
	type CacheWarmingPhase,
	evaluateCacheWarming,
	getCacheWarmingDelayMs,
	getCacheWarmingRequestOptions,
	getPromptCacheTtlMs,
	isCacheWarmingReplayable,
	type Message,
	type Model,
	type Models,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { log } from "../observability/log.ts";

export interface WarmableRequest {
	readonly model: Model<Api>;
	readonly messages: readonly Message[];
	readonly options: SimpleStreamOptions;
	readonly promptTokens: number;
}

export interface CacheWarmerHost {
	readonly models: Models;
	phase(): Promise<CacheWarmingPhase | undefined>;
	recordUsage(message: AssistantMessage): Promise<void>;
}

interface ActiveWarmRun extends WarmableRequest {
	readonly delayMs: number;
	readonly startedAt: number;
	readonly controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
}

export class PromptCacheWarmer {
	private current: ActiveWarmRun | null = null;

	constructor(private readonly host: CacheWarmerHost) {}

	start(request: WarmableRequest): void {
		this.stop();
		if (!isCacheWarmingReplayable(request.model, request.options)) return;
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		const delayMs = ttlMs === undefined ? undefined : getCacheWarmingDelayMs(ttlMs);
		if (delayMs === undefined) return;
		const run: ActiveWarmRun = {
			...request,
			delayMs,
			startedAt: Date.now(),
			controller: new AbortController(),
		};
		this.current = run;
		this.arm(run);
	}

	stop(): void {
		const run = this.current;
		if (!run) return;
		this.current = null;
		if (run.timer) clearTimeout(run.timer);
		run.controller.abort();
	}

	private arm(run: ActiveWarmRun): void {
		run.timer = setTimeout(() => void this.refresh(run), run.delayMs);
		run.timer.unref?.();
	}

	private async refresh(run: ActiveWarmRun): Promise<void> {
		if (this.current !== run) return;
		try {
			const phase = await this.host.phase();
			const maxAge = phase === "idle" ? CACHE_WARMING_MAX_IDLE_AGE_MS : CACHE_WARMING_MAX_AGE_MS;
			if (
				!phase ||
				Date.now() > run.startedAt + maxAge ||
				evaluateCacheWarming(run.model, run.promptTokens, phase).action !== "warm" ||
				this.current !== run
			) {
				if (this.current === run) this.stop();
				return;
			}
			const message = await this.host.models.completeSimple(
				run.model,
				{ messages: [...run.messages] },
				getCacheWarmingRequestOptions(run.options, run.controller.signal),
			);
			if (this.current !== run) return;
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				await this.host.recordUsage(message);
				log.info("agent", "cache_warm", {
					phase,
					input_tokens: message.usage.input,
					cache_read: message.usage.cacheRead,
				});
			}
		} catch {
			if (!run.controller.signal.aborted) log.warn("agent", "cache_warm_failed", { category: "request_failed" });
		}
		if (this.current === run) this.arm(run);
	}
}
