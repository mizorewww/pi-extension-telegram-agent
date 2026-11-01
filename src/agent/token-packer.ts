import type { Database } from "bun:sqlite";
import {
	eventsForBot,
	listRecentMessageEvents,
	listReplyObligationEvents,
	type MediaUpdatePayload,
	type MessageEvent,
	type NotePayload,
} from "../db/message-events.ts";
import { isVisionMedia } from "../media/local-cache.ts";
import type { ReplySnapshot } from "../telegram/normalize.ts";
import type { MessageRow } from "./serialize.ts";
import { replySnapshot, serializeMessageEvents } from "./serialize.ts";

export const DEFAULT_MESSAGE_TOKEN_CAP = 4_096;
export const DEFAULT_TOOL_FOLLOWUP_RESERVE = 6_144;
export const DEFAULT_REASONING_RESERVE = 4_096;
export const MAX_EVENT_SCAN = 256;
export const MAX_OBLIGATION_SCAN = 64;
const SAFETY_MARGIN = 2_048;

/** Events not yet in this context: control commands and already-visible messages drop out. */
export function unseenEvents(
	events: readonly MessageEvent[],
	consumedControl: ReadonlySet<number>,
	visibleMessageIds: ReadonlySet<number>,
): MessageEvent[] {
	return events.filter(
		(event) =>
			!consumedControl.has(event.messageId) && !(event.kind === "message" && visibleMessageIds.has(event.messageId)),
	);
}

export function scanTurnEventWindow(
	db: Database,
	botId: string,
	chatId: number,
	consumedSeq: number,
	highWater: number,
	obligationIds: ReadonlySet<number>,
	consumedControl: ReadonlySet<number>,
	visibleMessageIds: ReadonlySet<number>,
): { mandatory: MessageEvent[]; normal: MessageEvent[]; rowsScanned: number } {
	const recent = eventsForBot(listRecentMessageEvents(db, chatId, consumedSeq, highWater, MAX_EVENT_SCAN), botId);
	const obligationEvents = eventsForBot(listReplyObligationEvents(db, botId, chatId, MAX_OBLIGATION_SCAN), botId);
	const seen = new Set<number>();
	const mandatory: MessageEvent[] = [];
	for (const event of [...obligationEvents, ...recent.filter((event) => obligationIds.has(event.messageId))]) {
		if (consumedControl.has(event.messageId) || seen.has(event.ingestSeq)) continue;
		seen.add(event.ingestSeq);
		mandatory.push(event);
	}
	const normal = unseenEvents(recent, consumedControl, visibleMessageIds).filter(
		(event) => !obligationIds.has(event.messageId),
	);
	return { mandatory, normal, rowsScanned: recent.length + obligationEvents.length };
}

/** Distinct preparable media identities in a batch, direct-reply events first, newest first. */
export function pendingMediaIds(
	batch: readonly MessageEvent[],
	obligationIds: ReadonlySet<number>,
	limit: number,
	prepared: (fileUniqueId: string) => boolean,
): string[] {
	const pending: string[] = [];
	const seen = new Set<string>();
	const prioritized = [...batch].sort(
		(left, right) =>
			Number(obligationIds.has(right.messageId)) - Number(obligationIds.has(left.messageId)) ||
			right.ingestSeq - left.ingestSeq,
	);
	for (const event of prioritized) {
		if (pending.length >= limit) break;
		if (event.kind === "media_update" || event.kind === "note") continue;
		const row = event.payload as MessageRow;
		if (!row.media) continue;
		const media = JSON.parse(row.media) as { kind: string; mime?: string; file_unique_id?: string };
		if (!media.file_unique_id || !isVisionMedia(media.kind, media.mime) || seen.has(media.file_unique_id)) continue;
		seen.add(media.file_unique_id);
		if (!prepared(media.file_unique_id)) pending.push(media.file_unique_id);
	}
	return pending;
}

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

export function availableSuffixBudget(input: {
	contextWindow: number;
	currentContextTokens: number;
	staticPrefixTokens: number;
	maxSuffixTokens: number;
	outputReserve: number;
	reasoningReserve: number;
	toolFollowupReserve: number;
}): number {
	const occupied = input.currentContextTokens > 0 ? input.currentContextTokens : input.staticPrefixTokens;
	const available =
		input.contextWindow -
		occupied -
		input.outputReserve -
		input.reasoningReserve -
		input.toolFollowupReserve -
		SAFETY_MARGIN;
	return Math.max(512, Math.min(input.maxSuffixTokens, available));
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
		let rendered = serializeMessageEvents(db, [event]);
		let tokens = estimateProviderTokensUpperBound(rendered);
		if (required && selected.length === 0 && tokens > remaining) {
			const header = serializeMessageEvents(db, [capMessageEvent(source, 0)]);
			// Empty bodies omit the surrounding quote/separator syntax; leave room for it.
			const bodyBudget = Math.max(0, remaining - estimateProviderTokensUpperBound(header) - 16);
			event = capMessageEvent(source, Math.min(messageTokenCap, bodyBudget));
			rendered = serializeMessageEvents(db, [event]);
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
	const text = serializeMessageEvents(db, selected);
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
