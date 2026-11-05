// Golden hashes guard the provider prefix across native Pi/Telegram protocol changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync as Database } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { projectStickerNotes } from "../src/media/sticker-catalog.ts";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { telegramCodemode } from "../src/agent/extensions/codemode.ts";
import { buildBotRuntimeTools, type BotRuntimeToolHost } from "../src/agent/runtime-tools.ts";
import { serializeMessageEvents, type MessageRow } from "../src/agent/serialize.ts";
import { buildSystemPrompt, sha256Short, CACHE_SCHEMA_VERSION, REPLY_RECOVERY_PROMPT } from "../src/agent/prompt.ts";
import {
	CODEMODE_TOOL_DEFS,
	JOB_TOOL_DEF,
	sendToolWithFiles,
	taskToolDefinition,
	TOOL_DEFS,
	toolProtocolHash,
} from "../src/agent/tools.ts";
process.env.TZ = "Asia/Singapore";
const GOLDEN = {
	schemaVersion: 55,
	systemZhTemplate: "50ffcdb70e57",
	systemEnTemplate: "be09421b7655",
	systemSandboxTemplate: "96efc7945c60",
	tools: "307b029162a6",
	codemodeTools: "99718d49e271",
	sendWithFiles: "58ccd07cfbd9",
	taskTool: "8fcbd3a5b98d",
	jobTool: "78e6689e8118",
	nativeTools: "19524518f475",
	fixedOfferedTools: "677e238e1927",
	fixedCodemodeSection: "3745e9a802d5",
	replyRecovery: "4fc7e277e338",
	eventSerialize: "a05c0584eb08",
	boundedBatchSerialize: "0311b765bbce",
};
const CHAT_ID = -1004402809405;
function schemaDb() {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	return db;
}
test("prompt and native tool protocol hashes are stable", async () => {
	const allTools = { send: true, search: true, codemode: true, sandbox: false, tasks: false };
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(telegramCodemode());
	const full = createRegistry();
	const { extensions } = await buildBotRuntimeTools({
		bot: { id: "fixture", tools: { ...allTools, sandbox: true, tasks: true } },
		box: {},
		config: { tasks: { workflows: { search: "/fixture" } } },
	} as unknown as BotRuntimeToolHost);
	for (const extension of extensions) full.install(extension);
	const models = createModels();
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage("done")]);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: full }, BACKGROUND_CONTEXT);
	let fixedOfferedTools: string;
	let fixedCodemodeSection: string;
	try {
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
		});
		fixedOfferedTools = toolProtocolHash((await conversation.agent(BACKGROUND_CONTEXT)).tools);
		await (await conversation.submit({ type: "input", content: "fixture" }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		const messages = (await conversation.context(BACKGROUND_CONTEXT)).messages;
		const section = messages.find((message) => message.role === "system" && message.sections?.codemode);
		assert.ok(section?.role === "system" && section.sections?.codemode);
		fixedCodemodeSection = sha256Short(section.sections.codemode);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
	const actual = {
		schemaVersion: CACHE_SCHEMA_VERSION,
		systemZhTemplate: sha256Short(buildSystemPrompt(readFileSync("personas/template.zh.md", "utf8"), allTools)),
		systemEnTemplate: sha256Short(buildSystemPrompt(readFileSync("personas/template.en.md", "utf8"), allTools)),
		systemSandboxTemplate: sha256Short(
			buildSystemPrompt(readFileSync("personas/template.zh.md", "utf8"), { ...allTools, sandbox: true }),
		),
		tools: toolProtocolHash(TOOL_DEFS),
		codemodeTools: toolProtocolHash(CODEMODE_TOOL_DEFS),
		sendWithFiles: toolProtocolHash([sendToolWithFiles()]),
		taskTool: toolProtocolHash([taskToolDefinition(["search"])]),
		jobTool: toolProtocolHash([JOB_TOOL_DEF]),
		nativeTools: toolProtocolHash(
			registry
				.snapshot()
				.tools()
				.map(({ tool }) => tool),
		),
		fixedOfferedTools,
		fixedCodemodeSection,
		replyRecovery: sha256Short(REPLY_RECOVERY_PROMPT),
		eventSerialize: GOLDEN.eventSerialize,
		boundedBatchSerialize: GOLDEN.boundedBatchSerialize,
	};
	assert.deepEqual(actual, GOLDEN);
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
	const event = (
		ingestSeq: number,
		kind: string,
		revision: number,
		eventDate: number,
		payload: unknown,
		messageId = 200,
	) => ({ ingestSeq, chatId: CHAT_ID, messageId, revision, kind, eventDate, payload }) as never;
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
	assert.equal(sha256Short(out), GOLDEN.eventSerialize);
	const bounded = serializeMessageEvents(
		schemaDb(),
		[
			event(1, "message", 0, row.date, row),
			event(
				2,
				"message",
				0,
				row.date,
				{
					...row,
					message_id: 201,
					text: "A short question must survive its long quoted parent.",
					reply_to_message_id: 199,
					reply_snapshot: JSON.stringify({ username: "bob", text: "long parent ".repeat(500) }),
				},
				201,
			),
			event(
				3,
				"message",
				0,
				row.date,
				{
					...row,
					message_id: 202,
					text: "This parent is already visible in this batch.",
					reply_to_message_id: 200,
					reply_snapshot: JSON.stringify({ username: "alice", text: row.text }),
				},
				202,
			),
		],
		4000,
	);
	assert.equal(sha256Short(bounded), GOLDEN.boundedBatchSerialize);
});

// Positional notes must never rewrite provider history or poison native compaction input.
test("sticker projection preserves prefixes and native stored messages", () => {
	const first = Object.freeze({ role: "user", content: "same batch", timestamp: 1 }) as Message;
	const second = Object.freeze({ role: "user", content: "same batch", timestamp: 1 }) as Message;
	const next = Object.freeze({ role: "user", content: "new batch", timestamp: 2 }) as Message;
	const entries = [
		{ kind: "telegram.input", model: [first], data: { stickerNote: "" } },
		{ kind: "telegram.input", model: [second], data: { stickerNote: "〔系统附注〕sticker s1" } },
	] as unknown as EntryRecord[];
	for (const entry of entries) {
		Object.freeze(entry.data);
		Object.freeze(entry.model);
		Object.freeze(entry);
	}
	const before = JSON.stringify(entries);
	const initial = projectStickerNotes([first, second], entries);
	assert.deepEqual(initial, [first, second, { role: "user", content: "〔系统附注〕sticker s1", timestamp: 1 }]);
	const later = projectStickerNotes(
		[first, second, next],
		[...entries, { kind: "telegram.input", model: [next] } as unknown as EntryRecord],
	);
	assert.deepEqual(later.slice(0, initial.length), initial);
	assert.equal(JSON.stringify(entries), before);
	assert.deepEqual(
		entries.flatMap((entry) => entry.model ?? []),
		[first, second],
	);
});
