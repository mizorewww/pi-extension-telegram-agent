import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { UsageState } from "@earendil-works/pi-durable";

export interface RuntimeControlSnapshot {
	state: "idle" | "busy" | "cooldown" | "stopping" | "compacting";
	epoch: number;
	provider: string;
	model: string;
	reasoningEffort: ModelThinkingLevel;
	contextWindow: number;
	currentContextTokens?: number | null;
	routingP: number;
	samplingCooldownMs: number;
	lastCompact: { at: number; outcome: "ok" | "failed" } | null;
	usage?: UsageState;
}
