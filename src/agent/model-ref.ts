export const DEFAULT_COMPACTION_MODEL = "openai-codex/gpt-5.6-luna:low";
export const DEFAULT_AUXILIARY_VISUAL_MODEL = DEFAULT_COMPACTION_MODEL;

const REQUEST_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PiRequestThinkingLevel = (typeof REQUEST_THINKING_LEVELS)[number];

export interface PiModelReference {
	provider: string;
	model: string;
	thinkingLevel: PiRequestThinkingLevel;
	canonical: string;
}

/** Parse a task model reference without consulting Pi's catalog or credential store. */
export function parsePiModelReference(value: string): PiModelReference | null {
	if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
	const slash = value.indexOf("/");
	const colon = value.lastIndexOf(":");
	if (slash <= 0 || colon <= slash + 1 || colon === value.length - 1) return null;

	const provider = value.slice(0, slash);
	const model = value.slice(slash + 1, colon);
	const thinkingLevel = value.slice(colon + 1);
	if (!provider || !model || /[\s/:]/.test(provider) || /\s/.test(model)) return null;
	if (!(REQUEST_THINKING_LEVELS as readonly string[]).includes(thinkingLevel)) return null;

	return {
		provider,
		model,
		thinkingLevel: thinkingLevel as PiRequestThinkingLevel,
		canonical: `${provider}/${model}:${thinkingLevel}`,
	};
}

export function canonicalPiModelReference(value: string): string | null {
	return parsePiModelReference(value)?.canonical ?? null;
}
