// Pi owns the VM and replay journal; the host bounds concurrent scripts/workers and denies model APIs.
import type { Context } from "@earendil-works/chord/context";
import { CodemodeSandbox, type CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import { renderToolOutputType, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";

const MAX_CONCURRENT_SCRIPTS = 4;
const MAX_SANDBOX_WORKERS = 8;

class ScriptGate {
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	acquire(context: Context): Promise<() => void> {
		const signal = context.abortSignal;
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (this.active < MAX_CONCURRENT_SCRIPTS) {
			this.active++;
			return Promise.resolve(() => this.release());
		}
		return new Promise((resolve, reject) => {
			const wake = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve(() => this.release());
			};
			const onAbort = () => {
				const index = this.waiters.indexOf(wake);
				if (index >= 0) this.waiters.splice(index, 1);
				reject(signal?.reason);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.waiters.push(wake);
		});
	}

	private release(): void {
		const next = this.waiters.shift();
		if (next) next();
		else this.active--;
	}
}

export function telegramCodemode() {
	let workers = 0;
	const gate = new ScriptGate();
	const base = createCodemodeTool({
		models: false,
		sandbox: new CodemodeSandbox({
			memoryLimitBytes: 256 * 1024 * 1024,
			timeoutMs: 3_600_000,
			acquireWorker: () => {
				if (workers >= MAX_SANDBOX_WORKERS) throw new Error("code mode worker limit reached");
				workers++;
				return () => {
					workers--;
				};
			},
		}),
	});
	const tool = {
		...base,
		execute: async (args: { code: string }, api: Parameters<typeof base.execute>[1], context: Context) => {
			const release = await gate.acquire(context);
			try {
				return await base.execute(args, api, context);
			} finally {
				release();
			}
		},
	};
	return defineExtension({
		name: "codemode",
		tools: [tool],
		sections: [
			section("codemode", ({ agent }) =>
				[
					"This is the complete, fixed list of tools scripts can call. Argument schemas are provided by the model's tool declarations; use those same arguments in scripts. No discovery calls are needed.",
					...agent.callable.map(
						(item) =>
							`tools.${toCodemodeIdentifier(item.name)}(args): Promise<${renderToolOutputType((item.structuredOutputSchema ?? { type: "string" }) as CodemodeJsonSchema)}>`,
					),
				].join("\n"),
			),
		],
	});
}
