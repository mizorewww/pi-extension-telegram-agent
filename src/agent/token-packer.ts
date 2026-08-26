import type { Database } from "bun:sqlite";
import type { MediaUpdatePayload, MessageEvent } from "../db/message-events.ts";
import type { ContextMediaImage } from "../media/context-media.ts";
import type { MessageRow, SerializeOptions, SerializedEventSegment } from "./serialize.ts";
import { serializeMessageEvents, serializeMessageEventSegments } from "./serialize.ts";

export const DEFAULT_SUFFIX_TOKEN_BUDGET = 12_000;
export const DEFAULT_MESSAGE_TOKEN_CAP = 4_096;
export const DEFAULT_OUTPUT_RESERVE = 4_096;
export const DEFAULT_TOOL_FOLLOWUP_RESERVE = 6_144;
export const DEFAULT_REASONING_RESERVE = 4_096;
export const DEFAULT_SAFETY_MARGIN = 2_048;

/**
 * Fixed per-image budget charge for context media. Measured against the production endpoint
 * (a 1px PNG cost ~1_100 prompt tokens); providers bill images by tiles/patches, so a flat
 * conservative constant keeps packing deterministic without inspecting each payload.
 */
export const CONTEXT_IMAGE_TOKEN_ESTIMATE = 1_100;

/** UTF-8 bytes/2 is deliberately conservative for ASCII, code, CJK, URLs, and emoji.
 * Hard budget upper bound; the diagnostic payload estimate is tokenEstimate in
 * extensions/cache-observer.ts (kept separate: different semantics). */
export function estimateProviderTokensUpperBound(text: string): number {
	return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 2));
}

export interface SuffixBudgetInput {
	contextWindow: number;
	currentContextTokens: number;
	staticPrefixTokens: number;
	maxSuffixTokens?: number;
	outputReserve?: number;
	reasoningReserve?: number;
	toolFollowupReserve?: number;
	safetyMargin?: number;
}

export function availableSuffixBudget(input: SuffixBudgetInput): number {
	const occupied = input.currentContextTokens > 0 ? input.currentContextTokens : input.staticPrefixTokens;
	const available =
		input.contextWindow -
		occupied -
		(input.outputReserve ?? DEFAULT_OUTPUT_RESERVE) -
		(input.reasoningReserve ?? 0) -
		(input.toolFollowupReserve ?? 0) -
		(input.safetyMargin ?? DEFAULT_SAFETY_MARGIN);
	return Math.max(512, Math.min(input.maxSuffixTokens ?? DEFAULT_SUFFIX_TOKEN_BUDGET, available));
}

function truncateBody(value: string, maxTokens: number): string {
	if (estimateProviderTokensUpperBound(value) <= maxTokens) return value;
	const points = [...value];
	const originalChars = points.length;
	const originalTokens = estimateProviderTokensUpperBound(value);
	const marker = `\n[truncated original_chars=${originalChars} estimated_tokens=${originalTokens}]\n`;
	let low = 0;
	let high = points.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const head = Math.ceil(mid / 2);
		const tail = Math.floor(mid / 2);
		const candidate = `${points.slice(0, head).join("")}${marker}${tail > 0 ? points.slice(-tail).join("") : ""}`;
		if (estimateProviderTokensUpperBound(candidate) <= maxTokens) low = mid;
		else high = mid - 1;
	}
	const head = Math.ceil(low / 2);
	const tail = Math.floor(low / 2);
	return `${points.slice(0, head).join("")}${marker}${tail > 0 ? points.slice(-tail).join("") : ""}`;
}

export function capMessageEvent(event: MessageEvent, maxTokens = DEFAULT_MESSAGE_TOKEN_CAP): MessageEvent {
	if (event.kind === "media_update") {
		const payload = event.payload as MediaUpdatePayload;
		return { ...event, payload: { ...payload, text: truncateBody(payload.text, maxTokens) } };
	}
	const row = event.payload as MessageRow;
	if (row.text) return { ...event, payload: { ...row, text: truncateBody(row.text, maxTokens) } };
	if (row.caption) return { ...event, payload: { ...row, caption: truncateBody(row.caption, maxTokens) } };
	return event;
}

export interface PackedEventSegment {
	event: MessageEvent;
	text: string;
	/** Prepared context images anchored to this event's message (empty when text-only). */
	images: ContextMediaImage[];
}

export interface PackedMessageEvents {
	events: MessageEvent[];
	/** Chronological per-event segments; joined text equals `text`. */
	segments: PackedEventSegment[];
	text: string;
	estimatedTokens: number;
	visibleMessageIds: number[];
	deferredMandatory: number;
	imagesAttached: number;
}

export interface PackMediaOptions {
	/** Prepared context images for a media identity; null/empty means text-only placeholder. */
	refs: (fileUniqueId: string) => ContextMediaImage[] | null;
	/** Total images this pack may attach across all events. */
	maxImages: number;
}

function eventKey(event: MessageEvent): string {
	return `${event.kind}:${event.chatId}:${event.messageId}:${event.revision}:${event.ingestSeq}`;
}

function mediaFileUniqueId(event: MessageEvent): string | null {
	if (event.kind !== "message") return null;
	const row = event.payload as MessageRow;
	if (!row.media) return null;
	const media = JSON.parse(row.media) as { file_unique_id?: string };
	return typeof media.file_unique_id === "string" && media.file_unique_id ? media.file_unique_id : null;
}

/** Mandatory direct replies first, then newest ordinary events; output is chronological. */
export function packMessageEvents(
	db: Database,
	mandatory: readonly MessageEvent[],
	normal: readonly MessageEvent[],
	budgetTokens: number,
	serializeOptions: SerializeOptions,
	messageTokenCap = DEFAULT_MESSAGE_TOKEN_CAP,
	media?: PackMediaOptions,
): PackedMessageEvents {
	const selected: MessageEvent[] = [];
	const selectedKeys = new Set<string>();
	const selectedImages = new Map<string, ContextMediaImage[]>();
	let remaining = Math.max(512, budgetTokens);
	let imagesAttached = 0;
	let deferredMandatory = 0;
	const trySelect = (source: MessageEvent, required: boolean): boolean => {
		const key = eventKey(source);
		if (selectedKeys.has(key)) return true;
		let event = capMessageEvent(source, messageTokenCap);
		let rendered = serializeMessageEvents(db, [event], { visibleIds: new Set(serializeOptions.visibleIds) });
		let tokens = estimateProviderTokensUpperBound(rendered);
		let images: ContextMediaImage[] = [];
		const fileUniqueId = media ? mediaFileUniqueId(event) : null;
		if (media && fileUniqueId) {
			const refs = media.refs(fileUniqueId) ?? [];
			const allowed = Math.min(refs.length, media.maxImages - imagesAttached);
			images = allowed > 0 ? refs.slice(0, allowed) : [];
		}
		const withImages = tokens + images.length * CONTEXT_IMAGE_TOKEN_ESTIMATE;
		if (images.length > 0 && withImages <= remaining) {
			tokens = withImages;
		} else {
			// Over budget (or over the per-turn image cap): the event still enters text-only.
			images = [];
		}
		if (required && selected.length === 0 && tokens > remaining) {
			event = capMessageEvent(source, Math.max(128, remaining - 64));
			rendered = serializeMessageEvents(db, [event], { visibleIds: new Set(serializeOptions.visibleIds) });
			tokens = estimateProviderTokensUpperBound(rendered);
			// A force-capped mandatory event is already degraded; keep it text-only so the
			// image charge can never push it back over the remaining budget.
			images = [];
		}
		if (tokens > remaining) return false;
		selected.push(event);
		selectedKeys.add(key);
		if (images.length > 0) selectedImages.set(key, images);
		imagesAttached += images.length;
		remaining -= tokens;
		return true;
	};

	for (const event of mandatory) {
		if (!trySelect(event, true)) deferredMandatory++;
	}
	for (let index = normal.length - 1; index >= 0; index--) {
		trySelect(normal[index]!, false);
	}
	selected.sort((left, right) => left.ingestSeq - right.ingestSeq || left.eventDate - right.eventDate);
	const visibleBefore = new Set(serializeOptions.visibleIds);
	const rendered = serializeMessageEventSegments(db, selected, { visibleIds: visibleBefore });
	const segments: PackedEventSegment[] = rendered.map((segment: SerializedEventSegment) => ({
		event: segment.event,
		text: segment.text,
		images: selectedImages.get(eventKey(segment.event)) ?? [],
	}));
	const text = segments
		.map((segment) => segment.text)
		.filter(Boolean)
		.join("\n");
	const visibleMessageIds = selected
		.filter((event) => event.kind === "message" || event.kind === "edit")
		.map((event) => event.messageId);
	return {
		events: selected,
		segments,
		text,
		estimatedTokens: estimateProviderTokensUpperBound(text) + imagesAttached * CONTEXT_IMAGE_TOKEN_ESTIMATE,
		visibleMessageIds: [...new Set(visibleMessageIds)],
		deferredMandatory,
		imagesAttached,
	};
}
