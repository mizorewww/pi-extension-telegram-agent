// Telegram tools are ordinary Pi Durable tools; Pi owns validation, code mode and nested-call cleanup.
import type { Database } from "../db/db.ts";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import {
	defineDoc,
	defineExtension,
	defineTool,
	hook,
	LiveDoc,
	ToolTask,
	type Conversation,
	type Extension,
	type Harness,
	type HookApi,
	type ToolExecutionApi,
	type ToolRegistration,
	type ToolTaskCheckpoint,
} from "@earendil-works/pi-durable";
import type { AppConfig, BotConfig } from "../config.ts";
import { groupMessage } from "../db/message-events.ts";
import { fileIdFor, MEDIA_DOWNLOAD_MAX_BYTES } from "../media/local-cache.ts";
import type { WorkBox } from "../sandbox/box.ts";
import { TaskManager } from "../tasks/manager.ts";
import type { BotApi } from "../telegram/api.ts";
import { queryMessages, semanticMessages } from "../tools/messages.ts";
import type { SemanticIndex } from "../tools/semantic.ts";
import { runTinyFishTool } from "../tools/search.ts";
import { telegramCodemode } from "./extensions/codemode.ts";
import { executeAgentSend } from "./send.ts";
import {
	CODEMODE_TOOL_DEFS,
	messagesToolWithSemantic,
	JOB_TOOL_DEF,
	MAX_SENDS_PER_TURN,
	sendToolWithFiles,
	TOOL_DEFS,
	taskToolDefinition,
	type SendParams,
} from "./tools.ts";

export interface BotRuntimeToolHost {
	db: Database;
	bot: BotConfig;
	config: AppConfig;
	api: BotApi;
	videoTranscoder: boolean;
	box: WorkBox | null;
	/** Present when tools.semantic is on; tg_messages then offers semantic recall. */
	semantic?: SemanticIndex;
	harness(): Harness;
	conversation(): Conversation;
	allowedReactions(): ReadonlySet<string> | null;
	currentMessage(api: ToolExecutionApi, context: Context): Promise<number | null>;
	recordSend(
		api: Pick<HookApi, "taskId" | "conversationId">,
		context: Context,
		outcome: "sent" | "unknown",
	): Promise<void>;
	recordEvent(kind: string, payload: unknown): void;
	resetBox(reason: "tool"): Promise<void>;
}

const SendCount = defineDoc<{ run: number; count: number; blocked: boolean }>({
	kind: "telegram.send-count",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ run: 0, count: 0, blocked: false }),
	checkpointWhen: () => false,
});
const output = (text: string) => ({ output: [{ type: "text" as const, text }] });
const structured = (value: JsonValue) => ({ ...output(JSON.stringify(value)), structuredOutput: value });

async function send(host: BotRuntimeToolHost, params: SendParams, api: ToolExecutionApi, context: Context) {
	if (params.message || params.rich || params.sticker || params.files?.length) {
		await api.commit(async (tx) => {
			const run = (await tx.doc(LiveDoc, api.conversationId)).run?.first ?? api.taskId;
			const count = await tx.doc(SendCount, api.conversationId);
			if (count.run !== run) {
				count.run = run;
				count.count = 0;
				count.blocked = false;
			}
			if (count.blocked) throw new Error("no_retry: previous send outcome is unknown");
			if (count.count >= MAX_SENDS_PER_TURN) throw new Error("send limit reached; stop this script");
			count.count++;
		}, context);
	}
	context.abortSignal?.throwIfAborted();
	const result = await executeAgentSend(params, {
		db: host.db,
		api: host.api,
		chatId: host.config.groupChatId,
		allowedReactions: host.allowedReactions(),
		box: host.box,
		triggerMessageId: await host.currentMessage(api, context),
		recordEvent: (kind, payload) => host.recordEvent(kind, payload),
	});
	if ("outcome" in result.details || result.details.sent.length) {
		// A failed local receipt cannot make a committed/unknown Telegram create retryable.
		try {
			await host.recordSend(
				api,
				context,
				"outcome" in result.details && result.details.outcome === "unknown" ? "unknown" : "sent",
			);
		} catch {
			host.recordEvent("send_receipt_failed", { category: "local_failure" });
		}
	}
	return result;
}

async function download(host: BotRuntimeToolHost, messageId: number, signal?: AbortSignal) {
	const row = groupMessage(host.db, host.config.groupChatId, messageId);
	const media = row?.media
		? (JSON.parse(row.media) as { kind: string; file_unique_id: string; file_size?: number })
		: null;
	if (!media) throw new Error("message has no attachment");
	if ((media.file_size ?? 0) > MEDIA_DOWNLOAD_MAX_BYTES) throw new Error("Telegram downloads are limited to 20 MB");
	const fileId = fileIdFor(host.db, media.file_unique_id);
	if (!fileId) throw new Error("attachment is unavailable to this bot");
	const file = await host.api.getFile(fileId, signal);
	if (!file.file_path) throw new Error("Telegram file is unavailable");
	const bytes = await host.api.downloadFile(file.file_path, signal);
	signal?.throwIfAborted();
	const extension = /\.[A-Za-z0-9]{1,8}$/.exec(file.file_path)?.[0] ?? "";
	const path = await host.box!.writeFile(`inbox/${messageId}${extension}`, bytes);
	return { path, size: bytes.byteLength, kind: media.kind };
}

export async function buildBotRuntimeTools(
	host: BotRuntimeToolHost,
): Promise<{ extensions: Extension[]; tasks: TaskManager | null }> {
	const tools: ToolRegistration[] = [];
	if (host.bot.tools.send)
		tools.push(
			defineTool({
				...(host.box ? sendToolWithFiles() : TOOL_DEFS[0]),
				executionMode: "sequential",
				replay: "unsafe",
				execute: (args, api, context) => send(host, args, api, context),
			}),
		);
	if (host.bot.tools.search)
		tools.push(
			defineTool({
				...TOOL_DEFS[1],
				replay: "safe",
				execute: async (args, _api, context) => {
					const result = await runTinyFishTool(host.config.tinyfishApiKey, args, {}, context.abortSignal);
					host.recordEvent(result.event.kind, result.event.payload);
					return { ...output(result.content), details: result.details };
				},
			}),
		);
	if (host.bot.tools.codemode) {
		const semantic = host.semantic;
		tools.push(
			semantic
				? defineTool({
						...messagesToolWithSemantic(),
						callers: ["model", "tools"],
						replay: "safe",
						execute: async (args, _api, context) =>
							structured(
								(args.semantic === undefined
									? queryMessages(host.db, host.config.groupChatId, args)
									: await semanticMessages(
											host.db,
											host.config.groupChatId,
											semantic,
											{ ...args, semantic: args.semantic },
											context.abortSignal,
										)) as unknown as JsonValue,
							),
					})
				: defineTool({
						...CODEMODE_TOOL_DEFS[0],
						callers: ["model", "tools"],
						replay: "safe",
						execute: async (args) =>
							structured(queryMessages(host.db, host.config.groupChatId, args) as unknown as JsonValue),
					}),
		);
	}
	if (host.box)
		tools.push(
			defineTool({
				...CODEMODE_TOOL_DEFS[1],
				callers: ["model", "tools"],
				replay: "safe",
				execute: async (args, _api, context) => structured(await download(host, args.message_id, context.abortSignal)),
			}),
			defineTool({
				...CODEMODE_TOOL_DEFS[2],
				callers: ["model", "tools"],
				execute: async () => {
					await host.resetBox("tool");
					return structured({ reset: true });
				},
			}),
		);
	const extensions: Extension[] = [];
	if (host.box) extensions.push(createCodingTools({ images: await createNodePhotonImages() }));
	if (host.bot.tools.codemode) extensions.push(telegramCodemode());
	const childTools = ["search", "tg_messages", "tg_download", "read", "write", "edit", "bash", "codemode"].filter(
		(name) =>
			tools.some((tool) => tool.name === name) ||
			(host.box && ["read", "write", "edit", "bash"].includes(name)) ||
			(host.bot.tools.codemode && name === "codemode"),
	);
	const jobs = host.bot.tools.codemode && host.bot.tools.send;
	const tasks =
		host.bot.tools.tasks || jobs
			? new TaskManager(host.harness, host.conversation, host.config.tasks, childTools)
			: null;
	if (tasks && host.bot.tools.tasks)
		tools.push(
			defineTool({
				...taskToolDefinition(tasks.workflows),
				executionMode: "sequential",
				replay: "safe",
				execute: async (args, api, context) => {
					if (args.action === "status") return output(await tasks.describe());
					if (args.action === "cancel")
						return output((await tasks.cancel(args.task_id ?? "")) ? "cancelled" : "unknown task");
					if (args.action === "message") {
						if (!args.task_id || !args.text) throw new Error("message needs task_id and text");
						await tasks.message(args.task_id, args.text, api, context);
						return output("forwarded");
					}
					const origin = args.for_message ?? (await host.currentMessage(api, context));
					if (!origin || !args.title || !args.brief) throw new Error("start needs title, brief and an origin message");
					if (!groupMessage(host.db, host.config.groupChatId, origin)) throw new Error("origin is not a group message");
					return output(
						`started ${await tasks.start("task", origin, args.title, args.brief, args.workflow, api, context)}; tell the requester now`,
					);
				},
			}),
		);
	if (tasks && jobs)
		tools.push(
			defineTool({
				...JOB_TOOL_DEF,
				executionMode: "sequential",
				replay: "safe",
				execute: async (args, api, context) => {
					const origin = args.for_message ?? (await host.currentMessage(api, context));
					if (!origin || !groupMessage(host.db, host.config.groupChatId, origin))
						throw new Error("job needs a real origin message");
					return output(
						`started ${await tasks.start("job", origin, args.title, args.code, undefined, api, context)}; tell the requester now`,
					);
				},
			}),
		);
	extensions.unshift(
		defineExtension({
			name: "telegram-tools",
			tools,
			hooks: [
				hook(ToolTask, {
					beforeTool: async (call, api, context) => {
						if (call.name === "bash")
							return {
								arguments: {
									...call.arguments,
									timeout: Math.min(600, typeof call.arguments.timeout === "number" ? call.arguments.timeout : 60),
								},
							};
						if (call.name !== "send") return;
						const live = await host.harness().snapshot(LiveDoc, api.conversationId, context);
						const count = await host.harness().snapshot(SendCount, api.conversationId, context);
						if (count?.blocked && count.run === (live?.run?.first ?? api.taskId))
							return { block: "no_retry: a previous Telegram send may already have succeeded" };
					},
					afterTool: async (call, result, api, context) => {
						if (call.name !== "send") return;
						const stopped = result.diagnostics?.some((item) =>
							["interrupted", "restart_limit", "aborted"].includes(item.code ?? ""),
						);
						const state = stopped ? (await host.harness().getTask(api.taskId, context))?.state : undefined;
						// Pi's execute checkpoint is durable before the call; abandoned-at-call proves no side effect.
						const interrupted =
							state?.status === "running" && (state.checkpoint as ToolTaskCheckpoint).phase === "execute";
						if (!interrupted && !result.output?.some((item) => item.type === "text" && item.text === "no_retry"))
							return;
						await host.conversation().commit(async (tx) => {
							const run = (await tx.doc(LiveDoc, api.conversationId)).run?.first ?? api.taskId;
							const state = await tx.doc(SendCount, api.conversationId);
							state.run = run;
							state.blocked = true;
						}, context);
						await host.recordSend(api, context, "unknown");
						return interrupted
							? {
									output: [{ type: "text", text: "no_retry" }],
									details: { outcome: "unknown", sent: [] },
									control: { terminate: true },
								}
							: result;
					},
				}),
			],
		}),
	);
	if (tasks) extensions.push(tasks.extension);
	return { extensions, tasks };
}
