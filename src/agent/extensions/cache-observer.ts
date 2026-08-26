import { COMPACTION_SUMMARY_PREFIX } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createHmac } from "node:crypto";
import { CONTEXT_IMAGE_TOKEN_ESTIMATE } from "../token-packer.ts";

export interface ProviderPayloadObservation {
	systemHash: string;
	toolsHash: string;
	messageHashes: string[];
	fullPayloadHash: string;
	firstDivergentSegment: "system" | "tools" | "messages" | "payload" | null;
	firstDivergentMessageIndex: number | null;
	firstDivergentByteOffset: number | null;
	tokenEstimate: {
		system: number;
		tools: number;
		compactedHistory: number;
		messages: number;
	};
}

// Diagnostic estimate for telemetry only; the hard budget upper bound is
// estimateProviderTokensUpperBound in ../token-packer.ts (kept separate: different semantics).
function tokenEstimate(value: unknown): number {
	// Image content parts carry base64 data URLs: raw byte size would dwarf every text
	// segment and collapse the scaled system/tools breakdown to zero, so charge the same
	// flat per-image budget the packer uses.
	if (isImageContentPart(value)) return CONTEXT_IMAGE_TOKEN_ESTIMATE;
	if (Array.isArray(value)) return value.reduce<number>((sum, entry) => sum + tokenEstimate(entry), 0);
	if (value && typeof value === "object") {
		return Object.values(value).reduce<number>((sum, entry) => sum + tokenEstimate(entry), 0);
	}
	return Math.max(0, Math.round(Buffer.byteLength(canonicalJson(value), "utf8") / 2));
}

// Pi serializes images as image_url (chat completions), input_image (responses), or
// image + base64 source (Anthropic messages) parts.
function isImageContentPart(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.type === "image_url" || record.type === "input_image") return true;
	if (record.type !== "image") return false;
	const source = record.source;
	return (
		source != null &&
		typeof source === "object" &&
		!Array.isArray(source) &&
		typeof (source as Record<string, unknown>).data === "string"
	);
}

function containsCompactionSummary(value: unknown): boolean {
	if (typeof value === "string") return value.includes(COMPACTION_SUMMARY_PREFIX);
	if (Array.isArray(value)) return value.some(containsCompactionSummary);
	return Boolean(value && typeof value === "object" && Object.values(value).some(containsCompactionSummary));
}

export interface PreviousProviderPayloadFingerprint {
	systemHash: string;
	toolsHash: string;
	messageHashes: readonly string[];
	contextTokens: number;
}

/** Potential provider reuse when the previous raw prompt is an exact prefix of the current one. */
export function estimateCacheReadFromPrefix(
	current: ProviderPayloadObservation,
	previous: PreviousProviderPayloadFingerprint,
	currentContextTokens: number,
): number | null {
	if (
		!Number.isSafeInteger(previous.contextTokens) ||
		previous.contextTokens <= 0 ||
		!Number.isSafeInteger(currentContextTokens) ||
		currentContextTokens < previous.contextTokens ||
		current.systemHash !== previous.systemHash ||
		current.toolsHash !== previous.toolsHash ||
		previous.messageHashes.length > current.messageHashes.length
	) {
		return null;
	}
	for (let index = 0; index < previous.messageHashes.length; index++) {
		if (previous.messageHashes[index] !== current.messageHashes[index]) return null;
	}
	return previous.contextTokens;
}

const PAYLOAD_SNAPSHOT = Symbol("payload-snapshot");

interface PayloadSnapshot {
	systemJson: string;
	toolsJson: string;
	messageJson: string[];
	fullJson: string;
}

type ObservationWithSnapshot = ProviderPayloadObservation & { [PAYLOAD_SNAPSHOT]?: PayloadSnapshot };

function canonicalValue(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalValue(entry)]),
		);
	}
	return String(value);
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

function hmac(key: string, value: string): string {
	return createHmac("sha256", key).update(value).digest("hex");
}

function firstByteDifference(left: string, right: string): number | null {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	const length = Math.min(a.length, b.length);
	for (let index = 0; index < length; index++) {
		if (a[index] !== b[index]) return index;
	}
	return a.length === b.length ? null : length;
}

function payloadSegments(payload: unknown): { system: unknown; tools: unknown; messages: unknown[]; rest: unknown } {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return { system: null, tools: [], messages: [], rest: payload };
	}
	const record = payload as Record<string, unknown>;
	const rawMessages = Array.isArray(record.messages)
		? record.messages
		: Array.isArray(record.input)
			? record.input
			: [];
	const systemMessages = rawMessages.filter(
		(entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).role === "system",
	);
	const messages = rawMessages.filter(
		(entry) => !(entry && typeof entry === "object" && (entry as Record<string, unknown>).role === "system"),
	);
	const system = record.system ?? record.instructions ?? systemMessages;
	const tools = record.tools ?? [];
	const rest = Object.fromEntries(
		Object.entries(record).filter(([key]) => !["system", "instructions", "messages", "input", "tools"].includes(key)),
	);
	return { system, tools, messages, rest };
}

export function observeProviderPayload(
	payload: unknown,
	key: string,
	previous?: ProviderPayloadObservation,
): ProviderPayloadObservation {
	const segments = payloadSegments(payload);
	const systemJson = canonicalJson(segments.system);
	const toolsJson = canonicalJson(segments.tools);
	const messageJson = segments.messages.map(canonicalJson);
	const fullJson = canonicalJson(payload);
	const systemHash = hmac(key, systemJson);
	const toolsHash = hmac(key, toolsJson);
	const messageHashes = messageJson.map((message) => hmac(key, message));
	const fullPayloadHash = hmac(key, fullJson);
	const compactedMessages = segments.messages.filter(containsCompactionSummary);
	const ordinaryMessages = segments.messages.filter((message) => !containsCompactionSummary(message));
	let firstDivergentSegment: ProviderPayloadObservation["firstDivergentSegment"] = null;
	let firstDivergentMessageIndex: number | null = null;
	let firstDivergentByteOffset: number | null = null;
	if (previous) {
		const previousSnapshot = (previous as ObservationWithSnapshot)[PAYLOAD_SNAPSHOT];
		if (previous.systemHash !== systemHash) {
			firstDivergentSegment = "system";
			firstDivergentByteOffset = previousSnapshot ? firstByteDifference(previousSnapshot.systemJson, systemJson) : null;
		} else if (previous.toolsHash !== toolsHash) {
			firstDivergentSegment = "tools";
			firstDivergentByteOffset = previousSnapshot ? firstByteDifference(previousSnapshot.toolsJson, toolsJson) : null;
		} else {
			const max = Math.max(previous.messageHashes.length, messageHashes.length);
			for (let index = 0; index < max; index++) {
				if (previous.messageHashes[index] === messageHashes[index]) continue;
				firstDivergentSegment = "messages";
				firstDivergentMessageIndex = index;
				const previousJson = previousSnapshot?.messageJson[index] ?? "";
				const currentJson = messageJson[index] ?? "";
				firstDivergentByteOffset = previousSnapshot ? firstByteDifference(previousJson, currentJson) : null;
				break;
			}
			if (!firstDivergentSegment && previous.fullPayloadHash !== fullPayloadHash) {
				firstDivergentSegment = "payload";
				firstDivergentByteOffset = previousSnapshot ? firstByteDifference(previousSnapshot.fullJson, fullJson) : null;
			}
		}
	}
	const observation: ObservationWithSnapshot = {
		systemHash,
		toolsHash,
		messageHashes,
		fullPayloadHash,
		firstDivergentSegment,
		firstDivergentMessageIndex,
		firstDivergentByteOffset,
		tokenEstimate: {
			system: tokenEstimate(segments.system),
			tools: tokenEstimate(segments.tools),
			compactedHistory: compactedMessages.reduce<number>((sum, message) => sum + tokenEstimate(message), 0),
			messages: ordinaryMessages.reduce<number>((sum, message) => sum + tokenEstimate(message), 0),
		},
	};
	Object.defineProperty(observation, PAYLOAD_SNAPSHOT, {
		value: { systemJson, toolsJson, messageJson, fullJson } satisfies PayloadSnapshot,
		enumerable: false,
	});
	return observation;
}

export function makeCachePayloadObserverExtension(
	key: string,
	onObservation: (observation: ProviderPayloadObservation) => void,
): InlineExtension {
	let previous: ProviderPayloadObservation | undefined;
	return {
		name: "tg-cache-observer",
		hidden: true,
		factory: (pi) => {
			pi.on("before_provider_request", (event) => {
				const observation = observeProviderPayload(event.payload, key, previous);
				previous = observation;
				onObservation(observation);
			});
		},
	};
}
