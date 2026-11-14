// Pi owns the VM and replay journal; the host limits memory/workers and denies model APIs.
import { CodemodeSandbox, type CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import { renderToolOutputType, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";

export function telegramCodemode() {
	let workers = 0;
	const tool = createCodemodeTool({
		models: false,
		sandbox: new CodemodeSandbox({
			memoryLimitBytes: 256 * 1024 * 1024,
			timeoutMs: 3_600_000,
			acquireWorker: () => {
				if (workers >= 8) throw new Error("code mode worker limit reached");
				workers++;
				return () => {
					workers--;
				};
			},
		}),
	});
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
