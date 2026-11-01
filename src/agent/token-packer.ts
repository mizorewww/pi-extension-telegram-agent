import type { Database } from "bun:sqlite";
import type { MediaUpdatePayload, MessageEvent, NotePayload } from "../db/message-events.ts";
import type { MessageRow, SerializeOptions } from "./serialize.ts";
import { replySnapshot, serializeMessageEvents } from "./serialize.ts";
import type { ReplySnapshot } from "../telegram/normalize.ts";

export const DEFAULT_SUFFIX_TOKEN_BUDGET = 12_000;
export const DEFAULT_MESSAGE_TOKEN_CAP = 4_096;
export const DEFAULT_OUTPUT_RESERVE = 4_096;
export const DEFAULT_TOOL_FOLLOWUP_RESERVE = 6_144;
export const DEFAULT_REASONING_RESERVE = 4_096;
export const DEFAULT_SAFETY_MARGIN = 2_048;

/**
 * Fixed per-image budget charge for viewed images. Measured against the production endpoint
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
	if (maxTokens <= 0) return "";
	if (estimateProviderTokensUpperBound(value) <= maxTokens) return value;
	const points = [...value];
	const originalChars = points.length;
	const originalTokens = estimateProviderTokensUpperBound(value);
	const marker = `\n[truncated original_chars=${originalChars} estimated_tokens=${originalTokens}]\n`;
	if (estimateProviderTokensUpperBound(marker) > maxTokens) {
		return maxTokens >= estimateProviderTokensUpperBound("[truncated]") ? "[truncated]" : "";
	}
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
	if (event.kind === "media_update" || event.kind === "note") {
		const payload = event.payload as MediaUpdatePayload | NotePayload;
		return { ...event, payload: { ...payload, text: truncateBody(payload.text, maxTokens) } };
	}
	const row = event.payload as MessageRow;
	const parent = row.reply_snapshot ? (JSON.parse(row.reply_snapshot) as ReplySnapshot) : null;
	const quote = row.quote ? (JSON.parse(row.quote) as { text?: string }) : null;
	const bodyField = row.text != null ? "text" : "caption";
	const texts = [row[bodyField] ?? "", parent?.text ?? "", quote?.text ?? ""];
	// Short questions keep their complete body; the remaining budget is shared by long
	// reply/selected-quote text. No quoted content can bypass the per-message cap.
	const order = texts
		.map((text, index) => ({ index, tokens: text ? estimateProviderTokensUpperBound(text) : 0 }))
		.filter((part) => part.tokens > 0)
		.sort((a, b) => a.tokens - b.tokens);
	let remaining = maxTokens;
	for (const [position, part] of order.entries()) {
		const cap = Math.floor(remaining / (order.length - position));
		texts[part.index] = truncateBody(texts[part.index]!, cap);
		remaining -= texts[part.index] ? estimateProviderTokensUpperBound(texts[part.index]!) : 0;
	}
	return {
		...event,
		payload: {
			...row,
			[bodyField]: row[bodyField] == null ? null : texts[0],
			reply_snapshot: parent ? JSON.stringify({ ...parent, text: parent.text == null ? null : texts[1] }) : null,
			quote: quote ? JSON.stringify({ ...quote, text: quote.text == null ? undefined : texts[2] }) : null,
		},
	};
}

export interface PackedMessageEvents {
	events: MessageEvent[];
	text: string;
	estimatedTokens: number;
	visibleMessageIds: number[];
	deferredMandatory: number;
}

function eventKey(event: MessageEvent): string {
	return `${event.kind}:${event.chatId}:${event.messageId}:${event.revision}:${event.ingestSeq}`;
}

/** Mandatory direct replies first, then newest ordinary events; output is chronological. */
export function packMessageEvents(
	db: Database,
	mandatory: readonly MessageEvent[],
	normal: readonly MessageEvent[],
	budgetTokens: number,
	serializeOptions: SerializeOptions,
	messageTokenCap = DEFAULT_MESSAGE_TOKEN_CAP,
): PackedMessageEvents {
	const selected: MessageEvent[] = [];
	const selectedKeys = new Set<string>();
	let remaining = Math.max(512, budgetTokens);
	let deferredMandatory = 0;
	const trySelect = (source: MessageEvent, required: boolean): boolean => {
		const key = eventKey(source);
		if (selectedKeys.has(key)) return true;
		if (source.kind !== "media_update") {
			const row = source.payload as MessageRow;
			const parent = replySnapshot(db, row);
			if (parent) source = { ...source, payload: { ...row, reply_snapshot: JSON.stringify(parent) } };
		}
		let event = capMessageEvent(source, messageTokenCap);
		let rendered = serializeMessageEvents(db, [event], { visibleIds: new Set(serializeOptions.visibleIds) });
		let tokens = estimateProviderTokensUpperBound(rendered);
		if (required && selected.length === 0 && tokens > remaining) {
			const header = serializeMessageEvents(db, [capMessageEvent(source, 0)], {
				visibleIds: new Set(serializeOptions.visibleIds),
			});
			// Empty bodies omit the surrounding quote/separator syntax; leave room for it.
			const bodyBudget = Math.max(0, remaining - estimateProviderTokensUpperBound(header) - 16);
			event = capMessageEvent(source, Math.min(messageTokenCap, bodyBudget));
			rendered = serializeMessageEvents(db, [event], { visibleIds: new Set(serializeOptions.visibleIds) });
			tokens = estimateProviderTokensUpperBound(rendered);
		}
		if (tokens > remaining) return false;
		selected.push(event);
		selectedKeys.add(key);
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
	const text = serializeMessageEvents(db, selected, { visibleIds: new Set(serializeOptions.visibleIds) });
	const visibleMessageIds = selected
		.filter((event) => event.kind === "message" || event.kind === "edit")
		.map((event) => event.messageId);
	return {
		events: selected,
		text,
		estimatedTokens: estimateProviderTokensUpperBound(text),
		visibleMessageIds: [...new Set(visibleMessageIds)],
		deferredMandatory,
	};
}
