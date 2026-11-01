// Pi-native codemode (QuickJS wasm) for the bot. Scripts reach only the tools registered as
// callable, send included: a script may acknowledge, work and answer in one go, bounded by the
// per-turn send cap.
// Results are bounded here because a script may raise its own `max_output_tokens`, and script
// images are dropped: session entries hold image references only (docs/architecture.md).

import { createCodemodeExtension, type InlineExtension } from "@earendil-works/pi-coding-agent";

/** Host-side cap on one codemode result, whatever the script's options line asks for. */
export const CODEMODE_MAX_OUTPUT_CHARS = 16_000;
export const CODEMODE_IMAGE_OMITTED = "[image omitted: codemode output is text only]";
const TRUNCATED_MARKER = "\n[codemode output truncated by host limit]";

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
				let budget = CODEMODE_MAX_OUTPUT_CHARS;
				let changed = false;
				const content = event.content.flatMap((block) => {
					if (block.type === "image") {
						changed = true;
						return [{ type: "text" as const, text: CODEMODE_IMAGE_OMITTED }];
					}
					if (budget <= 0) {
						changed = true;
						return [];
					}
					if (block.text.length <= budget) {
						budget -= block.text.length;
						return [block];
					}
					changed = true;
					const text = `${block.text.slice(0, budget)}${TRUNCATED_MARKER}`;
					budget = 0;
					return [{ type: "text" as const, text }];
				});
				return changed ? { content } : undefined;
			});
		},
	};
}
