import type { DatabaseSync as Database } from "node:sqlite";
import type { RoutingDecision, TriggerResult } from "../agent/router.ts";

/**
 * Reserve one deterministic routing attempt. A later enrichment may route only when no prior
 * attempt was accepted by a runtime. `nobody` decisions intentionally create no claim.
 */
export function claimRoutingDecision(
	db: Database,
	decision: RoutingDecision & { target: string },
	routeVersion: number,
): boolean {
	const accepted = db
		.prepare(`
		SELECT 1
		  FROM routing_claims
		 WHERE chat_id = ? AND message_id = ?
		   AND status IN ('started', 'coalesced')
		 LIMIT 1
	`)
		.get(decision.chatId, decision.messageId);
	if (accepted) return false;
	const now = Date.now();
	const result = db
		.prepare(`
		INSERT INTO routing_claims
			(chat_id, message_id, bot_id, route_version, reason, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
		ON CONFLICT(chat_id, message_id, bot_id, route_version) DO UPDATE SET
			reason = excluded.reason,
			status = 'pending',
			updated_at = excluded.updated_at
		WHERE routing_claims.status NOT IN ('started', 'coalesced')
	`)
		.run(decision.chatId, decision.messageId, decision.target, routeVersion, decision.reason, now, now);
	return result.changes > 0;
}

export function finishRoutingClaim(
	db: Database,
	decision: RoutingDecision & { target: string },
	routeVersion: number,
	status: TriggerResult | "missing_runtime",
): void {
	db.prepare(`
		UPDATE routing_claims
		   SET status = ?, updated_at = ?
		 WHERE chat_id = ? AND message_id = ? AND bot_id = ? AND route_version = ?
	`).run(status, Date.now(), decision.chatId, decision.messageId, decision.target, routeVersion);
}
