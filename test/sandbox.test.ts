// Work box boundary: the container always runs isolated with no host mount, and file paths can
// never leave /work, even through a symlink. The docker CLI is faked; no daemon is touched.

import { expect, test } from "bun:test";
import { BoxError, type DockerRunner, normalizeBoxPath, WorkBox } from "../src/sandbox/box.ts";

const CONFIG = {
	image: "tg-box:1",
	dockerHost: "unix:///run/tgbox/docker.sock",
	memory: "1g",
	cpus: 2,
	pids: 256,
	network: true,
};

test("work box runs isolated, mounts nothing from the host, and paths cannot leave /work", async () => {
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
