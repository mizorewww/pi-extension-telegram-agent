// Golden hashes lock the cache-visible protocol (docs/cache.md). A failure means the provider
// prefix changed: confirm it is intended, bump CACHE_SCHEMA_VERSION, then update GOLDEN.

import { expect, test } from "bun:test";

// bun test forces UTC; the daemon serializes in local time. Pin the deployment TZ first.
process.env.TZ = "Asia/Singapore";

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { serializeMessageEvents, type MessageRow } from "../src/agent/serialize.ts";
import {
	buildSystemPrompt,
	sha256Short,
	CACHE_SCHEMA_VERSION,
	COMPACTION_SUMMARY_PROMPT,
	REPLY_RECOVERY_PROMPT,
	toolCapabilityDeclaration,
} from "../src/agent/prompt.ts";
import {
	CODEMODE_TOOL_DEFS,
	JOB_TOOL_DEF,
	sendToolWithFiles,
	taskToolDefinition,
	TOOL_DEFS,
	toolProtocolHash,
} from "../src/agent/tools.ts";
import {
	NO_SEND_MARKER,
	buildCompactionContent,
	TELEGRAM_CONTEXT_TYPE,
	TELEGRAM_CONTEXT_VERSION,
} from "../src/agent/extensions/index.ts";

const GOLDEN = {
	schemaVersion: 47,
	systemZhTemplate: "2f1c2b564648",
	systemEnTemplate: "f99097a7d046",
	systemSandboxTemplate: "f4cfe96904c3",
	eventSerialize: "a05c0584eb08",
	tools: "49d65d5de9c9",
	codemodeTools: "3aafdea21201",
	sendWithFiles: "8cea43279c23",
	taskTool: "f5343a7cbdb5",
	jobTool: "a913226f0cba",
	compactionPrompt: "04da95f62da0",
	multimodalCompaction: "9d306722b038",
	replyRecovery: "4fc7e277e338",
	contextProtocol: "b7ee40682d09",
};

const CHAT_ID = -1004402809405;

function schemaDb(): Database {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	return db;
}

test("prompt, tool and protocol hashes are stable", () => {
	expect(CACHE_SCHEMA_VERSION).toBe(GOLDEN.schemaVersion);
	const allTools = { send: true, search: true, codemode: true, sandbox: false, tasks: false, viewImage: false };
	expect(sha256Short(buildSystemPrompt(readFileSync("personas/template.zh.md", "utf8"), allTools))).toBe(
		GOLDEN.systemZhTemplate,
	);
	expect(sha256Short(buildSystemPrompt(readFileSync("personas/template.en.md", "utf8"), allTools))).toBe(
		GOLDEN.systemEnTemplate,
	);
	expect(
		sha256Short(buildSystemPrompt(readFileSync("personas/template.zh.md", "utf8"), { ...allTools, sandbox: true })),
	).toBe(GOLDEN.systemSandboxTemplate);
	// A bot is only ever told about the tools it really has.
	const sendOnly = toolCapabilityDeclaration({
		send: true,
		search: false,
		codemode: false,
		sandbox: false,
		tasks: false,
		viewImage: false,
	});
	expect(sendOnly).toContain("你有一个工具：send");
	expect(sendOnly).not.toContain("search（");
	expect(sendOnly).toContain("你不能联网搜索");
	for (const missing of ["### codemode", "sh_exec", "view_image", "### task", "files", "tg_post", "await"])
		expect(sendOnly).not.toContain(missing);
	expect(toolProtocolHash(TOOL_DEFS)).toBe(GOLDEN.tools);
	expect(toolProtocolHash(CODEMODE_TOOL_DEFS)).toBe(GOLDEN.codemodeTools);
	expect(toolProtocolHash([sendToolWithFiles()])).toBe(GOLDEN.sendWithFiles);
	expect(toolProtocolHash([taskToolDefinition(["search"])])).toBe(GOLDEN.taskTool);
	expect(toolProtocolHash([JOB_TOOL_DEF])).toBe(GOLDEN.jobTool);
	expect(sha256Short(COMPACTION_SUMMARY_PROMPT)).toBe(GOLDEN.compactionPrompt);
	const summaryInput = buildCompactionContent(
		[
			{
				role: "toolResult",
				toolCallId: "view-1",
				toolName: "view_image",
				content: [{ type: "text", text: "#12 photo" }],
				details: { messageId: 12, images: [{ name: "fixture.png", mime: "image/png" }] },
				isError: false,
				timestamp: 13,
			},
		] as never,
		"previous summary",
		() => ({ type: "image", data: "Zml4dHVyZQ==", mimeType: "image/png" }),
	);
	expect(sha256Short(JSON.stringify(summaryInput))).toBe(GOLDEN.multimodalCompaction);
	expect(sha256Short(REPLY_RECOVERY_PROMPT)).toBe(GOLDEN.replyRecovery);
	expect(
		sha256Short(
			JSON.stringify({ type: TELEGRAM_CONTEXT_TYPE, version: TELEGRAM_CONTEXT_VERSION, noSend: NO_SEND_MARKER }),
		),
	).toBe(GOLDEN.contextProtocol);
});

test("immutable event serialization grammar is stable", () => {
	const row: MessageRow = {
		chat_id: CHAT_ID,
		message_id: 200,
		date: 1754612345,
		thread_id: null,
		sender_id: 111,
		display_name: "Alice",
		username: "alice",
		sender_tag: null,
		sender_chat: null,
		is_bot: 0,
		text: "original",
		caption: null,
		entities: null,
		rich_message: null,
		reply_to_message_id: null,
		reply_to_sender_id: null,
		quote: null,
		forward_origin: null,
		edit_date: null,
		media: null,
	};
	const event = (ingestSeq: number, kind: string, revision: number, eventDate: number, payload: unknown) =>
		({ ingestSeq, chatId: CHAT_ID, messageId: 200, revision, kind, eventDate, payload }) as never;
	const out = serializeMessageEvents(schemaDb(), [
		event(1, "message", 0, row.date, row),
		event(2, "edit", 1754612400, 1754612400, { ...row, text: "edited", edit_date: 1754612400 }),
		event(3, "metadata", 1, 1754612401, {
			...row,
			reply_to_message_id: 199,
			reply_to_sender_id: 222,
			reply_snapshot: JSON.stringify({
				display_name: "Bob",
				username: "bob",
				text: "An archived parent whose full text exceeds forty characters: keep this ending.",
				media: null,
			}),
			quote: JSON.stringify({
				text: "A selected quote exceeding the former sixty-character limit: retain the final words.",
			}),
		}),
		event(4, "media_update", 2, 1754612402, { file_unique_id: "u", media_kind: "photo", text: "a cat" }),
	]);
	expect(sha256Short(out)).toBe(GOLDEN.eventSerialize);
});
