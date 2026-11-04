#!/usr/bin/env node

import { DatabaseSync as Database } from "node:sqlite";
import { parseArgs } from "node:util";

import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { readPid, pidAlive } from "../src/daemon/pid.ts";
import { buildDebugReport, parseDebugDuration } from "../src/observability/debug-report.ts";
import { readStructuredLogTail } from "../src/observability/log.ts";

function usage(): string {
	return "Usage: npm run debug -- [--bot <id>] [--since <30s|15m|2h|7d>]\n";
}

export async function main(args = process.argv.slice(2), rootDir = process.cwd()): Promise<number> {
	let values: { bot?: string; since?: string; help?: boolean };
	try {
		({ values } = parseArgs({
			args,
			options: {
				bot: { type: "string" },
				since: { type: "string", default: "30m" },
				help: { type: "boolean", short: "h" },
			},
		}));
	} catch {
		process.stderr.write(usage());
		return 2;
	}
	if (values.help) {
		process.stdout.write(usage());
		return 0;
	}
	const botId = values.bot;
	const sinceMs = parseDebugDuration(values.since!);
	if (sinceMs == null) {
		process.stderr.write(usage());
		return 2;
	}

	let db: Database | null = null;
	try {
		const config = loadConfig(rootDir, { identityOnly: true });
		const configuredIds = config.bots.map((bot) => bot.id);
		const botIds = botId == null ? configuredIds : [botId];
		if (botId != null && !configuredIds.includes(botId)) {
			process.stderr.write(`Unknown bot id. Valid ids: ${configuredIds.join(", ")}\n`);
			return 2;
		}
		db = new Database(config.dbPath, { readOnly: true });
		const pid = readPid(join(config.dataDir, "daemon.pid"));
		const report = buildDebugReport(db, {
			botIds,
			chatId: config.groupChatId,
			sinceMs,
			logs: readStructuredLogTail(join(config.dataDir, "daemon.log")),
			daemon: { pid, alive: pid != null && pidAlive(pid) },
		});
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return 0;
	} catch {
		process.stderr.write("Debug report unavailable: invalid local configuration or database state.\n");
		return 1;
	} finally {
		db?.close();
	}
}

if (import.meta.main) process.exitCode = await main();
