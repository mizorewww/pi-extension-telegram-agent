import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const NO_SEND_MARKER = "[no_send]";

/** Keep protocol-required tool/thinking blocks, but never carry unpublished assistant prose. */
export function applyAssistantPersistencePolicy(message: AgentMessage): AgentMessage {
	if (message.role !== "assistant") return message;
	const toolCalls = message.content.filter((content) => content.type === "toolCall");
	if (toolCalls.length === 0) {
		return { ...message, content: [{ type: "text", text: NO_SEND_MARKER }] };
	}
	const protocolContent = message.content.filter((content) => content.type !== "text");
	return protocolContent.length === message.content.length ? message : { ...message, content: protocolContent };
}

export function makeAssistantPersistencePolicyExtension(): InlineExtension {
	return {
		name: "tg-assistant-persistence",
		hidden: true,
		factory: (pi) => {
			pi.on("message_end", (event) => ({
				message: applyAssistantPersistencePolicy(event.message),
			}));
		},
	};
}
