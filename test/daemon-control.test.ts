// Process ownership: the controller only ever signals this deployment's own daemon pids.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOurDaemon, listOurDaemons } from "../src/daemon/pid.ts";

test("process ownership handles spaces and refuses another deployment", async () => {
	const root = mkdtempSync(join(tmpdir(), "telegram process test "));
	mkdirSync(join(root, "src", "daemon"), { recursive: true });
	writeFileSync(join(root, "src", "daemon", "index.ts"), 'console.log("ready"); setInterval(() => {}, 1000);');
	const child = Bun.spawn([process.execPath, "run", join(root, "src", "daemon", "index.ts")], {
		cwd: root,
		stdout: "pipe",
		stderr: "ignore",
	});
	try {
		const reader = child.stdout.getReader();
		await reader.read();
		reader.releaseLock();
		expect(isOurDaemon(child.pid, root)).toBe(true);
		expect(listOurDaemons(root)).toContain(child.pid);
		expect(isOurDaemon(child.pid, join(root, "other"))).toBe(false);
		expect(isOurDaemon(process.pid, root)).toBe(false);
	} finally {
		child.kill();
		await child.exited;
		rmSync(root, { recursive: true, force: true });
	}
});

test("pid lock refuses a live pid it cannot verify and only takes over dead pids", async () => {
	// Regression: an alive-but-unrecognized pid (ps/lsof timeout, unexpected launcher) used to
	// be treated as stale and taken over, letting two daemons long-poll the same tokens.
	const root = mkdtempSync(join(tmpdir(), "telegram pid lock "));
	const dataDir = join(root, "data");
	mkdirSync(dataDir, { recursive: true });
	const pidModule = join(import.meta.dir, "..", "src", "daemon", "pid.ts");
	const acquire = async (): Promise<{ code: number; stderr: string }> => {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`const { acquirePidLock } = await import(${JSON.stringify(pidModule)}); acquirePidLock(${JSON.stringify(dataDir)}); console.log("acquired");`,
			],
			{ cwd: root, stdout: "ignore", stderr: "pipe" },
		);
		const stderr = await new Response(child.stderr).text();
		return { code: await child.exited, stderr };
	};
	try {
		// The test runner itself is alive but is not this deployment's daemon.
		writeFileSync(join(dataDir, "daemon.pid"), String(process.pid));
		const refused = await acquire();
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("could not be verified");
		// A pid that no longer exists is stale and may be replaced.
		const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
		await dead.exited;
		writeFileSync(join(dataDir, "daemon.pid"), String(dead.pid));
		expect((await acquire()).code).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
