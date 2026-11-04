// Per-bot tool wiring and execution handlers for BotRuntime.
// Tool names, descriptions, parameters and registration order follow src/agent/tools.ts.

import type { DatabaseSync as Database } from "node:sqlite";
import { join } from "node:path";
import { validateToolArguments, type JsonValue } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BotRuntimeTelemetry } from "./runtime-telemetry.ts";
import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import type { AppConfig, BotConfig } from "../config.ts";
import { groupMessage } from "../db/message-events.ts";
import { downloadSource, MEDIA_DOWNLOAD_MAX_BYTES, type MediaDownloadApi } from "../media/local-cache.ts";
import { ensureViewImages } from "../media/prepare-images.ts";
import type { WorkBox } from "../sandbox/box.ts";
import { JobRunner } from "../tasks/jobs.ts";
import { TaskError, type TaskManager } from "../tasks/manager.ts";
import type { BotApi } from "../telegram/api.ts";
import { MessageQueryError, queryMessages, type MessageQuery } from "../tools/messages.ts";
import { runTinyFishTool } from "../tools/search.ts";
import { CODEMODE_FINGERPRINT_ENTRY, type ViewImageDetails } from "./extensions/index.ts";
import { executeAgentSend } from "./send.ts";
import { renderMessageLine } from "./serialize.ts";
import {
	CODEMODE_TOOL_DEFS,
	JOB_TOOL_DEF,
	MAX_SENDS_PER_TURN,
	sendToolWithFiles,
	TOOL_DEFS,
	TOOL_EXPOSURE,
	taskToolDefinition,
	type JobParams,
	type ProviderToolProtocol,
	type SearchParams,
	type SendParams,
	type TaskParams,
	type ViewImageParams,
} from "./tools.ts";

/** A codemode tool result whose script-facing value is the same object the model sees as JSON. */
function structured<T extends object>(value: T) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: {},
		structuredContent: value as unknown as JsonValue,
	};
}

export interface BotTurn {
	sends: number;
	outcome: "none" | "sent" | "unknown";
}

export interface BotRuntimeToolHost {
	db: Database;
	bot: BotConfig;
	config: AppConfig;
	api: BotApi;
	botApis: ReadonlyMap<string, MediaDownloadApi>;
	videoTranscoder: boolean;
	box: WorkBox | null;
	tasks: TaskManager | null;
	allowedReactions: () => ReadonlySet<string> | null;
	triggerMessageId: () => number | null;
	turn: () => BotTurn;
	telemetry: Pick<BotRuntimeTelemetry, "recordEvent">;
	onSent: (raw: unknown) => void;
	stopTyping: () => void;
	resetBox: (reason: "tool") => Promise<void>;
	markVisible: (ids: readonly number[]) => void;
	wakeForTask: (originMessageId: number, owe: boolean) => void;
}

async function executeSend(host: BotRuntimeToolHost, params: SendParams, endsTurn = true) {
	// Scripts may send several times in one turn (an acknowledgement, then the result). The cap
	// only guards a looping script against flooding the group with messages; reactions post
	// nothing and are not counted.
	const turn = host.turn();
	const posts = Boolean(params.message || params.sticker || params.files?.length);
	if (posts && turn.sends >= MAX_SENDS_PER_TURN)
		throw new Error(
			`send failed: ${MAX_SENDS_PER_TURN} messages already this turn, which looks like a runaway loop; stop and tell the group what happened`,
		);
	if (posts) turn.sends++;
	const result = await executeAgentSend(params, {
		db: host.db,
		api: host.api,
		botId: host.bot.id,
		chatId: host.config.groupChatId,
		allowedReactions: host.allowedReactions(),
		box: host.box,
		triggerMessageId: host.triggerMessageId(),
		markVisible: (ids) => host.markVisible(ids),
		onSent: (raw) => host.onSent(raw),
		recordEvent: (kind, payload) => host.telemetry.recordEvent(kind, payload),
		stopTyping: () => {
			if (endsTurn) host.stopTyping();
		},
	});
	// Both successful sends and degraded terminal outcomes forbid an automatic resend.
	// A reaction-only turn created no message, so a direct address is still owed a reply.
	if ("outcome" in result.details) {
		turn.outcome = result.details.outcome === "unknown" ? "unknown" : "sent";
	} else if (result.details.sent.length > 0) {
		turn.outcome = "sent";
	}
	return result;
}

/** view_image: prepare one message's image files and return refs; bytes join at projection. */
async function executeViewImage(host: BotRuntimeToolHost, params: ViewImageParams, signal?: AbortSignal) {
	const chatId = host.config.groupChatId;
	const fail = (category: string): never => {
		host.telemetry.recordEvent("tool_view_image", { ok: false, category });
		throw new Error(`view_image failed: ${category}`);
	};
	const row = groupMessage(host.db, chatId, params.message_id);
	if (!row) return fail("message_not_found");
	const media = row.media ? (JSON.parse(row.media) as { file_unique_id?: unknown }) : null;
	if (typeof media?.file_unique_id !== "string") return fail("no_image");
	const prepared = await ensureViewImages(host.db, host.api, host.bot.id, media.file_unique_id, {
		cacheDir: join(host.config.dataDir, "media"),
		botApis: host.botApis,
		videoTranscoder: host.videoTranscoder,
		signal,
	});
	if (!prepared.ok) return fail(prepared.outcome);
	host.markVisible([row.message_id]);
	host.telemetry.recordEvent("tool_view_image", { ok: true, images: prepared.images.length });
	const line = renderMessageLine(host.db, row);
	const details: ViewImageDetails = { messageId: row.message_id, images: prepared.images };
	return {
		content: [
			{ type: "text" as const, text: `${line}\n[attached ${prepared.images.length} image(s) of #${row.message_id}]` },
		],
		details,
	};
}

/** The task tool: start, steer, cancel or list this bot's background tasks. */
async function executeTask(host: BotRuntimeToolHost, params: TaskParams): Promise<string> {
	const tasks = host.tasks!;
	switch (params.action) {
		case "start": {
			const origin = params.for_message ?? host.triggerMessageId();
			if (!params.workflow || !params.title?.trim() || !params.brief?.trim())
				throw new TaskError("start needs workflow, title and brief");
			if (origin == null) throw new TaskError("start needs for_message: the requester's message #id");
			const id = await tasks.start(host.bot.id, origin, params.workflow, params.title.trim(), params.brief.trim());
			host.telemetry.recordEvent("task_started", { task_id: id, workflow: params.workflow });
			return `started ${id}; tell the requester now, the result will arrive as [task ${id} …]`;
		}
		case "message":
			if (!params.task_id || !params.text?.trim()) throw new TaskError("message needs task_id and text");
			tasks.message(host.bot.id, params.task_id, params.text.trim());
			return `forwarded to ${params.task_id}`;
		case "cancel":
			if (!params.task_id) throw new TaskError("cancel needs task_id");
			tasks.cancel(host.bot.id, params.task_id);
			return `cancelled ${params.task_id}`;
		case "status":
			return tasks.describe(host.bot.id);
	}
}

/** tg_download: any attachment, by this bot's (or a sibling bot's) file_id, into /work/inbox. */
async function downloadToBox(
	host: BotRuntimeToolHost,
	messageId: number,
	signal?: AbortSignal,
): Promise<{ path: string; size: number; kind: string }> {
	const chatId = host.config.groupChatId;
	const row = groupMessage(host.db, chatId, messageId);
	const media = row?.media
		? (JSON.parse(row.media) as { kind: string; file_unique_id: string; file_id: string; file_size?: number })
		: null;
	if (!row || !media) throw new Error("tg_download failed: no attachment on that message");
	const tooBig =
		"tg_download failed: the file is larger than the 20 MB Telegram lets bots download; ask for a smaller file or a link";
	if ((media.file_size ?? 0) > MEDIA_DOWNLOAD_MAX_BYTES) throw new Error(tooBig);
	// Ingest records a file_id mapping for every bot that saw the media, so a stored message
	// with an attachment always resolves; only a removed sibling bot leaves it dangling.
	const source = downloadSource(host.db, host.api, host.bot.id, media.file_unique_id, host.botApis);
	if (!source) throw new Error("tg_download failed: file_id_unavailable");
	const file = await source.api.getFile(source.fileId, signal).catch((error: unknown) => {
		if (error instanceof Error && /file is too big/i.test(error.message)) throw new Error(tooBig);
		throw error;
	});
	if (!file.file_path) throw new Error("tg_download failed: telegram_file_unavailable");
	const bytes = await source.api.downloadFile(file.file_path, signal);
	const extension = /\.[A-Za-z0-9]{1,8}$/.exec(file.file_path)?.[0] ?? "";
	signal?.throwIfAborted();
	const path = await host.box!.writeFile(`inbox/${messageId}${extension}`, bytes);
	host.telemetry.recordEvent("tool_tg_download", { kind: media.kind, bytes: bytes.byteLength });
	return { path, size: bytes.byteLength, kind: media.kind };
}

export function buildBotRuntimeTools(host: BotRuntimeToolHost) {
	const chatId = host.config.groupChatId;
	const sendDef = host.box ? sendToolWithFiles() : TOOL_DEFS[0];
	const sendTool = defineTool({
		...sendDef,
		executionMode: "sequential",
		exposure: TOOL_EXPOSURE.send,
		// A script's send (nested id "<parent>/<n>") keeps typing on: the script is still working.
		execute: async (toolCallId: string, params: SendParams, signal?: AbortSignal) => {
			signal?.throwIfAborted();
			return await executeSend(host, params, !toolCallId.includes("/"));
		},
	});
	const searchTool = {
		...TOOL_DEFS[1],
		exposure: TOOL_EXPOSURE.search,
		execute: async (_toolCallId: string, params: SearchParams, signal?: AbortSignal) => {
			const result = await runTinyFishTool(host.config.tinyfishApiKey, params, {}, signal);
			host.telemetry.recordEvent(result.event.kind, result.event.payload);
			return {
				content: [{ type: "text" as const, text: result.content }],
				details: result.details,
			};
		},
	};
	const viewImageTool = {
		...TOOL_DEFS[2],
		exposure: TOOL_EXPOSURE.view_image,
		execute: async (_toolCallId: string, params: ViewImageParams, signal?: AbortSignal) =>
			await executeViewImage(host, params, signal),
	};
	const taskTool = {
		...taskToolDefinition(host.tasks?.workflows ?? []),
		exposure: TOOL_EXPOSURE.task,
		execute: async (_toolCallId: string, params: TaskParams) => ({
			content: [{ type: "text" as const, text: await executeTask(host, params) }],
			details: {},
		}),
	};
	const messagesTool = {
		...CODEMODE_TOOL_DEFS[0],
		exposure: "codemode" as const,
		execute: async (_toolCallId: string, params: MessageQuery) => {
			try {
				const result = queryMessages(host.db, chatId, params);
				host.telemetry.recordEvent("tool_messages", { rows: result.rows.length });
				return structured(result);
			} catch (error) {
				if (error instanceof MessageQueryError) throw new Error(error.message);
				throw error;
			}
		},
	};
	const [, downloadDef, execDef, resetDef] = CODEMODE_TOOL_DEFS;
	const boxTools = host.box
		? [
				{
					...downloadDef,
					exposure: "codemode" as const,
					execute: async (_toolCallId: string, params: { message_id: number }, signal?: AbortSignal) =>
						structured(await downloadToBox(host, params.message_id, signal)),
				},
				{
					...execDef,
					exposure: "codemode" as const,
					execute: async (
						_toolCallId: string,
						params: { command: string; timeout_s?: number },
						signal?: AbortSignal,
					) => {
						const result = await host.box!.exec(params.command, params.timeout_s, signal);
						host.telemetry.recordEvent("tool_sh_exec", {
							exit_code: result.exit_code,
							timed_out: result.timed_out,
							bytes: result.output.length,
							wall_ms: result.wall_ms,
						});
						return structured(result);
					},
				},
				{
					...resetDef,
					exposure: "codemode" as const,
					execute: async () => {
						await host.resetBox("tool");
						return structured({ reset: true });
					},
				},
			]
		: [];
	const scriptTools = host.bot.tools.codemode ? [messagesTool, ...boxTools] : [];
	// A background job reaches the script tools but never send, task or job: it runs outside
	// the turn and answers through its result note.
	const jobScriptTools = [...(host.bot.tools.search ? [searchTool] : []), messagesTool, ...boxTools];
	const jobs =
		host.bot.tools.codemode && host.bot.tools.send
			? new JobRunner({
					db: host.db,
					botId: host.bot.id,
					chatId,
					tools: () =>
						jobScriptTools.map((tool) => ({
							name: tool.name,
							description: tool.description,
							inputSchema: tool.parameters as unknown as CodemodeJsonSchema,
							...("outputSchema" in tool ? { outputSchema: tool.outputSchema as unknown as CodemodeJsonSchema } : {}),
							execute: async (args: unknown, context) => {
								// A job's sandbox calls tools directly, outside Pi's tool pipeline: validate like a turn does.
								const params = validateToolArguments(tool as never, {
									type: "toolCall",
									id: "job",
									name: tool.name,
									arguments: args as never,
								});
								const result = await (
									tool.execute as (id: string, params: unknown, signal: AbortSignal) => Promise<any>
								)("job", params, context.signal);
								return (
									result.structuredContent ??
									result.content.map((block: { text?: string }) => block.text ?? "").join("\n")
								);
							},
						})),
					wake: (originMessageId) => host.wakeForTask(originMessageId, true),
				})
			: null;
	const jobTool = {
		...JOB_TOOL_DEF,
		exposure: TOOL_EXPOSURE.job,
		execute: async (_toolCallId: string, params: JobParams) => {
			const origin = params.for_message ?? host.triggerMessageId();
			if (origin == null) throw new Error("job failed: needs for_message, the requester's message #id");
			const id = jobs!.start(origin, params.title.trim(), params.code);
			host.telemetry.recordEvent("job_started", { job_id: id });
			return {
				content: [
					{
						type: "text" as const,
						text: `started ${id}; tell the requester now, the result will arrive as [job ${id} …]`,
					},
				],
				details: {},
			};
		},
	};

	// Tool order is cache-visible protocol: never reorder (docs/cache.md).
	const activeTools = [
		...(host.bot.tools.send ? [sendTool] : []),
		...(host.bot.tools.search ? [searchTool] : []),
		...(host.bot.tools.viewImage ? [viewImageTool] : []),
		...(host.tasks ? [taskTool] : []),
		...(jobs ? [jobTool] : []),
	];
	// Pi renders the codemode declaration from the callable tools; it is pinned by the Pi
	// version and these tools, both already in the fingerprint.
	const declaredTools: readonly ProviderToolProtocol[] = host.bot.tools.codemode
		? [...activeTools, CODEMODE_FINGERPRINT_ENTRY, ...scriptTools]
		: activeTools;

	// Pi can abort a codemode VM before its host tool finishes. Join those host effects before
	// replacing the session or closing SQLite; native signals prevent queued calls from starting.
	const pending = new Set<Promise<unknown>>();
	for (const tool of [...activeTools, ...scriptTools] as ToolDefinition[]) {
		const execute = tool.execute;
		tool.execute = (...args) => {
			const work = Promise.resolve()
				.then(() => {
					args[2]?.throwIfAborted();
					return execute(...args);
				})
				.finally(() => pending.delete(work));
			pending.add(work);
			return work;
		};
	}
	return { activeTools, scriptTools, declaredTools, jobs, waitForTools: () => Promise.allSettled([...pending]) };
}
