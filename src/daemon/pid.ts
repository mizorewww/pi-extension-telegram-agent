// Daemon pid file / lock management (REQ-OPS-0001 R4).
// The pid file is created EXCLUSIVELY (openSync "wx") at the earliest moment of daemon
// startup, before any slow init, so a double `start` cannot race two daemons onto the
// same token. `stop`/`status` verify the pid belongs to OUR daemon (cmdline check) so a
// recycled OS pid is never killed.
// Linux ownership reads NUL-separated /proc argv and cwd. macOS uses an exact ps
// entry match plus lsof cwd verification. Both preserve spaces in the project path.

import {
	openSync,
	closeSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	writeFileSync,
	existsSync,
	rmSync,
	mkdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { errorCategory, log } from "../observability/log.ts";

export const PID_PATH = join(process.cwd(), "data", "daemon.pid");

export function readPid(pidPath: string = PID_PATH): number | null {
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

function processArgv(pid: number): string[] | null {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8")
			.split("\0")
			.filter((arg) => arg.length > 0);
	} catch {
		return null;
	}
}

function processCwd(pid: number): string | null {
	try {
		if (process.platform === "darwin") {
			const output = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
				encoding: "utf8",
				timeout: 2000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			return (
				output
					.split("\n")
					.find((line) => line.startsWith("n"))
					?.slice(1) ?? null
			);
		}
		return readlinkSync(`/proc/${pid}/cwd`);
	} catch {
		return null;
	}
}

function daemonEntry(args: string[]): string | null {
	if (basename(args[0] ?? "") !== "bun") return null;
	const runOffset = args[1] === "run" ? 2 : 1;
	const entry = args[runOffset];
	if (!entry) return null;
	if (/(?:^|\/)daemon\/index(?:\.ts)?$/.test(entry)) return entry;
	if (
		/(?:^|\/)main(?:\.ts)?$/.test(entry) &&
		args[runOffset + 1] === "start" &&
		args.slice(runOffset + 2).includes("--foreground")
	)
		return entry;
	return null;
}

/** Darwin preserves the full entry path (including spaces); match only our exact supported commands. */
function darwinCommandEntry(command: string, root: string): string | null {
	const match = command.trim().match(/^(\S+) (?:run )?(.+)$/);
	if (!match || basename(match[1]!) !== "bun") return null;
	const invocation = match[2]!;
	for (const entry of ["src/daemon/index.ts", "src/main.ts"]) {
		for (const path of [entry, `./${entry}`, join(root, entry)]) {
			if (invocation === (entry === "src/main.ts" ? `${path} start --foreground` : path)) return entry;
		}
	}
	return null;
}

function darwinProcesses(pid?: number): { pid: number; command: string }[] {
	try {
		const args = pid == null ? ["-axww", "-o", "pid=,command="] : ["-ww", "-p", String(pid), "-o", "pid=,command="];
		return execFileSync("/bin/ps", args, {
			encoding: "utf8",
			timeout: 2000,
			maxBuffer: 8 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split("\n")
			.flatMap((line) => {
				const match = line.match(/^\s*(\d+)\s+(.+)$/);
				return match ? [{ pid: Number(match[1]), command: match[2]! }] : [];
			});
	} catch {
		return [];
	}
}

function samePath(left: string | null, right: string): boolean {
	if (left == null) return false;
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return false;
	}
}

/** Exact entry and working directory must both belong to this deployment. */
export function isOurDaemon(pid: number, rootDir: string = process.cwd()): boolean {
	const root = resolve(rootDir);
	if (process.platform === "darwin") {
		const command = darwinProcesses(pid)[0]?.command;
		return command != null && darwinCommandEntry(command, root) != null && samePath(processCwd(pid), root);
	}
	const argv = processArgv(pid);
	const entry = argv && daemonEntry(argv);
	if (!entry) return false;
	const cwd = processCwd(pid);
	return (
		cwd != null &&
		samePath(cwd, root) &&
		[join(root, "src/daemon/index.ts"), join(root, "src/main.ts")].some((expected) =>
			samePath(resolve(cwd, entry), expected),
		)
	);
}

/** Enumerate every live daemon from this repository, including an orphan missing from daemon.pid. */
export function listOurDaemons(rootDir: string = process.cwd()): number[] {
	if (process.platform === "darwin") {
		const root = resolve(rootDir);
		return darwinProcesses()
			.filter(
				({ pid, command }) =>
					pid !== process.pid && darwinCommandEntry(command, root) != null && samePath(processCwd(pid), root),
			)
			.map(({ pid }) => pid)
			.sort((a, b) => a - b);
	}
	let procEntries: string[];
	try {
		procEntries = readdirSync("/proc");
	} catch {
		return [];
	}
	const pids: number[] = [];
	for (const name of procEntries) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		if (pid === process.pid) continue;
		const argv = processArgv(pid);
		if (argv != null && daemonEntry(argv) != null && isOurDaemon(pid, rootDir)) pids.push(pid);
	}
	return pids.sort((a, b) => a - b);
}

/**
 * Acquire the exclusive pid lock. Exits the process when another daemon holds it.
 * Stale pid files (dead or foreign process) are removed and retried once.
 * The returned fd keeps the lock held for the daemon's lifetime.
 */
export function acquirePidLock(dataDir: string): number {
	mkdirSync(dataDir, { recursive: true });
	const pidPath = join(dataDir, "daemon.pid");
	const tryCreate = (): number => {
		const fd = openSync(pidPath, "wx");
		writeFileSync(pidPath, String(process.pid));
		return fd;
	};
	try {
		return tryCreate();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		const existing = readPid(pidPath);
		if (existing != null && pidAlive(existing) && isOurDaemon(existing)) {
			log.error("daemon", "pid_lock_held", { pid: existing });
			process.stderr.write(`daemon already running (pid ${existing})\n`);
			process.exit(1);
		}
		// stale (dead or foreign process): take it over
		rmSync(pidPath, { force: true });
		try {
			return tryCreate();
		} catch (err2) {
			log.error("daemon", "pid_lock_failed", { category: errorCategory(err2) });
			process.stderr.write("failed to acquire daemon pid lock\n");
			process.exit(1);
		}
	}
}

/** Release the lock on shutdown (only when we own the file). */
export function releasePidLock(pidFd: number, dataDir: string): void {
	try {
		closeSync(pidFd);
	} catch {
		// already closed
	}
	const pidPath = join(dataDir, "daemon.pid");
	if (readPid(pidPath) === process.pid) rmSync(pidPath, { force: true });
}
