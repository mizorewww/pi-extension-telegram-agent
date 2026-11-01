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
	const args = new TaskProcess("t1", "A", RUN, { onReport() {}, onSettled() {}, onExit() {} }).runArgs();
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
	expect(joined).toContain("pi -a -e /opt/tg-task-bridge/index.ts --mode rpc --no-session");
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
	expect(renderNote(42, notes[1]!)).toBe(`[task ${id} 完成 ↪ #42] 结果在这里`);

	// A second task whose process dies without a result fails and still owes a reply.
	const second = fakeChild();
	(manager as unknown as { deps: { spawner: Spawner } }).deps.spawner = (() => second) as unknown as Spawner;
	const failed = await manager.start("A", 43, "search", "再查", "查 Y");
	second.emit("close", 1);
	expect(manager.list("A").find((row) => row.task_id === failed)!.status).toBe("failed");
	expect(wakes.at(-1)).toEqual(["A", 43, true]);
});
