import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AgentActivity,
	AgentActivityAssistantSection,
	AgentActivityEventSection,
	AgentActivitySection,
	AgentStreamFrame,
} from "../ipc.ts";

export const AGENT_ACTIVITY_MAX_SECTIONS = 64;
export const AGENT_ACTIVITY_MAX_CHARS = 512 * 1024;

function take(value: string, limit: number): { value: string; complete: boolean } {
	if (value.length <= limit) return { value, complete: true };
	if (limit <= 0) return { value: "", complete: false };
	return { value: `${value.slice(0, Math.max(0, limit - 1))}…`, complete: false };
}

function assistantSection(
	message: Extract<AgentMessage, { role: "assistant" }>,
	limit: number,
): { section: AgentActivityAssistantSection | null; chars: number; complete: boolean } {
	let remaining = limit;
	let complete = true;
	const content: AgentActivityAssistantSection["content"] = [];
	for (const block of message.content) {
		if (block.type !== "text" && block.type !== "thinking") continue;
		const source = block.type === "text" ? block.text : block.thinking;
		if (!source.trim()) continue;
		const result = take(source, remaining);
		if (result.value) {
			content.push(
				block.type === "text" ? { type: "text", text: result.value } : { type: "thinking", thinking: result.value },
			);
			remaining -= result.value.length;
		}
		if (!result.complete) {
			complete = false;
			break;
		}
	}
	return {
		section: content.length > 0 ? { type: "assistant", content, stopReason: message.stopReason } : null,
		chars: limit - remaining,
		complete,
	};
}

/** Collects one bounded UI projection without becoming business or provider state. */
export class AgentActivityCollector {
	private readonly sections: AgentActivitySection[] = [];
	private chars = 0;
	private truncated = false;

	constructor(
		readonly activityId: string,
		readonly startedAt: number,
	) {}

	captureAssistant(message: Extract<AgentMessage, { role: "assistant" }>): void {
		if (!this.canAppend()) return;
		const projected = assistantSection(message, AGENT_ACTIVITY_MAX_CHARS - this.chars);
		if (projected.section) {
			this.sections.push(projected.section);
			this.chars += projected.chars;
		}
		if (!projected.complete) this.truncated = true;
	}

	captureEvent(kind: string, payload: unknown): void {
		if (!this.canAppend()) return;
		const serialized = JSON.stringify(payload ?? null);
		const projected = take(serialized, AGENT_ACTIVITY_MAX_CHARS - this.chars);
		const section: AgentActivityEventSection = { type: "event", kind, detail: projected.value };
		this.sections.push(section);
		this.chars += projected.value.length;
		if (!projected.complete) this.truncated = true;
	}

	snapshot(partial?: Extract<AgentMessage, { role: "assistant" }> | null): AgentActivity {
		const sections = [...this.sections];
		let truncated = this.truncated;
		if (partial) {
			if (sections.length >= AGENT_ACTIVITY_MAX_SECTIONS) truncated = true;
			else {
				const projected = assistantSection(partial, AGENT_ACTIVITY_MAX_CHARS - this.chars);
				if (projected.section) sections.push(projected.section);
				if (!projected.complete) truncated = true;
			}
		}
		return {
			version: 1,
			activityId: this.activityId,
			startedAt: this.startedAt,
			sections,
			truncated,
		};
	}

	private canAppend(): boolean {
		if (this.sections.length >= AGENT_ACTIVITY_MAX_SECTIONS || this.chars >= AGENT_ACTIVITY_MAX_CHARS) {
			this.truncated = true;
			return false;
		}
		return true;
	}
}

/** Raw agent events that belong to the running activity: stored tagged with its id, shown inside it. */
const ACTIVITY_RAW_EVENT_KINDS = new Set([
	"assistant_text",
	"thinking",
	"tool_call",
	"tool_result",
	"tool_search",
	"tool_fetch",
	"tool_messages",
	"tool_view_image",
	"tool_sh_exec",
	"file_sent",
	"tool_tg_download",
	"box_reset",
	"task_started",
	"job_started",
	"markdown_sent",
	"plain_fallback",
	"send",
	"send_degraded",
	"error",
]);
const ACTIVITY_DETAIL_EVENT_KINDS = new Set(
	[...ACTIVITY_RAW_EVENT_KINDS].filter((kind) => kind !== "assistant_text" && kind !== "thinking"),
);

/**
 * One bot's live activity: the collector for the running agent run plus the ephemeral Pi-feed
 * stream frames built from it. UI-only; never business or provider state.
 */
export class AssistantActivityStream {
	private streamSequence = 0;
	private activitySequence = 0;
	private streamId: string | null = null;
	private activity: AgentActivityCollector | null = null;
	private partial: Extract<AgentMessage, { role: "assistant" }> | null = null;

	constructor(
		private readonly bot: { id: string; name: string },
		/** Read per frame: the daemon attaches the sink after construction. */
		private readonly sink: () => ((frame: AgentStreamFrame) => void) | null,
		private readonly demand: () => boolean,
		private readonly persist: (snapshot: AgentActivity) => void,
	) {}

	begin(now: number): void {
		if (this.activity) return;
		const streamId = `${this.bot.id}-${++this.streamSequence}`;
		this.streamId = streamId;
		this.activity = new AgentActivityCollector(`${this.bot.id}:${now}:${++this.activitySequence}`, now);
		this.partial = null;
		if (!this.wants()) return;
		this.sink()?.({ phase: "start", streamId, botId: this.bot.id, botName: this.bot.name, ts: now });
	}

	update(message: Extract<AgentMessage, { role: "assistant" }>, now: number): void {
		if (!this.activity || !this.streamId) this.begin(now);
		this.partial = message;
		this.emit(now);
	}

	capture(message: Extract<AgentMessage, { role: "assistant" }>): void {
		if (!this.activity) this.begin(Date.now());
		this.activity?.captureAssistant(message);
		this.partial = null;
		this.emit(Date.now());
	}

	/** Tag a raw event with the running activity; returns the payload to store and whether it is grouped. */
	group(kind: string, payload: unknown): { stored: unknown; grouped: boolean } {
		const activity = this.activity;
		if (!activity || !ACTIVITY_RAW_EVENT_KINDS.has(kind)) return { stored: payload, grouped: false };
		if (ACTIVITY_DETAIL_EVENT_KINDS.has(kind)) activity.captureEvent(kind, payload);
		const stored =
			payload && typeof payload === "object" && !Array.isArray(payload)
				? { ...(payload as Record<string, unknown>), activity_id: activity.activityId }
				: { value: payload, activity_id: activity.activityId };
		return { stored, grouped: true };
	}

	emit(now: number): void {
		const streamId = this.streamId;
		const activity = this.activity;
		if (!streamId || !activity || !this.wants()) return;
		const snapshot = activity.snapshot(this.partial);
		if (snapshot.sections.length === 0) return;
		this.sink()?.({
			phase: "update",
			streamId,
			botId: this.bot.id,
			botName: this.bot.name,
			ts: now,
			activity: snapshot,
		});
	}

	finish(now: number): void {
		const activity = this.activity;
		if (!activity) {
			this.end(now);
			return;
		}
		const snapshot = activity.snapshot(this.partial);
		this.activity = null;
		this.partial = null;
		try {
			if (snapshot.sections.length > 0) this.persist(snapshot);
		} finally {
			this.end(now);
		}
	}

	end(now = Date.now()): void {
		const streamId = this.streamId;
		if (!streamId) return;
		this.streamId = null;
		if (!this.wants()) return;
		this.sink()?.({ phase: "end", streamId, botId: this.bot.id, botName: this.bot.name, ts: now });
	}

	private wants(): boolean {
		return this.sink() != null && this.demand();
	}
}
