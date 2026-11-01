// Daemon pid lock. The pid file is created exclusively (openSync "wx") at the earliest moment of
// startup, before any slow init, so two daemons can never long-poll the same tokens. systemd
// supervises the process; this lock only refuses a second copy.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorCategory, log } from "../observability/log.ts";

export function readPid(pidPath: string): number | null {
	if (!existsSync(pidPath)) return null;
	const pid = Number(readFileSync(pidPath, "utf8").trim());
	return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Acquire the exclusive pid file; exit when a live process holds it. Only a dead pid is taken over. */
export function acquirePidLock(dataDir: string): void {
	mkdirSync(dataDir, { recursive: true });
	const pidPath = join(dataDir, "daemon.pid");
	const tryCreate = (): void => {
		closeSync(openSync(pidPath, "wx"));
		writeFileSync(pidPath, String(process.pid));
	};
	try {
		tryCreate();
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		const existing = readPid(pidPath);
		if (existing != null && pidAlive(existing)) {
			log.error("daemon", "pid_lock_held", { pid: existing });
			process.stderr.write(`daemon already running (pid ${existing})\n`);
			process.exit(1);
		}
		// dead process (or malformed file): take it over
		rmSync(pidPath, { force: true });
		try {
			tryCreate();
		} catch (err2) {
			log.error("daemon", "pid_lock_failed", { category: errorCategory(err2) });
			process.stderr.write("failed to acquire daemon pid lock\n");
			process.exit(1);
		}
	}
}

/** Remove the pid file on shutdown (only when it still names this process). */
export function releasePidLock(dataDir: string): void {
	const pidPath = join(dataDir, "daemon.pid");
	if (readPid(pidPath) === process.pid) rmSync(pidPath, { force: true });
}
