// Pi owns background execution, replay, child ownership and cancellation. This is Telegram reporting policy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	configure,
	type Conversation,
	type ConversationHandle,
	type ConversationId,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type Harness,
	type SettledSubmissionRecord,
	type Submission,
	type TaskId,
	type ToolExecutionApi,
	ToolTask,
	type ToolTaskResult,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { obj, oneOf, str } from "@earendil-works/pi-schema";

export interface TasksConfig {
	workflows: Record<string, string>;
	maxRunning: number;
	timeoutMs: number;
}
type Phase = "running" | "need_input" | "done" | "failed" | "cancelled";
type TaskInfo = {
	child: ConversationId;
	origin: number;
	title: string;
	kind: "task" | "job";
	phase: Phase;
	reporter: TaskId;
	deadline?: TaskId;
	lastProgress: number;
};
const Tasks = defineDoc<{ items: Record<string, TaskInfo> }>({
	kind: "telegram.tasks",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: {} }),
	checkpointWhen: () => false,
});
const Child = defineDoc<{ parent: ConversationId | null; id: string }>({
	kind: "telegram.task-parent",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ parent: null, id: "" }),
	checkpointWhen: () => false,
});
// Admission and its receipt commit together: replay cannot create a second child or forward a message twice.
const Admission = defineDoc<{ result: string | null }>({
	kind: "telegram.task-admission",
	version: 1,
	scope: "task",
	initial: () => ({ result: null }),
	checkpointWhen: () => false,
});
const terminal = (phase: Phase) => phase === "done" || phase === "failed" || phase === "cancelled";
const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const aborted = { status: "terminal", outcome: { status: "aborted" } } as const;

const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "telegram.task-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: { done: (_task, runtime, context) => runtime.commit(() => finished, context) },
	abort: (_task, runtime, context) => runtime.commit(() => aborted, context),
});

function pause(runtime: { setTimer(callback: () => void, delayMs: number): () => void }, ms: number, context: Context) {
	return new Promise<void>((resolve, reject) => {
		const signal = context.abortSignal;
		if (signal?.aborted) return reject(signal.reason);
		const onAbort = () => {
			disarm();
			reject(signal?.reason);
		};
		const disarm = runtime.setTimer(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function settledOrWithdrawn(
	submission: Submission,
	subagent: ConversationHandle,
	waitPause: () => Promise<void>,
	context: Context,
): Promise<SettledSubmissionRecord | undefined> {
	const settled = submission.wait(context);
	for (;;) {
		const idle = subagent.waitForIdle(context).then(() => true);
		if (!(await Promise.race([settled.then(() => false), idle]))) return settled;
		if ((await submission.status(context)).status !== "queued") return settled;
		await waitPause();
		if ((await submission.status(context)).status !== "queued") return settled;
		if ((await submission.abort(context)) === "aborted") return undefined;
	}
}

function reportInput(id: string, row: TaskInfo, phase: Phase | "progress", text: string, requestId: string) {
	return {
		type: "input" as const,
		requestId,
		whenBusy: "followUp" as const,
		content: `[${row.kind} ${id} ${phase} ↪ #${row.origin}] ${row.title}\n${text.slice(0, 16_000)}`,
		entry: { kind: "telegram.task", data: { messageId: row.origin, taskId: id, phase } },
	};
}

const Reporter = defineTask<
	{ id: string; content: string },
	| { phase: "deliver" }
	| { phase: "wait"; execution: TaskId<ToolTaskResult> }
	| { phase: "report"; text: string; status: "done" | "failed" },
	null
>({
	name: "telegram.task-report",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, context) => {
			const row = (await runtime.snapshot(Tasks, runtime.conversationId, context))?.items[task.input.id];
			if (!row || terminal(row.phase)) return runtime.commit(() => finished, context);
			if (row.kind === "job") {
				const agent = await runtime.agent(context);
				const model = runtime.models.getModel(agent.model!.provider, agent.model!.modelId)!;
				const callId = `job:${task.id}`;
				await runtime.commit(async (tx) => {
					// A host-requested script is a Pi tool task, with no generation or model request.
					const entry = await tx.appendEntry(AssistantEntry, row.child, {
						model: [
							{
								role: "assistant",
								api: model.api,
								provider: model.provider,
								model: model.id,
								content: [{ type: "toolCall", id: callId, name: "codemode", arguments: { code: task.input.content } }],
								stopReason: "toolUse",
								timestamp: runtime.now(),
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							},
						],
					});
					const execution = await tx.createTask(
						ToolTask,
						{ kind: "model", assistant: entry.id, callId },
						{ conversationId: row.child, ownership: { kind: "conversation" } },
					);
					return { status: "running", checkpoint: { phase: "wait", execution } };
				}, context);
				return;
			}
			const child = (await runtime.conversation(row.child, context))!;
			const submission = await child.submit(
				{ type: "input", content: task.input.content, requestId: `task-input:${task.id}`, whenBusy: "steer" },
				context,
			);
			const result = await settledOrWithdrawn(submission, child, () => pause(runtime, 1_000, context), context);
			await runtime.commit(async (tx) => {
				const current = (await tx.doc(Tasks, runtime.conversationId)).items[task.input.id];
				if (!current || current.phase !== "running" || current.reporter !== task.id) return finished;
				const answer =
					result?.status === "done" && result.type === "input"
						? await tx.entry(AssistantEntry, result.answer)
						: undefined;
				const text = answer?.model?.[0]
					? contentText(answer.model[0].content)
					: result?.status === "unanswered"
						? result.reason
						: "No result";
				return { status: "running", checkpoint: { phase: "report", text, status: answer ? "done" : "failed" } };
			}, context);
		},
		wait: async (task, runtime, context) => {
			const result = await runtime.waitForTask(task.state.checkpoint.execution, context);
			const receipt = result.state.outcome.status === "completed" ? result.state.outcome.result : undefined;
			const row = (await runtime.snapshot(Tasks, runtime.conversationId, context))?.items[task.input.id];
			if (!row) return runtime.commit(() => finished, context);
			const entry =
				receipt?.kind === "model"
					? (await runtime.context(row.child, context)).entries.find((item) => item.id === receipt.entryId)
					: undefined;
			const message = entry?.model?.[0];
			await runtime.commit(
				() => ({
					status: "running",
					checkpoint: {
						phase: "report",
						text: (message ? contentText(message.content) : "") || "Script interrupted",
						status: message?.role === "toolResult" && !message.isError ? "done" : "failed",
					},
				}),
				context,
			);
		},
		report: async (task, runtime, context) => {
			const main = (await runtime.conversation(runtime.conversationId, context))!;
			await runtime.commit(async (tx) => {
				const row = (await tx.doc(Tasks, runtime.conversationId)).items[task.input.id];
				if (!row || terminal(row.phase) || row.reporter !== task.id) return finished;
				const result = task.state.checkpoint;
				await main.submit(tx, reportInput(task.input.id, row, result.status, result.text, `task-result:${task.id}`));
				row.phase = result.status;
				return finished;
			}, context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => aborted, context),
});

const Deadline = defineTask<{ id: string; at: number }, { phase: "sleep" } | { phase: "expire" }, null>({
	name: "telegram.task-deadline",
	version: 1,
	initial: () => ({ phase: "sleep" }),
	phases: {
		sleep: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: "expire" }, context),
		expire: async (task, runtime, context) => {
			const row = (await runtime.snapshot(Tasks, runtime.conversationId, context))?.items[task.input.id];
			if (row && !terminal(row.phase)) {
				const main = (await runtime.conversation(runtime.conversationId, context))!;
				let expired = false;
				await runtime.commit(async (tx) => {
					const current = (await tx.doc(Tasks, runtime.conversationId)).items[task.input.id];
					if (current && !terminal(current.phase)) {
						await main.submit(
							tx,
							reportInput(task.input.id, current, "failed", "Task deadline exceeded", `task-deadline:${task.input.id}`),
						);
						current.phase = "failed";
						expired = true;
					}
					return undefined;
				}, context);
				if (expired) await (await runtime.conversation(row.child, context))?.abort(context);
			}
			await runtime.commit(() => finished, context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => aborted, context),
});

const reportTool = defineTool({
	name: "report",
	description:
		"Report task progress, a question for the requester, or final results. Include generated file paths. need_input and done end this run.",
	parameters: obj({
		kind: oneOf(["progress", "need_input", "done"]),
		text: str({ minLength: 1, maxLength: 16000 }),
	}),
	callers: ["model"],
	deferred: true,
	replay: "safe",
	execute: async (args, api, context) => {
		const child = await api.snapshot(Child, api.conversationId, context);
		if (!child?.parent) throw new Error("report is only available inside a task");
		const parent = (await api.conversation(child.parent, context))!;
		await api.commit(async (tx) => {
			const row = (await tx.doc(Tasks, child.parent!)).items[child.id];
			if (!row || terminal(row.phase) || (args.kind === "progress" && api.now() - row.lastProgress < 300_000)) return;
			await parent.submit(tx, reportInput(child.id, row, args.kind, args.text, `task-report:${api.taskId}`));
			row.phase = args.kind === "progress" ? "running" : args.kind;
			row.lastProgress = api.now();
			// Pi stops only all-terminate rounds; cap this round when report shares it with another tool.
			if (args.kind !== "progress") await configure(tx, api.conversationId, { maxTurns: 1 });
		}, context);
		return { output: [{ type: "text", text: "reported" }], control: { terminate: args.kind !== "progress" } };
	},
});

export class TaskManager {
	readonly extension = defineExtension({
		name: "telegram-tasks",
		tasks: [Anchor, Reporter, Deadline],
		tools: [reportTool],
	});
	constructor(
		private readonly harness: () => Harness,
		private readonly conversation: () => Conversation,
		private readonly config: TasksConfig | null,
		private readonly childTools: readonly string[],
	) {}
	get workflows(): string[] {
		return Object.keys(this.config?.workflows ?? {}).sort();
	}
	private async rows() {
		return (await this.harness().snapshot(Tasks, this.conversation().id, BACKGROUND_CONTEXT))?.items ?? {};
	}
	async busy(): Promise<boolean> {
		return Object.values(await this.rows()).some((row) => !terminal(row.phase));
	}
	async describe(): Promise<string> {
		const lines = await Promise.all(
			Object.entries(await this.rows())
				.slice(-20)
				.map(async ([id, row]) => {
					const usage = await this.harness().snapshot(UsageDoc, row.child, BACKGROUND_CONTEXT);
					const values = [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})];
					const tokens = values.reduce((sum, value) => sum + value.totalTokens, 0);
					const cost = values.reduce((sum, value) => sum + value.cost.total, 0);
					return `${id} [${row.phase}] ${row.title} (↪ #${row.origin}; ${Math.round(tokens / 1000)}k tokens; $${cost.toFixed(2)})`;
				}),
		);
		return lines.join("\n") || "no tasks yet";
	}
	async clear(): Promise<void> {
		const existing = Object.values(await this.rows());
		await this.conversation().commit(async (tx) => {
			(await tx.doc(Tasks, this.conversation().id)).items = {};
		}, BACKGROUND_CONTEXT);
		for (const row of existing) {
			if (terminal(row.phase)) continue;
			await this.harness().abortTask(row.reporter, BACKGROUND_CONTEXT);
			if (row.deadline) await this.harness().abortTask(row.deadline, BACKGROUND_CONTEXT);
			await (await this.harness().conversation(row.child, BACKGROUND_CONTEXT))?.abort(BACKGROUND_CONTEXT);
		}
	}

	async start(
		kind: "task" | "job",
		origin: number,
		title: string,
		content: string,
		workflow: string | undefined,
		api: ToolExecutionApi,
		context: Context,
	): Promise<string> {
		if (kind === "task" && (!workflow || !this.config?.workflows[workflow])) throw new Error("unknown workflow");
		const instructions =
			kind === "task"
				? readFileSync(join(this.config!.workflows[workflow!]!, "AGENTS.md"), "utf8")
				: "Run the supplied script.";
		return api.commit(async (tx) => {
			const admission = await tx.doc(Admission, api.taskId);
			if (admission.result) return admission.result;
			const state = await tx.doc(Tasks, api.conversationId);
			// The UI exposes recent history; Pi retains the underlying task journal and usage.
			for (const [id] of Object.entries(state.items)
				.filter(([, row]) => terminal(row.phase))
				.slice(0, -20))
				delete state.items[id];
			if (
				Object.values(state.items).filter((row) => row.kind === kind && !terminal(row.phase)).length >=
				(kind === "job" ? 4 : this.config!.maxRunning)
			)
				throw new Error("background concurrency limit reached");
			const background = { ownership: { kind: "conversation" }, background: true } as const;
			const anchor = await tx.createTask(Anchor, null, background);
			const id = `${kind === "job" ? "j" : "t"}${anchor}`;
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			await configure(tx, child.id, {
				instructions: `${instructions}\n${kind === "task" ? "Use report for progress, need_input or done. You cannot send to Telegram directly." : ""}`,
				tools: api.registry
					.tools()
					.map(({ tool }) => tool)
					.filter(
						(tool) =>
							(this.childTools.includes(tool.name) &&
								(kind === "job" || !["tg_messages", "tg_download"].includes(tool.name))) ||
							(kind === "task" && tool.name === "report"),
					),
				modelTools: kind === "task" ? { add: [reportTool] } : null,
			});
			const meta = await tx.doc(Child, child.id);
			meta.parent = api.conversationId;
			meta.id = id;
			const deadlineAt = api.now() + (kind === "job" ? 3_600_000 : this.config!.timeoutMs);
			const deadline = await tx.createTask(Deadline, { id, at: deadlineAt }, background);
			state.items[id] = {
				child: child.id,
				origin,
				title,
				kind,
				phase: "running",
				reporter: await tx.createTask(Reporter, { id, content }, background),
				deadline,
				lastProgress: 0,
			};
			admission.result = id;
			return id;
		}, context);
	}
	async message(id: string, content: string, api: ToolExecutionApi, context: Context): Promise<void> {
		await api.commit(async (tx) => {
			const admission = await tx.doc(Admission, api.taskId);
			if (admission.result) return;
			const row = (await tx.doc(Tasks, api.conversationId)).items[id];
			if (!row || row.kind !== "task" || terminal(row.phase)) throw new Error("no active task with this id");
			row.phase = "running";
			await configure(tx, row.child, { maxTurns: null });
			row.reporter = await tx.createTask(
				Reporter,
				{ id, content },
				{ ownership: { kind: "conversation" }, background: true },
			);
			admission.result = id;
		}, context);
	}
	async cancel(id: string): Promise<boolean> {
		let target: { child: ConversationId; reporter: TaskId; deadline?: TaskId } | null = null;
		await this.conversation().commit(async (tx) => {
			const current = (await tx.doc(Tasks, this.conversation().id)).items[id];
			if (!current || terminal(current.phase)) return;
			await this.conversation().submit(
				tx,
				reportInput(id, current, "cancelled", "Cancelled by request", `task-cancel:${id}`),
			);
			current.phase = "cancelled";
			target = { child: current.child, reporter: current.reporter, deadline: current.deadline };
		}, BACKGROUND_CONTEXT);
		if (!target) return false;
		const { child, reporter, deadline } = target as { child: ConversationId; reporter: TaskId; deadline?: TaskId };
		await this.harness().abortTask(reporter, BACKGROUND_CONTEXT);
		if (deadline) await this.harness().abortTask(deadline, BACKGROUND_CONTEXT);
		await (await this.harness().conversation(child, BACKGROUND_CONTEXT))?.abort(BACKGROUND_CONTEXT);
		return true;
	}
}
