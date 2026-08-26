#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { loadDebugDeploymentIdentity } from "../src/config.ts";
import { readPid, pidAlive } from "../src/daemon/pid.ts";
import { buildDebugReport, parseDebugDuration, type DebugModelReasoning } from "../src/observability/debug-report.ts";
import { readStructuredLogTail } from "../src/observability/log.ts";
import { inspectProviderContext } from "../src/observability/provider-context.ts";
import { inspectModelReasoning } from "../src/agent/model-runtime.ts";
import { parsePiModelReference } from "../src/agent/model-ref.ts";
import { inspectVideoTranscoder } from "../src/media/video-frames.ts";

function usage(): string {
	return "Usage: bun run debug -- [--bot <id>] [--since <30s|15m|2h|7d>] [--show-provider-content]\n";
}

export async function main(args = process.argv.slice(2), rootDir = process.cwd()): Promise<number> {
	let botId: string | null = null;
	let sinceMs = 30 * 60_000;
	let showProviderContent = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(usage());
			return 0;
		}
		if (arg === "--bot" && args[index + 1]) {
			botId = args[++index]!;
			continue;
		}
		if (arg === "--since" && args[index + 1]) {
			const parsed = parseDebugDuration(args[++index]!);
			if (parsed == null) {
				process.stderr.write(usage());
				return 2;
			}
			sinceMs = parsed;
			continue;
		}
		if (arg === "--show-provider-content") {
			showProviderContent = true;
			continue;
		}
		process.stderr.write(usage());
		return 2;
	}

	let db: Database | null = null;
	try {
		const config = loadDebugDeploymentIdentity(rootDir);
		if (showProviderContent && botId == null) {
			process.stderr.write(
				"--show-provider-content requires --bot <id> to prevent an accidental multi-bot content dump.\n",
			);
			return 2;
		}
		const botIds = botId == null ? config.botIds : [botId];
		if (botId != null && !config.botIds.includes(botId)) {
			process.stderr.write(`Unknown bot id. Valid ids: ${config.botIds.join(", ")}\n`);
			return 2;
		}
		let modelReasoning: DebugModelReasoning[] | undefined;
		try {
			const runtime = await ModelRuntime.create();
			const selections = [
				...config.bots.flatMap((bot) => {
					if (!bot.provider || !bot.model) return [];
					const compact = parsePiModelReference(bot.compactionModel)!;
					return [
						{
							bot_id: bot.id,
							scope: "main" as const,
							provider: bot.provider,
							model: bot.model,
							requested: (bot.reasoningEffort ?? "off") as ModelThinkingLevel,
						},
						{
							bot_id: bot.id,
							scope: "compaction" as const,
							provider: compact.provider,
							model: compact.model,
							requested: compact.thinkingLevel as ModelThinkingLevel,
						},
					];
				}),
				...(config.visionEnabled && config.media.mode === "vision"
					? (() => {
							const vision = parsePiModelReference(config.auxiliaryVisualModel)!;
							return [
								{
									bot_id: "vision",
									scope: "vision" as const,
									provider: vision.provider,
									model: vision.model,
									requested: vision.thinkingLevel as ModelThinkingLevel,
								},
							];
						})()
					: []),
			];
			modelReasoning = selections.flatMap((selection) => {
				const model = runtime.getModel(selection.provider, selection.model);
				if (!model) return [];
				const capability = inspectModelReasoning(model, selection.requested);
				return [{ ...selection, ...capability }];
			});
		} catch {
			modelReasoning = undefined;
		}
		db = new Database(config.dbPath, { readonly: true, strict: true });
		const pid = readPid(join(config.dataDir, "daemon.pid"));
		const report = buildDebugReport(db, {
			botIds,
			chatId: Number(`-100${config.groupPeerId}`),
			sinceMs,
			logs: readStructuredLogTail(join(config.dataDir, "daemon.log")),
			daemon: { pid, alive: pid != null && pidAlive(pid), socket: existsSync(join(config.dataDir, "daemon.sock")) },
			modelReasoning,
			videoTranscoder: {
				required: config.visionEnabled || config.media.mode === "context",
				...inspectVideoTranscoder(),
			},
		});
		const providerContexts = Object.fromEntries(
			botIds.map((id) => {
				try {
					return [
						id,
						inspectProviderContext(
							db!,
							config,
							id,
							showProviderContent,
							modelReasoning?.find((entry) => entry.bot_id === id && entry.scope === "main"),
						),
					];
				} catch {
					return [id, { unavailable: true }];
				}
			}),
		);
		process.stdout.write(`${JSON.stringify({ ...report, provider_contexts: providerContexts }, null, 2)}\n`);
		return 0;
	} catch {
		process.stderr.write("Debug report unavailable: invalid local configuration or database state.\n");
		return 1;
	} finally {
		db?.close();
	}
}

if (import.meta.main) process.exitCode = await main();
