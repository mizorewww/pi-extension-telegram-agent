import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const NO_SEND_MARKER = "[no_send]";

function assistantText(message: Extract<AgentMessage, { role: "assistant" }>): string {
	return contentText(message.content).trim();
}

/** Keep protocol-required tool/thinking blocks, but never carry unpublished assistant prose. */
export function applyAssistantPersistencePolicy(
	message: AgentMessage,
	onUnpublishedText?: (text: string) => void,
): AgentMessage {
	if (message.role !== "assistant") return message;
	const text = assistantText(message);
	const toolCalls = message.content.filter((content) => content.type === "toolCall");
	if (toolCalls.length === 0) {
		if (text && text !== NO_SEND_MARKER) onUnpublishedText?.(text);
		return { ...message, content: [{ type: "text", text: NO_SEND_MARKER }] };
	}
	const protocolContent = message.content.filter((content) => content.type !== "text");
	return protocolContent.length === message.content.length ? message : { ...message, content: protocolContent };
}

export function makeAssistantPersistencePolicyExtension(onUnpublishedText?: (text: string) => void): InlineExtension {
	return {
		name: "tg-assistant-persistence",
		hidden: true,
		factory: (pi) => {
			pi.on("message_end", (event) => ({
				message: applyAssistantPersistencePolicy(event.message, onUnpublishedText),
			}));
		},
	};
}
