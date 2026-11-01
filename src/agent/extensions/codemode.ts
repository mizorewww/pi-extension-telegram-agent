// Pi-native codemode (QuickJS wasm) for the bot. Scripts reach only the tools registered as
// callable, send included: a script may acknowledge, work and answer in one go, bounded by the
// per-turn send cap.
// Results are bounded here because a script may raise its own `max_output_tokens`, and script
// images are dropped: session entries hold image references only (docs/architecture.md).

import { createCodemodeExtension, type InlineExtension } from "@earendil-works/pi-coding-agent";

export const CODEMODE_IMAGE_OMITTED = "[image omitted: codemode output is text only]";

const codemode = createCodemodeExtension({ mode: "on", models: false });

/**
 * Stands in for the codemode declaration in the context fingerprint and tool hash: Pi renders the
 * real description from the callable tools, which the Pi version and our tool list already pin.
 */
export const CODEMODE_FINGERPRINT_ENTRY = {
	name: "codemode",
	description: "pi-native codemode; mode on; models off",
	parameters: {},
} as const;

/** Upper bound of the rendered declaration: Pi's 3000-token inline budget plus intro and globals. */
export const CODEMODE_DECLARATION_TOKENS = 3_500;

export function makeCodemodeExtension(): InlineExtension {
	return {
		name: "tg-codemode",
		hidden: true,
		factory: (pi) => {
			codemode(pi);
			pi.on("tool_result", (event) => {
				if (event.toolName !== "codemode" || event.parentToolCallId) return;
				if (!event.content.some((block) => block.type === "image")) return;
				return {
					content: event.content.map((block) =>
						block.type === "image" ? { type: "text" as const, text: CODEMODE_IMAGE_OMITTED } : block,
					),
				};
			});
		},
	};
}
