// One task run: a throwaway container from the work-box image running Pi in RPC mode inside
// the bot's /work volume, with the task Pi home (credentials, settings) mounted at /pi-agent.
// The daemon only reads the RPC event stream: `report` tool calls are the task's messages to
// the bot, `agent_settled` ends a run. Threat model: docs/architecture.md "任务威胁模型".

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { BoxConfig } from "../sandbox/box.ts";

export interface TaskRunConfig extends BoxConfig {
	taskMemory: string;
	taskCpus: number;
	/** Passed by name only (`--env TINYFISH_API_KEY`), so it never appears in argv. */
	tinyfishApiKey: string;
}

export type ReportKind = "progress" | "need_input" | "done";

export interface TaskProcessEvents {
	onReport(kind: ReportKind, text: string, files: string[]): void;
	/** One agent run finished; `lastText` is the final assistant text, if any. */
	onSettled(lastText: string | null): void;
	onExit(code: number | null): void;
}

export type Spawner = (
	command: string,
	args: readonly string[],
	env: Record<string, string>,
) => ChildProcessWithoutNullStreams;

const defaultSpawner: Spawner = (command, args, env) => spawn(command, [...args], { env, stdio: "pipe" });

export class TaskProcess {
	private child: ChildProcessWithoutNullStreams | null = null;
	private buffer = "";
	private lastText: string | null = null;
	private killTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		readonly taskId: string,
		readonly botId: string,
		private readonly config: TaskRunConfig,
		private readonly events: TaskProcessEvents,
		private readonly spawner: Spawner = defaultSpawner,
	) {}

	get container(): string {
		return `tg-task-${this.botId}-${this.taskId}`;
	}

	get workdir(): string {
		return `/work/tasks/${this.taskId}`;
	}

	/** The container arguments are the task boundary; test/tasks.test.ts pins them. */
	runArgs(): string[] {
		return [
			"run",
			"--rm",
			"--interactive",
			"--name",
			this.container,
			"--label",
			`tg-task=${this.botId}`,
			"--user",
			"1000:1000",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--read-only",
			"--tmpfs",
			"/tmp:rw,nosuid,nodev,size=1g",
			"--shm-size",
			"512m",
			"--memory",
			this.config.taskMemory,
			"--cpus",
			String(this.config.taskCpus),
			"--pids-limit",
			"1024",
			"--network",
			this.config.network ? "bridge" : "none",
			"--env",
			"HOME=/work/.home",
			"--env",
			"PI_CODING_AGENT_DIR=/pi-agent",
			"--env",
			"TINYFISH_API_KEY",
			"--volume",
			`tg-work-${this.botId}:/work`,
			"--volume",
			`tg-pihome-${this.botId}:/pi-agent`,
			"--workdir",
			this.workdir,
			this.config.image,
			"pi",
			"-a",
			"-e",
			"/opt/tg-task-bridge/index.ts",
			"--mode",
			"rpc",
			"--no-session",
		];
	}

	start(brief: string): void {
		const child = this.spawner("docker", this.runArgs(), {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			DOCKER_HOST: this.config.dockerHost,
			TINYFISH_API_KEY: this.config.tinyfishApiKey,
		});
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.read(chunk));
		child.stderr.resume();
		child.on("close", (code) => {
			if (this.killTimer) clearTimeout(this.killTimer);
			this.child = null;
			this.events.onExit(code);
		});
		child.on("error", () => {
			/* close follows */
		});
		this.send({ type: "prompt", message: brief });
	}

	/** A message from the group: steer a running agent, or start the next run when it waits. */
	message(text: string, running: boolean): void {
		this.send(running ? { type: "steer", message: text } : { type: "prompt", message: text });
	}

	/** Orderly end: Pi exits once stdin closes. */
	finish(): void {
		this.child?.stdin.end();
	}

	cancel(): void {
		if (!this.child) return;
		this.send({ type: "abort" });
		this.child.stdin.end();
		const child = this.child;
		this.killTimer = setTimeout(() => {
			spawn("docker", ["rm", "--force", this.container], {
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DOCKER_HOST: this.config.dockerHost },
				stdio: "ignore",
			});
			child.kill("SIGKILL");
		}, 10_000);
	}

	private send(command: Record<string, unknown>): void {
		if (!this.child || this.child.stdin.writableEnded) return;
		this.child.stdin.write(`${JSON.stringify(command)}\n`);
	}

	/** RPC framing is LF-only; never split on U+2028/U+2029 (docs/rpc.md). */
	private read(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (line) this.handle(line);
			newline = this.buffer.indexOf("\n");
		}
	}

	private handle(line: string): void {
		let record: Record<string, any>;
		try {
			record = JSON.parse(line);
		} catch {
			return;
		}
		if (record.type === "tool_execution_start" && record.toolName === "report") {
			const args = (record.args ?? {}) as { kind?: unknown; text?: unknown; files?: unknown };
			if (args.kind !== "progress" && args.kind !== "need_input" && args.kind !== "done") return;
			if (typeof args.text !== "string" || !args.text.trim()) return;
			const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === "string") : [];
			this.events.onReport(args.kind, args.text.trim(), files.slice(0, 10));
			return;
		}
		if (record.type === "message_end" && record.message?.role === "assistant") {
			const text = (record.message.content ?? [])
				.filter((block: { type?: string }) => block.type === "text")
				.map((block: { text?: string }) => block.text ?? "")
				.join("")
				.trim();
			if (text) this.lastText = text;
			return;
		}
		if (record.type === "agent_settled") {
			const text = this.lastText;
			this.lastText = null;
			this.events.onSettled(text);
			return;
		}
		if (record.type === "response" && record.command === "prompt" && record.success === false) {
			this.cancel();
		}
	}
}
