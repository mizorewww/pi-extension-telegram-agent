// Rootless Docker owns isolation; Pi owns file access, shell execution and cancellation.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";

export const BOX_WORKDIR = "/work";
export const BOX_OUTPUT_MAX_BYTES = 1024 * 1024;
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
export type DockerRunner = (
	args: readonly string[],
	options: { dockerHost: string; timeoutMs: number },
) => Promise<DockerResult>;
export class BoxError extends Error {}

export const runDocker: DockerRunner = (args, options) =>
	new Promise((resolve) => {
		execFile(
			"docker",
			["--host", options.dockerHost, ...args],
			{
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
				encoding: "buffer",
				timeout: options.timeoutMs,
				maxBuffer: BOX_OUTPUT_MAX_BYTES,
			},
			(error, stdout, stderr) =>
				resolve({
					code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
					stdout,
					stderr: stderr.toString(),
					timedOut: error?.killed ?? false,
				}),
		);
	});

/** Outbound attachments must stay under /work, including their canonical path. */
export function normalizeBoxPath(path: string): string {
	const value = path.startsWith("/") ? path : `${BOX_WORKDIR}/${path}`;
	if (/[\0\n\r]/.test(value) || value.split("/").includes("..")) throw new BoxError("path must stay inside /work");
	const normalized = `/${value
		.split("/")
		.filter((part) => part && part !== ".")
		.join("/")}`;
	if (normalized !== BOX_WORKDIR && !normalized.startsWith(`${BOX_WORKDIR}/`))
		throw new BoxError("path must stay inside /work");
	return normalized;
}

export function isolationArgs(botId: string, network: boolean): string[] {
	return [
		"--user",
		"1000:1000",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--read-only",
		"--network",
		network ? "bridge" : "none",
		"--env",
		`HOME=${BOX_WORKDIR}/.home`,
		"--volume",
		`tg-work-${botId}:${BOX_WORKDIR}`,
	];
}

export class WorkBox {
	readonly botId: string;
	private readonly config: BoxConfig;
	private readonly docker: DockerRunner;
	readonly container: string;
	readonly volume: string;
	readonly env: ExecutionEnv;
	private readonly connection: Connection;
	private lifecycle = Promise.resolve();
	private resetting: Promise<void> | null = null;
	constructor(botId: string, config: BoxConfig, docker: DockerRunner = runDocker, environment?: ExecutionEnv) {
		this.botId = botId;
		this.config = config;
		this.docker = docker;
		this.container = `tg-box-${botId}`;
		this.volume = `tg-work-${botId}`;
		this.connection = new Connection({
			command: async () => {
				await this.ensure();
				return [
					"docker",
					"--host",
					config.dockerHost,
					"exec",
					"--interactive",
					this.container,
					"/usr/local/bin/pi-env",
				];
			},
		});
		this.env =
			environment ?? new RemoteExecutionEnv({ connection: this.connection, id: this.volume, cwd: BOX_WORKDIR });
	}
	private call(args: readonly string[]) {
		return this.docker(args, { dockerHost: this.config.dockerHost, timeoutMs: 60_000 });
	}
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
			...isolationArgs(this.botId, this.config.network),
			"--tmpfs",
			"/tmp:rw,nosuid,nodev,size=256m",
			"--memory",
			this.config.memory,
			"--cpus",
			String(this.config.cpus),
			"--pids-limit",
			String(this.config.pids),
			"--workdir",
			BOX_WORKDIR,
			this.config.image,
			"sleep",
			"infinity",
		];
	}

	private exclusive(action: () => Promise<void>): Promise<void> {
		const work = this.lifecycle.then(action);
		this.lifecycle = work.catch(() => {});
		return work;
	}
	ensure(): Promise<void> {
		return this.exclusive(() => this.start());
	}
	private async start(): Promise<void> {
		const state = await this.call(["inspect", "--format", "{{.State.Running}} {{.Config.Image}}", this.container]);
		if (state.code === 0 && new TextDecoder().decode(state.stdout).trim() === `true ${this.config.image}`) return;
		if (state.code === 0) await this.call(["rm", "--force", this.container]);
		for (const args of [
			this.runArgs(),
			["exec", this.container, "mkdir", "-p", `${BOX_WORKDIR}/.home`, `${BOX_WORKDIR}/inbox`],
		]) {
			if ((await this.call(args)).code !== 0) throw new BoxError("box start failed");
		}
	}
	interrupt(): Promise<void> {
		return this.exclusive(async () => {
			this.connection.close();
			await this.call(["kill", this.container]);
		});
	}
	reset(): Promise<void> {
		this.resetting ??= this.exclusive(() => this.remove()).finally(() => {
			this.resetting = null;
		});
		return this.resetting;
	}
	private async remove(): Promise<void> {
		this.connection.close();
		if ((await this.call(["rm", "--force", this.container])).code !== 0) {
			const exists = await this.call(["inspect", this.container]);
			if (exists.code === 0) throw new BoxError("box removal failed");
		}
		if ((await this.call(["volume", "rm", "--force", this.volume])).code !== 0) throw new BoxError("box reset failed");
	}
	async writeFile(path: string, bytes: Uint8Array): Promise<string> {
		const target = normalizeBoxPath(path);
		getOrThrow(await this.env.createDir(dirname(target), { recursive: true }, BACKGROUND_CONTEXT));
		getOrThrow(await this.env.writeFile(target, bytes, BACKGROUND_CONTEXT));
		return target;
	}
	async copyOut(path: string, maxBytes: number): Promise<{ hostPath: string; size: number; cleanup: () => void }> {
		const context = BACKGROUND_CONTEXT;
		const real = normalizeBoxPath(getOrThrow(await this.env.canonicalPath(normalizeBoxPath(path), context)));
		const reader = getOrThrow(await this.env.openBinaryReader(real, { noFollow: true }, context));
		try {
			const info = getOrThrow(await reader.info(context));
			if (info.kind !== "file" || info.size > maxBytes) throw new BoxError("attachment must be a bounded regular file");
			const bytes = getOrThrow(await reader.read(0, maxBytes + 1, context));
			if (bytes.length > maxBytes) throw new BoxError("file too large");
			const dir = mkdtempSync(join(tmpdir(), "tg-box-out-"));
			const cleanup = () => rmSync(dir, { recursive: true, force: true });
			try {
				const hostPath = join(dir, basename(real));
				writeFileSync(hostPath, bytes, { mode: 0o600 });
				return { hostPath, size: bytes.length, cleanup };
			} catch (error) {
				cleanup();
				throw error;
			}
		} finally {
			await reader.close(context);
		}
	}
}
