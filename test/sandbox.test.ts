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
