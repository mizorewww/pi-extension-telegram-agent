import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { UsageState } from "@earendil-works/pi-durable";
import type { DeciderConfig } from "../config.ts";

/** Tokens per part of the provider context. */
export interface ContextComposition {
	system: number;
	tools: number;
	summary: number;
	messages: number;
}

export interface RuntimeControlSnapshot {
	state: "idle" | "busy" | "cooldown" | "stopping" | "compacting";
	epoch: number;
	provider: string;
	model: string;
	reasoningEffort: ModelThinkingLevel;
	contextWindow: number;
	currentContextTokens?: number | null;
	context: ContextComposition;
	cooldownMs: number;
	decider: DeciderConfig | null;
	lastCompact: { at: number; outcome: "ok" | "failed" } | null;
	usage?: UsageState;
}
