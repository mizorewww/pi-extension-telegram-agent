// Loaded into every task run (pi -e /opt/tg-task-bridge/index.ts). The `report` tool is how a
// task tells the Telegram bot what it is doing; the daemon consumes successful tool results from the RPC event stream.

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "report",
		label: "Report",
		description:
			'Tell the Telegram group bot that started this task how it is going. Call it with kind "progress" after each milestone (a few short sentences, no more often than every few minutes), "need_input" when you cannot continue without an answer from the requester (then stop and wait), and "done" once with the final result: a self-contained answer in the requester\'s language, at most about 1500 words, naming any result files you wrote under /work/tasks. Only report text reaches the group.',
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("progress"), Type.Literal("need_input"), Type.Literal("done")]),
			text: Type.String({ minLength: 1, maxLength: 12000 }),
			files: Type.Optional(
				Type.Array(Type.String({ description: "Absolute paths under /work of files the bot may send" }), {
					maxItems: 10,
				}),
			),
		}),
		execute: async (_id: string, params) => ({
			content: [
				{
					type: "text",
					text: params.kind === "need_input" ? "reported; stop now and wait for the answer" : "reported",
				},
			],
			details: {},
			structuredContent: params,
			terminate: params.kind !== "progress",
		}),
	});
}
