import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { UsageState } from "@earendil-works/pi-durable";
import type { DeciderConfig } from "../config.ts";

export interface RuntimeControlSnapshot {
	state: "idle" | "busy" | "cooldown" | "stopping" | "compacting";
	epoch: number;
	provider: string;
	model: string;
	reasoningEffort: ModelThinkingLevel;
	contextWindow: number;
	currentContextTokens?: number | null;
	cooldownMs: number;
	decider: DeciderConfig | null;
	lastCompact: { at: number; outcome: "ok" | "failed" } | null;
	usage?: UsageState;
}
