// Trigger routing: decide which bot (if any) gets a response opportunity.
// Priority: explicit @mention > reply to bot > name keyword > deterministic probability.
// Probability routing uses one shared HMAC value per message (restart/replay/duplicate-safe).

import type { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import type { MessageRow } from "./serialize.ts";

export type TriggerTarget = string | "nobody";
export type RoutingReason = "explicit" | "reply" | "name" | "probability" | "nobody";

export interface RoutingDecision {
	target: TriggerTarget;
	reason: RoutingReason;
	chatId: number;
	messageId: number;
}

export type TriggerSource = "explicit" | "probability";
export type TriggerResult = "started" | "coalesced" | "skipped_busy" | "skipped_cooldown" | "skipped_stopping";

export interface RoutingTrigger {
	reason: RoutingReason;
	chatId: number;
	messageId: number;
}

export interface RoutingRuntime {
	trigger(source: TriggerSource, trigger: RoutingTrigger): TriggerResult;
}

export interface DispatchResult extends RoutingDecision {
	outcome: TriggerResult | "missing_runtime" | "nobody";
}

export interface BotIdentity {
	id: string;
	userId: number;
	username: string;
	name: string;
}

interface TgEntity {
	type: string;
	offset: number;
	length: number;
	user?: { id: number };
}

/** Classify an explicit mention/text_mention or reply to this bot. */
export function explicitTriggerReason(db: Database, row: MessageRow, bot: BotIdentity): "explicit" | "reply" | null {
	if (row.entities) {
		const entities = JSON.parse(row.entities) as TgEntity[];
		for (const e of entities) {
			if (e.type === "mention" && (row.text ?? row.caption)) {
				const mentioned = (row.text ?? row.caption)!.slice(e.offset, e.offset + e.length).toLowerCase();
				if (mentioned === `@${bot.username.toLowerCase()}`) return "explicit";
			}
			if (e.type === "text_mention" && e.user?.id === bot.userId) return "explicit";
		}
	}
	if (row.reply_to_message_id != null) {
		if (row.reply_to_sender_id === bot.userId) return "reply";
		const parent = db
			.query("SELECT sender_id FROM messages WHERE chat_id = ? AND message_id = ?")
			.get(row.chat_id, row.reply_to_message_id) as { sender_id: number | null } | null;
		if (parent?.sender_id === bot.userId) return "reply";
	}
	return null;
}

/** Bot's configured name appears in the message text (e.g. "小雪你怎么看"). */
export function nameKeywordTrigger(row: MessageRow, bot: BotIdentity): boolean {
	const text = row.text ?? row.caption;
	if (!text) return false;
	return text.includes(bot.name);
}

/** Shared deterministic value in [0, 1) for a message. */
export function routingValue(secret: string, chatId: number, messageId: number): number {
	const digest = createHmac("sha256", secret).update(`${chatId}:${messageId}`).digest();
	// first 6 bytes -> [0, 1)
	return digest.readUIntBE(0, 6) / 2 ** 48;
}

export interface RoutingConfig {
	secret: string;
	/** cumulative routing probabilities, one per bot, in config order (REQ-CONF-0001) */
	probs: number[];
}

/** Full routing decision with an explicit reason for scheduler policy. */
export function routeMessageDecision(
	db: Database,
	row: MessageRow,
	bots: BotIdentity[],
	config: RoutingConfig,
): RoutingDecision {
	const makeDecision = (target: TriggerTarget, reason: RoutingReason): RoutingDecision => ({
		target,
		reason,
		chatId: row.chat_id,
		messageId: row.message_id,
	});
	// Bot messages are observed history, never triggers — single authority point (REQ-TEST-0001
	// R3): a caller forgetting the is_bot pre-check cannot introduce bot↔bot trigger loops.
	if (row.is_bot) return makeDecision("nobody", "nobody");
	const addressed = bots.map((bot) => ({ bot, reason: explicitTriggerReason(db, row, bot) }));
	for (const priority of ["explicit", "reply"] as const) {
		const match = addressed.find(({ reason }) => reason === priority);
		if (match) return makeDecision(match.bot.id, priority);
	}
	for (const bot of bots) {
		if (nameKeywordTrigger(row, bot)) return makeDecision(bot.id, "name");
	}
	const u = routingValue(config.secret, row.chat_id, row.message_id);
	let cumulative = 0;
	for (let i = 0; i < bots.length; i++) {
		cumulative += config.probs[i] ?? 0;
		if (u < cumulative) return makeDecision(bots[i]!.id, "probability");
	}
	return makeDecision("nobody", "nobody");
}

/** Apply lifecycle policy without reparsing the message or redistributing probability. */
export function dispatchRoutingDecision(
	decision: RoutingDecision,
	runtimes: ReadonlyMap<string, RoutingRuntime>,
): DispatchResult {
	if (decision.target === "nobody") return { ...decision, outcome: "nobody" };
	const runtime = runtimes.get(decision.target);
	if (!runtime) return { ...decision, outcome: "missing_runtime" };
	const source: TriggerSource = decision.reason === "probability" ? "probability" : "explicit";
	return {
		...decision,
		outcome: runtime.trigger(source, {
			reason: decision.reason,
			chatId: decision.chatId,
			messageId: decision.messageId,
		}),
	};
}
