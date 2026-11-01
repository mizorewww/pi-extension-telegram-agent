// Background scripts: a codemode script the bot hands off with the `job` tool so a long batch
// (dozens of conversions, many searches) runs outside the chat turn. It uses the same script tools
// and sandbox as codemode; its result returns as a note on the requester's message, which owes
// them a reply, exactly like a finished task.

import type { Database } from "bun:sqlite";
import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import { CODEMODE_MAX_OUTPUT_CHARS } from "../agent/extensions/codemode.ts";
import { getDaemonState, setDaemonState } from "../db/db.ts";
import { appendNoteEvent, type NotePayload } from "../db/message-events.ts";
import { log } from "../observability/log.ts";

export const JOB_TIMEOUT_MS = 15 * 60_000;
export const MAX_RUNNING_JOBS = 2;

export interface JobDeps {
	db: Database;
	botId: string;
	chatId: number;
	tools: () => CodemodeTool[];
	/** Owe the requester a reply and wake the bot. */
	wake: (originMessageId: number) => void;
	onNote: (note: NotePayload) => void;
}

interface RunningJob {
	sandbox: CodemodeSandbox;
	originMessageId: number;
	title: string;
}

export class JobError extends Error {}

export class JobRunner {
	private readonly running = new Map<string, RunningJob>();

	constructor(private readonly deps: JobDeps) {}

	/** Start the script and return its id at once; the result arrives later as a note. */
	start(originMessageId: number, title: string, code: string): string {
		if (this.running.size >= MAX_RUNNING_JOBS)
			throw new JobError(`already running ${this.running.size} jobs; wait for one to finish`);
		if (!code.trim()) throw new JobError("code is empty");
		const key = `job_seq:${this.deps.botId}`;
		const id = `j${Number(getDaemonState(this.deps.db, key) ?? "0") + 1}`;
		setDaemonState(this.deps.db, key, id.slice(1));
		const sandbox = new CodemodeSandbox({ tools: this.deps.tools(), timeoutMs: JOB_TIMEOUT_MS });
		this.running.set(id, { sandbox, originMessageId, title });
		log.info("tasks", "job_started", { bot_id: this.deps.botId, job_id: id });
		void sandbox
			.execute(code)
			.then((result) => {
				const output = [
					...result.output.map((item) => (item.type === "text" ? item.text : "[image omitted]")),
					...(result.ok && result.value !== undefined
						? [typeof result.value === "string" ? result.value : JSON.stringify(result.value)]
						: []),
				]
					.join("\n")
					.trim();
				const bounded =
					output.length > CODEMODE_MAX_OUTPUT_CHARS
						? `${output.slice(0, CODEMODE_MAX_OUTPUT_CHARS)}\n[job output truncated by host limit]`
						: output;
				if (result.ok) this.finish(id, "done", `${title}\n${bounded || "(no output)"}`);
				else this.finish(id, "failed", `${title}\n${bounded}\nScript error: ${result.error.message}`.trim());
			})
			.catch((error: unknown) => this.finish(id, "failed", `${title}\n${(error as Error).message}`))
			.finally(() => void sandbox.close());
		return id;
	}

	/** Daemon shutdown: a running job cannot resume, so its requester hears that it stopped. */
	stopAll(): void {
		for (const [id, job] of this.running) {
			this.finish(id, "interrupted", `${job.title}\ndaemon 重启，后台脚本被中断；需要的话重新运行。`);
			void job.sandbox.close();
		}
	}

	private finish(id: string, phase: "done" | "failed" | "interrupted", text: string): void {
		const job = this.running.get(id);
		if (!job) return;
		this.running.delete(id);
		const note: NotePayload = { bot_id: this.deps.botId, source: "job", task_id: id, phase, text };
		appendNoteEvent(this.deps.db, this.deps.chatId, job.originMessageId, `job:${this.deps.botId}:${id}:${phase}`, note);
		this.deps.onNote(note);
		this.deps.wake(job.originMessageId);
		log.info("tasks", "job_finished", { bot_id: this.deps.botId, job_id: id, phase });
	}
}
