// Task runs: the container arguments carry the isolation flags and no secret in argv, RPC framing
// survives U+2028 inside strings, and the lifecycle turns reports into this bot's own note
// events, owing the requester a reply when a task finishes, fails or needs input.

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { renderNote } from "../src/agent/serialize.ts";
import { listRecentMessageEvents, type NotePayload } from "../src/db/message-events.ts";
import { TaskManager } from "../src/tasks/manager.ts";
import { type Spawner, TaskProcess } from "../src/tasks/process.ts";

const CHAT = -1001;
const RUN = {
	image: "tg-box:2",
	dockerHost: "unix:///run/tgbox/docker.sock",
	memory: "1g",
	cpus: 2,
	pids: 256,
	network: true,
	taskMemory: "3g",
	taskCpus: 2,
	tinyfishApiKey: "tinyfish-secret",
};

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough };
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.stdin = new PassThrough();
	(child as unknown as { kill: () => void }).kill = () => child.emit("close", 137);
	return child;
}

test("task containers run isolated and never carry a secret in argv", () => {
	const args = new TaskProcess("t1", "A", RUN, { onUsage() {}, onReport() {}, onSettled() {}, onExit() {} }).runArgs();
	const joined = args.join(" ");
	for (const flag of ["--user 1000:1000", "--cap-drop ALL", "--security-opt no-new-privileges", "--read-only", "--rm"])
		expect(joined).toContain(flag);
	expect(joined).not.toContain("--privileged");
	expect(args.flatMap((arg, i) => (arg === "--volume" ? [args[i + 1]] : []))).toEqual([
		"tg-work-A:/work",
		"tg-pihome-A:/pi-agent",
	]);
	expect(joined).not.toContain("tinyfish-secret");
	expect(args).toContain("TINYFISH_API_KEY");
	expect(joined).toContain(
		"pi -a -e /opt/tg-task-bridge/index.ts --mode rpc --session-dir /work/tasks/t1/.pi-sessions --session-id t1",
	);
});

test("task lifecycle notes belong to the bot, throttle progress and owe the requester", async () => {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const child = fakeChild();
	const spawner = (() => child) as unknown as Spawner;
	const wakes: [string, number, boolean][] = [];
	const extracted: string[] = [];
	const manager = new TaskManager({
		db,
		chatId: CHAT,
		config: { workflows: { search: "/unused" }, maxRunning: 2, timeoutMs: 60_000 },
		run: RUN,
		box: () => ({ extractTar: async (dir: string) => void extracted.push(dir) }) as never,
		wake: (botId, origin, owe) => wakes.push([botId, origin, owe]),
		spawner,
		packWorkflow: async () => new Uint8Array(),
	});
	const sent: string[] = [];
	child.stdin.on("data", (chunk: Buffer) => sent.push(chunk.toString()));
	const id = await manager.start("A", 42, "search", "调研", "查一下 X");
	expect(extracted).toEqual([`/work/tasks/${id}`]);
	expect(sent.join("")).toContain('"type":"prompt"');
	const emit = (record: unknown) => child.stdout.write(`${JSON.stringify(record)}\n`);
	const report = (kind: string, text: string) =>
		emit({ type: "tool_execution_start", toolName: "report", args: { kind, text } });
	report("progress", "刚开始"); // inside the throttle window: kept for later, no wake
	report("need_input", "要中文还是英文？\u2028（分隔符不能切帧）");
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			provider: "devin",
			model: "swe-2",
			content: [],
			usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: { total: 0.01 } },
		},
	});
	report("done", "结果在这里");
	await new Promise((resolve) => setTimeout(resolve, 10));
	const notes = listRecentMessageEvents(db, CHAT, 0, 1_000, 100).map((event) => event.payload as NotePayload);
	expect(notes.map((note) => note.phase)).toEqual(["need_input", "done"]);
	expect(notes.every((note) => note.bot_id === "A" && note.task_id === id)).toBe(true);
	expect(notes[0]!.text).toContain("\u2028");
	expect(wakes).toEqual([
		["A", 42, true],
		["A", 42, true],
	]);
	expect(manager.list("A")[0]!.status).toBe("done");
	expect(db.query("SELECT SUM(output_tokens) o, SUM(cost) c FROM task_usage WHERE task_id = ?").get(id)).toEqual({
		o: 5,
		c: 0.01,
	});
	expect(renderNote(42, notes[1]!)).toBe(`[task ${id} 完成 ↪ #42] 结果在这里`);

	// A second task whose process dies without a result fails and still owes a reply.
	const second = fakeChild();
	(manager as unknown as { deps: { spawner: Spawner } }).deps.spawner = (() => second) as unknown as Spawner;
	const failed = await manager.start("A", 43, "search", "再查", "查 Y");
	second.emit("close", 1);
	expect(manager.list("A").find((row) => row.task_id === failed)!.status).toBe("failed");
	expect(wakes.at(-1)).toEqual(["A", 43, true]);
});

test("tasks survive a daemon restart: running ones resume, waiting ones wait for the answer", async () => {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const children: ReturnType<typeof fakeChild>[] = [];
	const prompts: string[][] = [];
	const spawner = (() => {
		const child = fakeChild();
		const sent: string[] = [];
		prompts.push(sent);
		child.stdin.on("data", (chunk: Buffer) => sent.push(chunk.toString()));
		children.push(child);
		return child;
	}) as unknown as Spawner;
	const wakes: number[] = [];
	const deps = {
		db,
		chatId: CHAT,
		config: { workflows: { search: "/unused" }, maxRunning: 2, timeoutMs: 60 * 60_000 },
		run: RUN,
		box: () => ({ extractTar: async () => {} }) as never,
		wake: (_bot: string, origin: number) => void wakes.push(origin),
		spawner,
		packWorkflow: async () => new Uint8Array(),
		removeStaleContainers: async () => {},
	};
	const before = new TaskManager(deps);
	const running = await before.start("A", 50, "search", "一", "brief one");
	const waiting = await before.start("A", 51, "search", "二", "brief two");
	children[1]!.stdout.write(
		`${JSON.stringify({ type: "tool_execution_start", toolName: "report", args: { kind: "need_input", text: "哪种？" } })}\n`,
	);
	await new Promise((resolve) => setTimeout(resolve, 10));
	wakes.length = 0;
	before.stopAll();
	for (const child of children) child.emit("close", 137);
	expect(
		before
			.list("A")
			.map((row) => row.status)
			.sort(),
	).toEqual(["need_input", "running"]);
	expect(wakes).toEqual([]);

	const after = new TaskManager(deps);
	await after.recover();
	expect(children).toHaveLength(3); // only the running task restarted
	expect(prompts[2]!.join("")).toContain("daemon 重启");
	after.message("A", waiting, "要中文");
	expect(children).toHaveLength(4);
	expect(prompts[3]!.join("")).toContain("要中文");
	expect(after.list("A").find((row) => row.task_id === waiting)!.status).toBe("running");
	expect(running).toBe("t1");
});

test("a note reaches only the bot it belongs to", async () => {
	const { appendNoteEvent, eventsForBot } = await import("../src/db/message-events.ts");
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	appendNoteEvent(db, CHAT, 42, "a", { bot_id: "A", source: "task", task_id: "t1", phase: "done", text: "A 的结果" });
	appendNoteEvent(db, CHAT, 0, "b", { bot_id: "B", source: "system", text: "B 的工作区清空了" });
	const events = listRecentMessageEvents(db, CHAT, 0, 1_000, 100);
	expect(eventsForBot(events, "A").map((event) => (event.payload as NotePayload).text)).toEqual(["A 的结果"]);
	expect(eventsForBot(events, "B").map((event) => (event.payload as NotePayload).text)).toEqual(["B 的工作区清空了"]);
});

test("background jobs report done, failed or interrupted on the requester's message", async () => {
	const { JobRunner } = await import("../src/tasks/jobs.ts");
	const { renderNote } = await import("../src/agent/serialize.ts");
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const wakes: number[] = [];
	let release: () => void = () => {};
	const jobs = new JobRunner({
		db,
		botId: "A",
		chatId: CHAT,
		tools: () => [
			{ name: "probe", execute: async () => "pong" },
			{ name: "hold", execute: () => new Promise<string>((resolve) => (release = () => resolve("held"))) },
		],
		wake: (origin) => void wakes.push(origin),
		onNote: () => {},
	});
	const notes = () =>
		listRecentMessageEvents(db, CHAT, 0, 1_000, 100).map((event) => ({
			id: event.messageId,
			...(event.payload as NotePayload),
		}));
	const settle = async (count: number) => {
		while (notes().length < count) await new Promise((resolve) => setTimeout(resolve, 5));
	};

	const ok = jobs.start(10, "探测", "return await tools.probe({})");
	await settle(1);
	expect(notes()[0]).toMatchObject({ id: 10, source: "job", task_id: ok, phase: "done" });
	expect(renderNote(10, notes()[0]!)).toBe(`[job ${ok} 完成 ↪ #10] 探测\npong`);

	jobs.start(11, "出错", "throw new Error('boom')");
	await settle(2);
	expect(notes()[1]).toMatchObject({ id: 11, phase: "failed" });
	expect(notes()[1]!.text).toContain("boom");

	jobs.start(12, "一", "return await tools.hold({})");
	jobs.start(13, "二", "return await tools.hold({})");
	expect(() => jobs.start(14, "三", "return 1")).toThrow("already running");
	jobs.stopAll();
	expect(
		notes()
			.filter((note) => note.phase === "interrupted")
			.map((note) => note.id),
	).toEqual([12, 13]);
	expect(wakes).toEqual([10, 11, 12, 13]);
	release();
}, 30_000);
