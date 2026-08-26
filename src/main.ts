// CLI: start | restart | status | stop.

import { DaemonController, type DaemonControlResult } from "./daemon/control.ts";
import { loadConfig } from "./config.ts";
import { inspectVideoTranscoder, videoTranscoderAdvisory } from "./media/video-frames.ts";

const rootDir = process.cwd();
const cmd = process.argv[2];

function report(result: DaemonControlResult): void {
	for (const line of result.lines) (result.ok ? console.log : console.error)(line);
	if (result.logTail) console.error(`recent daemon log (redacted):\n${result.logTail}`);
	if (result.ok && cmd !== "stop") reportAdvisory();
	if (!result.ok) process.exitCode = 1;
}

function reportAdvisory(): void {
	try {
		const config = loadConfig(rootDir);
		// Frame sampling matters whenever media reaches a model: vision descriptions or
		// context-mode image blocks.
		const advisory = videoTranscoderAdvisory(
			config.vision.enabled || config.media.mode === "context",
			inspectVideoTranscoder(),
		);
		if (advisory) console.warn(advisory);
	} catch {
		// Daemon startup owns config failures; an optional capability hint must never mask or block it.
	}
}

const controller = new DaemonController(rootDir);

switch (cmd) {
	case "start": {
		if (process.argv.includes("--foreground")) {
			reportAdvisory();
			await import("./daemon/index.ts");
			break;
		}
		report(await controller.start());
		break;
	}
	case "restart": {
		report(await controller.restart());
		break;
	}
	case "status": {
		report(controller.status());
		break;
	}
	case "stop": {
		report(controller.stop());
		break;
	}
	default:
		console.error("usage: bun run src/main.ts <start [--foreground] | restart | status | stop>");
		process.exitCode = 1;
}
