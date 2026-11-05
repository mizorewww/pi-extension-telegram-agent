// Trigger routing: a human addressing the bot always gets a turn; every other message (other
// bots included) is ambient and the runtime asks the decider, or takes a turn when none is set.

import type { DatabaseSync as Database } from "node:sqlite";
import { log } from "../observability/log.ts";
import type { IngestResult } from "../telegram/ingest.ts";
import type { MessageRow } from "./serialize.ts";

export type DirectReason = "mention" | "reply" | "name";
export type TriggerSource = "direct" | "ambient";
export type TriggerResult =
	| "started"
	| "coalesced"
	| "declined"
	| "skipped_busy"
	| "skipped_cooldown"
	| "skipped_stopping";

export interface RoutingTrigger {
	chatId: number;
	messageId: number;
}

export interface RoutingRuntime {
	trigger(source: TriggerSource, trigger: RoutingTrigger): Promise<TriggerResult>;
}

export interface BotIdentity {
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

/** A mention/text_mention, a reply to the bot, or its configured name in the text. */
export function directReason(db: Database, row: MessageRow, bot: BotIdentity): DirectReason | null {
	const text = row.text ?? row.caption;
	if (row.entities) {
		for (const e of JSON.parse(row.entities) as TgEntity[]) {
			if (
				e.type === "mention" &&
				text?.slice(e.offset, e.offset + e.length).toLowerCase() === `@${bot.username.toLowerCase()}`
			)
				return "mention";
			if (e.type === "text_mention" && e.user?.id === bot.userId) return "mention";
		}
	}
	if (row.reply_to_message_id != null) {
		if (row.reply_to_sender_id === bot.userId) return "reply";
		const parent = db
			.prepare("SELECT sender_id FROM messages WHERE chat_id = ? AND message_id = ?")
			.get(row.chat_id, row.reply_to_message_id) as { sender_id: number | null } | null;
		if (parent?.sender_id === bot.userId) return "reply";
	}
	return nameKeywordTrigger(text, bot.name) ? "name" : null;
}

/**
 * The configured name appears in the text (e.g. "小雪你怎么看"). A name edge made of ASCII
 * letters/digits must sit on a word boundary and matches case-insensitively, so "Al" does not fire
 * on "Also"; CJK names have no word boundaries and match as written.
 */
export function nameKeywordTrigger(text: string | null, name: string): boolean {
	if (!text || !name) return false;
	const word = /[A-Za-z0-9_]/;
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const before = word.test(name[0]!) ? "(?<![A-Za-z0-9_])" : "";
	const after = word.test(name.at(-1)!) ? "(?![A-Za-z0-9_])" : "";
	return new RegExp(`${before}${escaped}${after}`, "i").test(text);
}

export class MessageRouter {
	constructor(
		private readonly db: Database,
		private readonly bot: BotIdentity,
		private readonly runtime: RoutingRuntime,
	) {}

	/** Runs inside the poller's durable handoff; replays are deduplicated by Pi's request id. */
	async route(result: Pick<IngestResult, "kind">, row: MessageRow): Promise<void> {
		if (row.sender_id === this.bot.userId) return;
		// Other bots never address this one directly: the decider bounds bot-to-bot loops.
		const direct = row.is_bot ? null : directReason(this.db, row, this.bot);
		// An edit matters only when it newly addresses the bot.
		if (result.kind !== "inserted" && !direct) return;
		const source: TriggerSource = direct ? "direct" : "ambient";
		const outcome = await this.runtime.trigger(source, { chatId: row.chat_id, messageId: row.message_id });
		log.info("routing", "decision", {
			message_id: row.message_id,
			reason: direct ?? "ambient",
			from_bot: Boolean(row.is_bot),
			outcome,
		});
		// Keep the poller's durable handoff pending while a human request cannot enter Pi.
		if (outcome === "skipped_stopping" && source === "direct")
			throw new Error("Telegram request awaits runtime admission");
	}
}
