import { delimiter, join, resolve } from "node:path";

/** Bun prepends node_modules/.bin; skip those entries to use the operator's installed Pi. */
export async function launchPi(rootDir: string, args: readonly string[]): Promise<number> {
	const path = (process.env.PATH ?? "")
		.split(delimiter)
		.filter((entry) => !resolve(entry).endsWith(join("node_modules", ".bin")))
		.join(delimiter);
	const executable = Bun.which("pi", { PATH: path });
	if (!executable) throw new Error("Pi is not installed on PATH. Install Pi, then run bun run pi again.");
	const child = Bun.spawn([executable, ...args], {
		cwd: rootDir,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return await child.exited;
}

if (import.meta.main) {
	const rootDir = resolve(import.meta.dir, "..");
	try {
		process.exitCode = await launchPi(rootDir, process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Unable to start Pi.");
		process.exitCode = 1;
	}
}
