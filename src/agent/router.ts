// Trigger routing: decide which bot (if any) gets a response opportunity.
// Priority: explicit @mention > reply to bot > name keyword > deterministic probability.
// Probability routing uses one shared HMAC value per message (restart/replay/duplicate-safe).

import type { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { claimRoutingDecision, finishRoutingClaim } from "../db/routing-claims.ts";
import { log } from "../observability/log.ts";
import type { IngestResult } from "../telegram/ingest.ts";
import type { MessageRow } from "./serialize.ts";

export type TriggerTarget = string | "nobody";
export type RoutingReason = "explicit" | "reply" | "name" | "probability" | "nobody";

export interface RoutingDecision {
	target: TriggerTarget;
	reason: RoutingReason;
	chatId: number;
	messageId: number;
	/** Sent by a bot and let through by `/fire`: spends budget, never creates a reply obligation. */
	fromBot: boolean;
}

export type TriggerSource = "explicit" | "probability";
export type TriggerResult = "started" | "coalesced" | "skipped_busy" | "skipped_cooldown" | "skipped_stopping";

export interface RoutingTrigger {
	reason: RoutingReason;
	chatId: number;
	messageId: number;
	fromBot?: boolean;
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

/**
 * Bot's configured name appears in the message text (e.g. "小雪你怎么看"). A name edge made of
 * ASCII letters/digits must sit on a word boundary and matches case-insensitively, so "Al" does
 * not fire on "Also"; CJK names have no word boundaries and match as written.
 */
export function nameKeywordTrigger(row: MessageRow, bot: BotIdentity): boolean {
	const text = row.text ?? row.caption;
	if (!text || !bot.name) return false;
	const word = /[A-Za-z0-9_]/;
	const escaped = bot.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const before = word.test(bot.name[0]!) ? "(?<![A-Za-z0-9_])" : "";
	const after = word.test(bot.name.at(-1)!) ? "(?![A-Za-z0-9_])" : "";
	return new RegExp(`${before}${escaped}${after}`, "i").test(text);
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

/** Bot-triggered turns a `/fire` bot may take before a human speaks again in the chat. */
export const FIRE_BOT_TRIGGER_BUDGET = 3;

/**
 * `/fire`: per (chat, bot) opt-in letting other bots' messages trigger this bot. Kept in memory
 * only, so a daemon restart turns every bot back off. A map entry means enabled; its value is the
 * remaining consecutive bot-triggered turns, refilled by any human message or a fresh `/fire on`.
 */
export class BotFire {
	private readonly remaining = new Map<string, number>();

	enable(botId: string, chatId: number): void {
		this.remaining.set(fireKey(botId, chatId), FIRE_BOT_TRIGGER_BUDGET);
	}

	disable(botId: string, chatId: number): void {
		this.remaining.delete(fireKey(botId, chatId));
	}

	/** Remaining budget, or null when `/fire` is off for this bot in this chat. */
	status(botId: string, chatId: number): number | null {
		return this.remaining.get(fireKey(botId, chatId)) ?? null;
	}

	allows(botId: string, chatId: number): boolean {
		return (this.remaining.get(fireKey(botId, chatId)) ?? 0) > 0;
	}

	consume(botId: string, chatId: number): void {
		const key = fireKey(botId, chatId);
		const left = this.remaining.get(key);
		if (left != null) this.remaining.set(key, Math.max(0, left - 1));
	}

	humanSpoke(chatId: number): void {
		for (const key of this.remaining.keys()) {
			if (key.startsWith(`${chatId}:`)) this.remaining.set(key, FIRE_BOT_TRIGGER_BUDGET);
		}
	}
}

function fireKey(botId: string, chatId: number): string {
	return `${chatId}:${botId}`;
}

/** Full routing decision with an explicit reason for scheduler policy. */
export function routeMessageDecision(
	db: Database,
	row: MessageRow,
	bots: BotIdentity[],
	config: RoutingConfig,
	fire?: BotFire,
): RoutingDecision {
	const fromBot = Boolean(row.is_bot);
	const makeDecision = (target: TriggerTarget, reason: RoutingReason): RoutingDecision => ({
		target,
		reason,
		chatId: row.chat_id,
		messageId: row.message_id,
		fromBot,
	});
	if (!fromBot) {
		fire?.humanSpoke(row.chat_id);
		return normalDecision(db, row, bots, config, makeDecision);
	}
	// Bot messages are observed history unless `/fire` opted the normal target in — single
	// authority point (REQ-TEST-0001 R3): a caller forgetting the is_bot pre-check cannot
	// introduce bot↔bot trigger loops. The normal decision is never redistributed to another bot;
	// a bot never triggers itself; an edit or a control reply never triggers; the budget bounds any
	// feedback loop.
	if (!fire || row.edit_date != null) return makeDecision("nobody", "nobody");
	const control = db
		.query("SELECT 1 FROM telegram_control_messages WHERE chat_id = ? AND message_id = ?")
		.get(row.chat_id, row.message_id);
	if (control) return makeDecision("nobody", "nobody");
	const decision = normalDecision(db, row, bots, config, makeDecision);
	const target = bots.find((bot) => bot.id === decision.target);
	if (!target || target.userId === row.sender_id || !fire.allows(target.id, row.chat_id)) {
		return makeDecision("nobody", "nobody");
	}
	return decision;
}

function normalDecision(
	db: Database,
	row: MessageRow,
	bots: BotIdentity[],
	config: RoutingConfig,
	makeDecision: (target: TriggerTarget, reason: RoutingReason) => RoutingDecision,
): RoutingDecision {
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

/**
 * Claim and dispatch one canonical message. Both entries share every guard: the decision above,
 * the per-message `routing_claims` claim (so a poller echo of a locally routed send, or a
 * replayed update, never dispatches twice) and the `/fire` budget.
 */
export class MessageRouter {
	constructor(
		private readonly db: Database,
		private readonly bots: BotIdentity[],
		/** Read per message: `/set` changes routing_p in place. */
		private readonly config: () => RoutingConfig,
		private readonly runtimes: ReadonlyMap<string, RoutingRuntime>,
		private readonly fire: BotFire,
	) {}

	/** An update ingested from Telegram. */
	route(result: Pick<IngestResult, "kind" | "routeVersion">, row: MessageRow): void {
		const decision = routeMessageDecision(this.db, row, this.bots, this.config(), this.fire);
		// The only enrichment performed by ingestion is reply-sender identity. Re-route only when
		// that new fact actually changes the deterministic outcome into a direct reply.
		if (result.kind === "enriched" && decision.reason !== "reply") return;
		if (decision.target === "nobody") return;
		// TriggerTarget is `string | "nobody"`, which collapses to string; the early return above
		// documents the nobody guard and claimRoutingDecision already accepts the decision as-is.
		const routeVersion = result.routeVersion ?? 1;
		if (!claimRoutingDecision(this.db, decision, routeVersion)) {
			log.info("routing", "duplicate_claim_suppressed", {
				bot_id: decision.target,
				message_id: row.message_id,
				route_version: routeVersion,
			});
			return;
		}
		const dispatched = dispatchRoutingDecision(decision, this.runtimes, this.fire);
		finishRoutingClaim(
			this.db,
			decision,
			routeVersion,
			dispatched.outcome === "nobody" ? "missing_runtime" : dispatched.outcome,
		);
		if (decision.reason === "probability") {
			const metric =
				dispatched.outcome === "started"
					? "route_probability_triggered"
					: dispatched.outcome === "skipped_busy"
						? "route_probability_skipped_busy"
						: dispatched.outcome === "skipped_cooldown"
							? "route_probability_skipped_cooldown"
							: `route_probability_${dispatched.outcome}`;
			log.info("routing", "decision", { bot_id: decision.target, message_id: row.message_id, outcome: metric });
		} else {
			log.info("routing", "decision", {
				bot_id: decision.target,
				message_id: row.message_id,
				reason: decision.reason,
				from_bot: decision.fromBot,
				outcome: dispatched.outcome,
				route_version: routeVersion,
			});
		}
	}

	/**
	 * A configured bot's agent `send` that is already persisted. Telegram does not deliver a bot's
	 * message to sibling bots, so this is the only way it can reach them; it is the same first
	 * delivery a poller would have routed (route version 1).
	 */
	routeLocalSend(row: MessageRow): void {
		this.route({ kind: "inserted", routeVersion: 1 }, row);
	}
}

/** Apply lifecycle policy without reparsing the message or redistributing probability. */
export function dispatchRoutingDecision(
	decision: RoutingDecision,
	runtimes: ReadonlyMap<string, RoutingRuntime>,
	fire?: BotFire,
): DispatchResult {
	if (decision.target === "nobody") return { ...decision, outcome: "nobody" };
	const runtime = runtimes.get(decision.target);
	if (!runtime) return { ...decision, outcome: "missing_runtime" };
	const source: TriggerSource = decision.reason === "probability" ? "probability" : "explicit";
	const outcome = runtime.trigger(source, {
		reason: decision.reason,
		chatId: decision.chatId,
		messageId: decision.messageId,
		fromBot: decision.fromBot,
	});
	// Only an accepted bot-triggered turn spends budget; a skipped one costs nothing.
	if (decision.fromBot && (outcome === "started" || outcome === "coalesced")) {
		fire?.consume(decision.target, decision.chatId);
	}
	return { ...decision, outcome };
}
