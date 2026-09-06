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
