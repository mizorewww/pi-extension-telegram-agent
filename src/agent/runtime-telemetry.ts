// Best-effort facts only. Session statistics and context usage belong to Pi.
import type { DatabaseSync as Database } from "node:sqlite";
import type { Usage, Api, Model } from "@earendil-works/pi-ai";
import type { BotConfig } from "../config.ts";
import { log } from "../observability/log.ts";
import { estimateCacheReadFromPrefix, type ProviderPayloadObservation } from "./extensions/cache-observer.ts";

export class BotRuntimeTelemetry {
	pendingObservation: ProviderPayloadObservation | null = null;
	private previous: (ProviderPayloadObservation & { cohort: string; contextTokens: number }) | null = null;

	constructor(
		private readonly db: Database,
		private readonly bot: BotConfig,
	) {}

	private write(effect: () => void): void {
		try {
			effect();
		} catch {
			log.warn("telemetry", "write_failed", { bot_id: this.bot.id });
		}
	}

	recordEvent(kind: string, payload: unknown): void {
		this.write(() => {
			this.db
				.prepare("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (?, ?, ?, ?)")
				.run(this.bot.id, Date.now(), kind, JSON.stringify(payload));
		});
	}

	recordUsage(usage: Usage, model: Model<Api>, epoch: number, sessionId: string, compaction = false): void {
		const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (tokens + usage.output === 0 && usage.cost.total === 0) return;
		const observation = compaction ? null : this.pendingObservation;
		const cohort = `${model.provider}|${model.api}|${model.id}|${epoch}|${sessionId}|${this.bot.cacheRetention}`;
		const previous = this.previous?.cohort === cohort ? this.previous : null;
		const estimate =
			observation && previous && !usage.cacheRead && !usage.cacheWrite && this.bot.cacheRetention !== "none"
				? estimateCacheReadFromPrefix(observation, previous, tokens)
				: null;
		if (!compaction) {
			this.previous = observation ? { ...observation, cohort, contextTokens: tokens } : null;
			this.pendingObservation = null;
		}
		this.write(() => {
			this.db
				.prepare(`INSERT INTO llm_runs
				(bot_id, ts, model, epoch, context_tokens, cache_read, cache_write, cache_read_estimated,
				 cache_miss, output_tokens, cost, compaction, provider, api, cache_retention, system_hash, tools_hash)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(
					this.bot.id,
					Date.now(),
					model.id,
					epoch,
					tokens,
					usage.cacheRead,
					usage.cacheWrite,
					estimate,
					usage.input,
					usage.output,
					usage.cost.total,
					Number(compaction),
					model.provider,
					model.api,
					compaction ? "none" : this.bot.cacheRetention,
					observation?.systemHash ?? null,
					observation?.toolsHash ?? null,
				);
		});
	}
}
