// Task lifecycle for every bot: start, steer, cancel, and turning task reports into note events
// in the bot's own input stream. A finished or blocked task owes the requester a reply, so it
// creates a reply obligation on the origin message and wakes the bot; progress only wakes it
// at most every PROGRESS_INTERVAL_MS.

import type { DatabaseSync as Database } from "node:sqlite";
import { spawn } from "node:child_process";
import { appendNoteEvent, type NotePayload } from "../db/message-events.ts";
import { log } from "../observability/log.ts";
import { runDocker, type WorkBox } from "../sandbox/box.ts";
import { type ReportKind, type Spawner, TaskProcess, type TaskRunConfig, type TaskUsage } from "./process.ts";

export const PROGRESS_INTERVAL_MS = 5 * 60_000;
const RESUME_PROMPT =
	"（daemon 重启，你之前的运行被打断了。先根据会话和 /work 里的文件确认已经做到哪一步，再继续完成任务；完成时调用 report，kind 为 done。）";

export interface TasksConfig {
	/** workflow name -> host directory whose `.pi` is copied into each task. */
	workflows: Record<string, string>;
	maxRunning: number;
	timeoutMs: number;
}

export type TaskStatus = "running" | "need_input" | "done" | "failed" | "cancelled" | "interrupted";

export interface TaskRow {
	task_id: string;
	bot_id: string;
	origin_message_id: number;
	workflow: string;
	title: string;
	status: TaskStatus;
	created_at: number;
	updated_at: number;
	input_tokens: number;
	output_tokens: number;
	cost: number;
}

export interface TaskManagerDeps {
	db: Database;
	chatId: number;
	config: TasksConfig;
	run: TaskRunConfig;
	box: (botId: string) => WorkBox | null;
	/** Wake the bot; `owe` also creates a reply obligation on the origin message first. */
	wake: (botId: string, originMessageId: number, owe: boolean) => void;
	spawner?: Spawner;
	/** Removes leftover task containers before recovery; injectable for tests. */
	removeStaleContainers?: (dockerHost: string) => Promise<void>;
	/** Builds the `.pi` tar of a workflow directory; injectable for tests. */
	packWorkflow?: (dir: string) => Promise<Uint8Array>;
}

interface Live {
	process: TaskProcess;
	agentRunning: boolean;
	lastProgressAt: number;
	pendingProgress: string[];
	timer: ReturnType<typeof setTimeout>;
	terminal: boolean;
}

export class TaskError extends Error {}

const packWorkflowDir = (dir: string) =>
	new Promise<Uint8Array>((resolve, reject) => {
		const child = spawn("tar", ["-c", "-C", dir, ".pi"], { stdio: ["ignore", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0 ? resolve(new Uint8Array(Buffer.concat(chunks))) : reject(new TaskError("workflow unreadable")),
		);
	});

async function removeTaskContainers(dockerHost: string): Promise<void> {
	const options = { dockerHost, timeoutMs: 60_000 };
	try {
		const listed = await runDocker(["ps", "-aq", "--filter", "label=tg-task"], options);
		const ids = new TextDecoder().decode(listed.stdout).split(/\s+/).filter(Boolean);
		if (ids.length > 0) await runDocker(["rm", "--force", ...ids], options);
	} catch {
		// Best effort: startup recovery must not fail because the docker daemon is unreachable.
	}
}

export class TaskManager {
	private readonly live = new Map<string, Live>();
	private stopping = false;

	constructor(private readonly deps: TaskManagerDeps) {}

	get workflows(): string[] {
		return Object.keys(this.deps.config.workflows).sort();
	}

	busy(botId: string): boolean {
		return [...this.live.values()].some((task) => task.process.botId === botId);
	}

	/** One line per recent task with its main-session usage, for the bot and for /task. */
	describe(botId: string, limit = 10): string {
		const rows = this.list(botId, limit);
		if (rows.length === 0) return "no tasks yet";
		return rows
			.map((row) => {
				const tokens = `${Math.round(row.input_tokens / 1000)}k in / ${Math.round(row.output_tokens / 1000)}k out`;
				const cost = row.cost > 0 ? ` $${row.cost.toFixed(2)}` : "";
				return `${row.task_id} [${row.status}] ${row.workflow}: ${row.title} (↪ #${row.origin_message_id}; ${tokens}${cost})`;
			})
			.join("\n");
	}

	list(botId: string, limit = 10): TaskRow[] {
		return this.deps.db
			.prepare("SELECT * FROM tasks WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?")
			.all(botId, limit) as unknown as TaskRow[];
	}

	/**
	 * Pick up the tasks a previous daemon left behind. Their Pi sessions live in /work, so a
	 * running task resumes from its session and a task waiting for input waits again.
	 */
	async recover(): Promise<void> {
		await (this.deps.removeStaleContainers ?? removeTaskContainers)(this.deps.run.dockerHost);
		const rows = this.deps.db
			.prepare("SELECT * FROM tasks WHERE status IN ('running', 'need_input') ORDER BY created_at")
			.all() as unknown as TaskRow[];
		for (const row of rows) {
			if (!this.deps.box(row.bot_id)) {
				this.setStatus(row.task_id, "interrupted");
				this.note(row, "interrupted", "工作区不可用，任务无法继续；需要的话重新开始。");
				this.deps.wake(row.bot_id, row.origin_message_id, true);
				continue;
			}
			const task = this.track(row.task_id, row.bot_id, row.created_at);
			if (row.status === "running") {
				task.process.start(RESUME_PROMPT);
				log.info("tasks", "task_resumed", { bot_id: row.bot_id, task_id: row.task_id });
			} else task.agentRunning = false;
		}
	}

	async start(botId: string, originMessageId: number, workflow: string, title: string, brief: string): Promise<string> {
		if (this.stopping) throw new TaskError("daemon is stopping");
		const dir = this.deps.config.workflows[workflow];
		if (!dir) throw new TaskError(`unknown workflow: ${workflow} (available: ${this.workflows.join(", ")})`);
		const box = this.deps.box(botId);
		if (!box) throw new TaskError("this bot has no work box");
		const running = [...this.live.values()].filter((task) => task.process.botId === botId).length;
		if (running >= this.deps.config.maxRunning)
			throw new TaskError(`already running ${running} tasks; finish or cancel one first`);
		const now = Date.now();
		const { lastInsertRowid } = this.deps.db
			.prepare(
				`INSERT INTO tasks (task_id, bot_id, chat_id, origin_message_id, workflow, title, status, created_at, updated_at)
				 VALUES ('', ?, ?, ?, ?, ?, 'running', ?, ?)`,
			)
			.run(botId, this.deps.chatId, originMessageId, workflow, title, now, now);
		// Ids from rowid, like sticker short ids: stable and race-free.
		const taskId = `t${lastInsertRowid}`;
		this.deps.db.prepare("UPDATE tasks SET task_id = ? WHERE rowid = ?").run(taskId, lastInsertRowid);
		const task = this.track(taskId, botId, now);
		try {
			await box.extractTar(task.process.workdir, await (this.deps.packWorkflow ?? packWorkflowDir)(dir));
		} catch (error) {
			clearTimeout(task.timer);
			this.live.delete(taskId);
			if (!task.terminal && !this.stopping) this.setStatus(taskId, "failed");
			throw new TaskError(`could not prepare the task: ${(error as Error).message}`);
		}
		if (task.terminal || this.stopping) throw new TaskError("task cancelled during preparation");
		task.process.start(`${brief}\n\n（任务标题：${title}。完成时调用 report，kind 为 done。）`);
		log.info("tasks", "task_started", { bot_id: botId, task_id: taskId, workflow });
		return taskId;
	}

	message(botId: string, taskId: string, text: string): void {
		const task = this.ownLive(botId, taskId);
		if (!task.process.started) task.process.start(text);
		else task.process.message(text, task.agentRunning);
		task.agentRunning = true;
		this.setStatus(taskId, "running");
	}

	cancel(botId: string, taskId: string): void {
		this.ownLive(botId, taskId);
		this.finish(taskId, "cancelled");
	}

	/** /new discards the session tasks were launched under. */
	async cancelAllForBot(botId: string): Promise<void> {
		await Promise.all(
			[...this.live].filter(([, task]) => task.process.botId === botId).map(([id]) => this.finish(id, "cancelled")),
		);
	}

	/** Daemon shutdown: stop the containers but keep the tasks resumable. */
	stopAll(): void {
		this.stopping = true;
		for (const [id, task] of this.live) {
			task.process.cancel();
			this.release(id);
		}
	}

	private track(taskId: string, botId: string, createdAt: number): Live {
		const process = new TaskProcess(
			taskId,
			botId,
			this.deps.run,
			{
				onUsage: (usage) => this.recordUsage(taskId, usage),
				onReport: (kind, text, files) => this.onReport(taskId, kind, text, files),
				onSettled: (lastText) => this.onSettled(taskId, lastText),
				onExit: (code) => this.onExit(taskId, code),
			},
			this.deps.spawner,
		);
		const remaining = Math.max(5 * 60_000, createdAt + this.deps.config.timeoutMs - Date.now());
		const timer = setTimeout(() => this.finish(taskId, "failed", "超过时间上限，已停止。"), remaining);
		timer.unref?.();
		const task: Live = {
			process,
			agentRunning: true,
			lastProgressAt: Date.now(),
			pendingProgress: [],
			timer,
			terminal: false,
		};
		this.live.set(taskId, task);
		return task;
	}

	private recordUsage(taskId: string, usage: TaskUsage): void {
		this.deps.db
			.prepare(
				"UPDATE tasks SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost = cost + ? WHERE task_id = ?",
			)
			.run(usage.input, usage.output, usage.cost, taskId);
	}

	private ownLive(botId: string, taskId: string): Live {
		const task = this.live.get(taskId);
		if (!task || task.terminal || task.process.botId !== botId) throw new TaskError(`no running task ${taskId}`);
		return task;
	}

	private row(taskId: string): TaskRow | null {
		return this.deps.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as unknown as TaskRow | null;
	}

	private setStatus(taskId: string, status: TaskStatus): void {
		this.deps.db
			.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?")
			.run(status, Date.now(), taskId);
	}

	private note(row: TaskRow, phase: NonNullable<NotePayload["phase"]>, text: string, files: string[] = []): void {
		const note: NotePayload = {
			bot_id: row.bot_id,
			source: "task",
			task_id: row.task_id,
			phase,
			text,
			...(files.length ? { files } : {}),
		};
		appendNoteEvent(
			this.deps.db,
			this.deps.chatId,
			row.origin_message_id,
			`task:${row.task_id}:${Date.now()}:${phase}`,
			note,
		);
	}

	private onReport(taskId: string, kind: ReportKind, text: string, files: string[]): void {
		const task = this.live.get(taskId);
		const row = this.row(taskId);
		if (!task || !row || task.terminal) return;
		if (kind === "progress") {
			task.pendingProgress.push(text);
			if (Date.now() - task.lastProgressAt < PROGRESS_INTERVAL_MS) return;
			task.lastProgressAt = Date.now();
			this.note(row, "progress", task.pendingProgress.splice(0).join("\n"));
			this.deps.wake(row.bot_id, row.origin_message_id, false);
			return;
		}
		if (kind === "need_input") {
			this.setStatus(taskId, "need_input");
			this.note(row, "need_input", text);
			this.deps.wake(row.bot_id, row.origin_message_id, true);
			return;
		}
		this.finish(taskId, "done", text, files);
	}

	private onSettled(taskId: string, lastText: string | null): void {
		const task = this.live.get(taskId);
		if (!task || task.terminal) return;
		task.agentRunning = false;
		// Waiting for an answer keeps the process; otherwise a run that ends without `done`
		// still delivers its last words as the result.
		if (this.row(taskId)?.status === "need_input") return;
		if (lastText) this.finish(taskId, "done", lastText);
		else this.finish(taskId, "failed", "任务没有给出结果就结束了。");
	}

	private finish(
		taskId: string,
		status: "done" | "failed" | "cancelled",
		text?: string,
		files: string[] = [],
	): Promise<void> | void {
		const task = this.live.get(taskId);
		const row = this.row(taskId);
		if (!task || !row) return;
		if (task.terminal) return task.process.cancel();
		task.terminal = true;
		this.setStatus(taskId, status);
		if (text != null) {
			this.note(row, status === "done" ? "done" : "failed", text, files);
			this.deps.wake(row.bot_id, row.origin_message_id, true);
		}
		const stopped = task.process.cancel();
		this.release(taskId);
		log.info("tasks", "task_finished", { bot_id: row.bot_id, task_id: taskId, status });
		return stopped;
	}

	private release(taskId: string): void {
		const task = this.live.get(taskId);
		clearTimeout(task?.timer);
		if (!task?.process.started) this.live.delete(taskId);
	}

	private onExit(taskId: string, code: number | null): void {
		const task = this.live.get(taskId);
		if (!task) return;
		if (!task.terminal && !this.stopping) this.finish(taskId, "failed", `任务进程意外退出（code ${code ?? "?"}）。`);
		this.release(taskId);
	}
}
