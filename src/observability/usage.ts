import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SessionStats } from "@earendil-works/pi-coding-agent";

export interface RuntimeControlSnapshot {
	state: "idle" | "busy" | "cooldown" | "stopping" | "compacting";
	epoch: number;
	provider: string;
	model: string;
	reasoningEffort: ThinkingLevel;
	contextWindow: number;
	currentContextTokens?: number | null;
	routingP: number;
	samplingCooldownMs: number;
	lastCompact: { at: number; outcome: "ok" | "failed" } | null;
	stats?: Pick<SessionStats, "tokens" | "cost">;
}
