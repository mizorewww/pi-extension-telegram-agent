// Per-bot work box: one long-lived container on a dedicated rootless Docker daemon, driven
// through the docker CLI. The box holds no credentials and mounts nothing from the host; its only
// state is the named /work volume, which reset() (weekly, or on demand) destroys.
// Threat model: docs/architecture.md "沙箱威胁模型". Tests: test/sandbox.test.ts.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const BOX_WORKDIR = "/work";
export const BOX_OUTPUT_MAX_BYTES = 1024 * 1024;
export const BOX_DEFAULT_TIMEOUT_S = 30;
export const BOX_MAX_TIMEOUT_S = 120;
const DOCKER_CALL_TIMEOUT_MS = 60_000;

export interface BoxConfig {
	image: string;
	dockerHost: string;
	memory: string;
	cpus: number;
	pids: number;
	network: boolean;
}

export interface DockerResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
	timedOut: boolean;
}

/** Runs one docker CLI call; injectable so tests never touch a real daemon. */
export type DockerRunner = (
	args: readonly string[],
	options: { dockerHost: string; timeoutMs: number; input?: Uint8Array; maxStdout?: number },
) => Promise<DockerResult>;

export interface ExecResult {
	output: string;
	exit_code: number;
	truncated: boolean;
	timed_out: boolean;
	wall_ms: number;
}

export class BoxError extends Error {}

export const runDocker: DockerRunner = (args, options) =>
	new Promise((resolve, reject) => {
		const child = spawn("docker", [...args], {
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DOCKER_HOST: options.dockerHost },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const max = options.maxStdout ?? BOX_OUTPUT_MAX_BYTES;
		const chunks: Buffer[] = [];
		let size = 0;
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			if (size >= max) return;
			chunks.push(chunk.subarray(0, max - size));
			size += Math.min(chunk.length, max - size);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 4096) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, stdout: new Uint8Array(Buffer.concat(chunks)), stderr, timedOut });
		});
		child.stdin.end(options.input ?? undefined);
	});

/** Paths a bot may hand out of the box: inside /work, no traversal, no control characters. */
export function normalizeBoxPath(path: string): string {
	const value = path.startsWith("/") ? path : `${BOX_WORKDIR}/${path}`;
	if (/[\0\n\r]/.test(value)) throw new BoxError("invalid path");
	const parts: string[] = [];
	for (const part of value.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") throw new BoxError("path must stay inside /work");
		parts.push(part);
	}
	const normalized = `/${parts.join("/")}`;
	if (normalized !== BOX_WORKDIR && !normalized.startsWith(`${BOX_WORKDIR}/`))
		throw new BoxError("path must stay inside /work");
	return normalized;
}

export class WorkBox {
	readonly container: string;
	readonly volume: string;
	private starting: Promise<void> | null = null;

	constructor(
		readonly botId: string,
		private readonly config: BoxConfig,
		private readonly docker: DockerRunner = runDocker,
	) {
		this.container = `tg-box-${botId}`;
		this.volume = `tg-work-${botId}`;
	}

	private call(args: readonly string[], timeoutMs = DOCKER_CALL_TIMEOUT_MS, input?: Uint8Array, maxStdout?: number) {
		return this.docker(args, { dockerHost: this.config.dockerHost, timeoutMs, input, maxStdout });
	}

	/** The container arguments are the sandbox boundary; test/sandbox.test.ts pins them. */
	runArgs(): string[] {
		return [
			"run",
			"--detach",
			"--name",
			this.container,
			"--hostname",
			"box",
			"--label",
			`tg-box=${this.botId}`,
			"--user",
			"1000:1000",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--read-only",
			"--tmpfs",
			"/tmp:rw,nosuid,nodev,size=256m",
			"--memory",
			this.config.memory,
			"--cpus",
			String(this.config.cpus),
			"--pids-limit",
			String(this.config.pids),
			"--network",
			this.config.network ? "bridge" : "none",
			"--env",
			`HOME=${BOX_WORKDIR}/.home`,
			"--volume",
			`${this.volume}:${BOX_WORKDIR}`,
			"--workdir",
			BOX_WORKDIR,
			this.config.image,
			"sleep",
			"infinity",
		];
	}

	async ensure(): Promise<void> {
		this.starting ??= this.start().finally(() => {
			this.starting = null;
		});
		await this.starting;
	}

	private async start(): Promise<void> {
		const state = await this.call(["inspect", "--format", "{{.State.Running}}", this.container]);
		if (state.code === 0 && new TextDecoder().decode(state.stdout).trim() === "true") return;
		if (state.code === 0) await this.call(["rm", "--force", this.container]);
		const run = await this.call(this.runArgs());
		if (run.code !== 0) throw new BoxError(`box start failed: ${firstLine(run.stderr)}`);
		// The fresh volume is root-owned; hand /work to the box user once.
		await this.call(["exec", "--user", "0", this.container, "chown", "1000:1000", BOX_WORKDIR]);
		await this.call(["exec", this.container, "mkdir", "-p", `${BOX_WORKDIR}/.home`, `${BOX_WORKDIR}/inbox`]);
	}

	async exec(command: string, timeoutS = BOX_DEFAULT_TIMEOUT_S): Promise<ExecResult> {
		if (!command.trim()) throw new BoxError("empty command");
		const seconds = Math.min(Math.max(1, Math.floor(timeoutS)), BOX_MAX_TIMEOUT_S);
		await this.ensure();
		const started = Date.now();
		// `timeout` inside the box ends the process tree; the host deadline backs it up.
		const result = await this.call(
			[
				"exec",
				"--interactive",
				this.container,
				"timeout",
				"-s",
				"KILL",
				String(seconds),
				"sh",
				"-c",
				`${command} 2>&1`,
			],
			(seconds + 10) * 1000,
			undefined,
			BOX_OUTPUT_MAX_BYTES + 1,
		);
		const truncated = result.stdout.byteLength > BOX_OUTPUT_MAX_BYTES;
		const bytes = truncated ? result.stdout.subarray(0, BOX_OUTPUT_MAX_BYTES) : result.stdout;
		const timedOut = result.timedOut || result.code === 137;
		return {
			output: new TextDecoder().decode(bytes),
			exit_code: result.code,
			truncated,
			timed_out: timedOut,
			wall_ms: Date.now() - started,
		};
	}

	/** Destroy the container and its /work volume; the next call starts from the clean image. */
	async reset(): Promise<void> {
		await this.call(["rm", "--force", this.container]);
		const removed = await this.call(["volume", "rm", "--force", this.volume]);
		if (removed.code !== 0) throw new BoxError(`box reset failed: ${firstLine(removed.stderr)}`);
	}

	/** Write bytes to /work/<relative> as the box user. */
	async writeFile(path: string, bytes: Uint8Array): Promise<string> {
		const target = normalizeBoxPath(path);
		await this.ensure();
		const dir = target.slice(0, target.lastIndexOf("/")) || BOX_WORKDIR;
		const result = await this.call(
			["exec", "--interactive", this.container, "sh", "-c", 'mkdir -p "$1" && cat > "$2"', "sh", dir, target],
			DOCKER_CALL_TIMEOUT_MS,
			bytes,
		);
		if (result.code !== 0) throw new BoxError(`write failed: ${firstLine(result.stderr)}`);
		return target;
	}

	/**
	 * Copy one regular file out of /work into a fresh host temp dir. The path is resolved inside
	 * the box first, so a symlink cannot point the copy outside /work.
	 */
	async copyOut(path: string, maxBytes: number): Promise<{ hostPath: string; size: number; cleanup: () => void }> {
		const requested = normalizeBoxPath(path);
		await this.ensure();
		const resolved = await this.call(["exec", this.container, "realpath", "-e", "--", requested]);
		if (resolved.code !== 0) throw new BoxError("file not found");
		const real = normalizeBoxPath(new TextDecoder().decode(resolved.stdout).trim());
		const size = await this.call(["exec", this.container, "stat", "-c", "%F %s", "--", real]);
		const [type, bytes] = new TextDecoder()
			.decode(size.stdout)
			.trim()
			.split(/ (?=\d+$)/);
		if (size.code !== 0 || type !== "regular file") throw new BoxError("not a regular file");
		if (Number(bytes) > maxBytes) throw new BoxError("file too large");
		const content = await this.call(
			["exec", this.container, "cat", "--", real],
			DOCKER_CALL_TIMEOUT_MS,
			undefined,
			maxBytes + 1,
		);
		if (content.code !== 0 || content.stdout.byteLength > maxBytes) throw new BoxError("copy failed");
		const dir = mkdtempSync(join(tmpdir(), "tg-box-out-"));
		const hostPath = join(dir, basename(real));
		writeFileSync(hostPath, content.stdout, { mode: 0o600 });
		return {
			hostPath,
			size: statSync(hostPath).size,
			cleanup: () => rmSync(dir, { recursive: true, force: true }),
		};
	}
}

function firstLine(text: string): string {
	return (text.split("\n").find((line) => line.trim()) ?? "unknown error").slice(0, 200);
}
