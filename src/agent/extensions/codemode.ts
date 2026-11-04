// Pi owns the VM and replay journal; the host limits memory/workers and denies model APIs.
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";

let workers = 0;
export function telegramCodemode() {
	return createCodemodeExtension({
		models: false,
		sandbox: new CodemodeSandbox({
			memoryLimitBytes: 256 * 1024 * 1024,
			timeoutMs: 3_600_000,
			acquireWorker: () => {
				if (workers >= 2) throw new Error("code mode worker limit reached");
				workers++;
				return () => {
					workers--;
				};
			},
		}),
	});
}
