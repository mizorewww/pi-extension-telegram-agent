import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createHmac } from "node:crypto";

/** Only hashes survive the request; no payload/base64 snapshots are retained. */
export interface ProviderPayloadObservation {
	systemHash: string;
	toolsHash: string;
	messageHashes: string[];
}

export function estimateCacheReadFromPrefix(
	current: ProviderPayloadObservation,
	previous: ProviderPayloadObservation & { contextTokens: number },
	currentContextTokens: number,
): number | null {
	return previous.contextTokens > 0 &&
		currentContextTokens >= previous.contextTokens &&
		current.systemHash === previous.systemHash &&
		current.toolsHash === previous.toolsHash &&
		previous.messageHashes.length <= current.messageHashes.length &&
		previous.messageHashes.every((hash, index) => hash === current.messageHashes[index])
		? previous.contextTokens
		: null;
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalValue(entry)]),
		);
	}
	return value;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

function hmac(key: string, value: string): string {
	return createHmac("sha256", key).update(value).digest("hex");
}

function payloadSegments(payload: unknown): { system: unknown; tools: unknown; messages: unknown[] } {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return { system: null, tools: [], messages: [] };
	}
	const record = payload as Record<string, unknown>;
	const rawMessages = Array.isArray(record.messages)
		? record.messages
		: Array.isArray(record.input)
			? record.input
			: [];
	// Chat-completions adapters send the system prompt as role "system", or "developer" for
	// reasoning models; both are the stable prefix, not conversation history.
	const isSystemMessage = (entry: unknown): boolean => {
		const role = entry && typeof entry === "object" ? (entry as Record<string, unknown>).role : undefined;
		return role === "system" || role === "developer";
	};
	const systemMessages = rawMessages.filter(isSystemMessage);
	const messages = rawMessages.filter((entry) => !isSystemMessage(entry));
	const system = record.system ?? record.instructions ?? systemMessages;
	const tools = record.tools ?? [];
	return { system, tools, messages };
}

export function observeProviderPayload(payload: unknown, key: string): ProviderPayloadObservation {
	const { system, tools, messages } = payloadSegments(payload);
	return {
		systemHash: hmac(key, canonicalJson(system)),
		toolsHash: hmac(key, canonicalJson(tools)),
		messageHashes: messages.map((message) => hmac(key, canonicalJson(message))),
	};
}

export function makeCachePayloadObserverExtension(
	key: string,
	onObservation: (observation: ProviderPayloadObservation) => void,
): InlineExtension {
	return {
		name: "tg-cache-observer",
		hidden: true,
		factory: (pi) => {
			pi.on("before_provider_request", (event) => onObservation(observeProviderPayload(event.payload, key)));
		},
	};
}
