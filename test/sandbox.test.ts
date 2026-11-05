// Security invariant: tool execution stays in a credential-free rootless box; outbound files cannot escape /work or exceed the send limit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ok, type BinaryReader } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BoxError, normalizeBoxPath, WorkBox } from "../src/sandbox/box.ts";

const CONFIG = {
	image: "tg-box:1",
	dockerHost: "unix:///run/tgbox/docker.sock",
	memory: "1g",
	cpus: 2,
	pids: 256,
	network: true,
};

test("rootless isolation, mounts and paths stay bounded", async () => {
	const args = new WorkBox(CONFIG).runArgs();
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
		assert.ok(joined.includes(flag));
	assert.ok(!joined.includes("--privileged"));
	assert.deepEqual(
		args.flatMap((arg, i) => (arg === "--volume" ? [args[i + 1]] : [])),
		["tg-work:/work"],
	);
	assert.deepEqual(
		args.flatMap((arg, i) => (arg === "--env" ? [args[i + 1]] : [])),
		["HOME=/work/.home"],
	);
	assert.ok(new WorkBox({ ...CONFIG, network: false }).runArgs().join(" ").includes("--network none"));
	assert.equal(normalizeBoxPath("out/a.png"), "/work/out/a.png");
	for (const path of ["/etc/passwd", "../etc/passwd", "/work/../etc", "/workx/a", "a\nb"])
		assert.throws(() => normalizeBoxPath(path), BoxError);
	const env = new NodeExecutionEnv({ cwd: "/" });
	env.canonicalPath = async () => ok("/etc/passwd");
	env.openBinaryReader = async () => {
		throw new Error("must reject escape before reading");
	};
	await assert.rejects(new WorkBox(CONFIG, undefined, env).copyOut("link", 1000), BoxError);
});

test("outbound file uses a no-follow handle and rejects growth beyond the limit", async () => {
	const env = new NodeExecutionEnv({ cwd: "/" });
	let closed = false;
	const reader: BinaryReader = {
		info: async () => ok({ name: "file", path: "/work/file", kind: "file", size: 5, mtimeMs: 0 }),
		read: async (_offset, length) => {
			assert.equal(length, 11);
			return ok(new Uint8Array(11));
		},
		scanLines: async () => {
			throw new Error("unused");
		},
		close: async () => {
			closed = true;
		},
	};
	env.canonicalPath = async () => ok("/work/file");
	env.openBinaryReader = async (_path, options) => {
		assert.equal(options?.noFollow, true);
		return ok(reader);
	};
	await assert.rejects(new WorkBox(CONFIG, undefined, env).copyOut("file", 10), BoxError);
	assert.equal(closed, true);
});
