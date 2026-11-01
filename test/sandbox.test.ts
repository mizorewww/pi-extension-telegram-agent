// Work box boundary: the container arguments always carry the isolation flags and no host
// mount, file paths can never leave /work (also via symlinks resolved inside the box), and the
// weekly reset fires once per boundary. The docker CLI is faked; no daemon is touched.

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { BoxError, type DockerRunner, normalizeBoxPath, WorkBox } from "../src/sandbox/box.ts";
import { lastWeeklyBoundary, runWeeklyBoxReset } from "../src/sandbox/schedule.ts";

const CONFIG = {
	image: "tg-box:1",
	dockerHost: "unix:///run/tgbox/docker.sock",
	memory: "1g",
	cpus: 2,
	pids: 256,
	network: true,
};

test("work box containers always run isolated and mount nothing from the host", () => {
	const args = new WorkBox("A", CONFIG).runArgs();
	const joined = args.join(" ");
	for (const flag of [
		"--user 1000:1000",
		"--cap-drop ALL",
		"--security-opt no-new-privileges",
		"--read-only",
		"--memory 1g",
		"--cpus 2",
		"--pids-limit 256",
	])
		expect(joined).toContain(flag);
	expect(joined).not.toContain("--privileged");
	const volumes = args.flatMap((arg, i) => (arg === "--volume" ? [args[i + 1]!] : []));
	expect(volumes).toEqual(["tg-work-A:/work"]);
	const env = args.flatMap((arg, i) => (arg === "--env" ? [args[i + 1]!] : []));
	expect(env).toEqual(["HOME=/work/.home"]);
	expect(new WorkBox("A", { ...CONFIG, network: false }).runArgs().join(" ")).toContain("--network none");
});

test("box paths cannot leave /work, even through a symlink", async () => {
	expect(normalizeBoxPath("out/a.png")).toBe("/work/out/a.png");
	for (const bad of ["/etc/passwd", "../etc/passwd", "/work/../etc", "/workx/a", "a\nb"])
		expect(() => normalizeBoxPath(bad)).toThrow(BoxError);
	const docker: DockerRunner = async (args) => {
		const text = (value: string) => ({ code: 0, stdout: new TextEncoder().encode(value), stderr: "", timedOut: false });
		if (args[0] === "inspect") return text("true");
		if (args.includes("realpath")) return text("/etc/passwd\n");
		throw new Error(`unexpected docker ${args.join(" ")}`);
	};
	await expect(new WorkBox("A", CONFIG, docker).copyOut("link", 1_000_000)).rejects.toThrow(BoxError);
});

test("weekly reset fires once after each Monday 05:00 and never on first sight", async () => {
	expect(lastWeeklyBoundary(new Date(2026, 10, 4, 10)).getTime()).toBe(new Date(2026, 10, 2, 5).getTime());
	expect(lastWeeklyBoundary(new Date(2026, 10, 2, 4, 59)).getTime()).toBe(new Date(2026, 9, 26, 5).getTime());
	expect(lastWeeklyBoundary(new Date(2026, 10, 2, 5)).getTime()).toBe(new Date(2026, 10, 2, 5).getTime());
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	let resets = 0;
	const boxes = [{ botId: "A", resetBox: async () => void resets++ }];
	await runWeeklyBoxReset(db, boxes, new Date(2026, 10, 1, 12));
	expect(resets).toBe(0);
	await runWeeklyBoxReset(db, boxes, new Date(2026, 10, 2, 4));
	expect(resets).toBe(0);
	await runWeeklyBoxReset(db, boxes, new Date(2026, 10, 2, 5, 10));
	await runWeeklyBoxReset(db, boxes, new Date(2026, 10, 2, 5, 20));
	expect(resets).toBe(1);
});

test("send with a missing box file fails before anything reaches Telegram", async () => {
	const { executeAgentSend } = await import("../src/agent/send.ts");
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	let creates = 0;
	const api = new Proxy({}, { get: () => async () => void creates++ });
	const docker: DockerRunner = async (args) => ({
		code: args[0] === "inspect" ? 0 : 1,
		stdout: new TextEncoder().encode(args[0] === "inspect" ? "true" : ""),
		stderr: "",
		timedOut: false,
	});
	const noop = () => {};
	await expect(
		executeAgentSend(
			{ message: "here you go", files: [{ path: "out/missing.png" }] },
			{
				db,
				api: api as never,
				botId: "A",
				chatId: -1001,
				emitMediaUpdates: false,
				allowedReactions: null,
				box: new WorkBox("A", CONFIG, docker),
				triggerMessageId: null,
				recordPublicSend: noop,
				markVisible: noop,
				onSent: noop,
				recordEvent: noop,
				stopTyping: noop,
				recordDuration: noop,
			},
		),
	).rejects.toThrow("out/missing.png");
	expect(creates).toBe(0);
});

test("file sends upload as multipart: one photo, or an album with the reply on it", async () => {
	const { BotApi } = await import("../src/telegram/api.ts");
	const calls: { method: string; form: FormData }[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ method: String(url).split("/").pop()!, form: init!.body as FormData });
		const body = String(url).endsWith("sendMediaGroup") ? [{ message_id: 2 }, { message_id: 3 }] : { message_id: 1 };
		return new Response(JSON.stringify({ ok: true, result: body }));
	}) as typeof fetch;
	try {
		const api = new BotApi("token");
		const file = (name: string) => ({ name, bytes: new Uint8Array([1, 2, 3]) });
		expect(await api.sendFiles(-1001, "photo", [file("a.png")])).toEqual([{ message_id: 1 }]);
		expect(calls[0]!.method).toBe("sendPhoto");
		expect(calls[0]!.form.get("photo")).toBe("attach://f0");
		expect((calls[0]!.form.get("f0") as File).name).toBe("a.png");
		expect(await api.sendFiles(-1001, "document", [file("a.pdf"), file("b.pdf")], 42)).toHaveLength(2);
		expect(calls[1]!.method).toBe("sendMediaGroup");
		expect(JSON.parse(calls[1]!.form.get("media") as string)).toEqual([
			{ type: "document", media: "attach://f0" },
			{ type: "document", media: "attach://f1" },
		]);
		expect(JSON.parse(calls[1]!.form.get("reply_parameters") as string)).toEqual({ message_id: 42 });
	} finally {
		globalThis.fetch = original;
	}
});

test("sh_exec merges stderr without breaking a command that ends in a heredoc", async () => {
	let script = "";
	const docker: DockerRunner = async (args) => {
		if (args[0] === "inspect")
			return { code: 0, stdout: new TextEncoder().encode("true"), stderr: "", timedOut: false };
		script = args.at(-1)!;
		return { code: 0, stdout: new Uint8Array(), stderr: "", timedOut: false };
	};
	await new WorkBox("A", CONFIG, docker).exec("python3 - <<'EOF'\nprint(1)\nEOF");
	expect(script.startsWith("exec 2>&1\n")).toBe(true);
	expect(script.endsWith("\nEOF")).toBe(true);
});
