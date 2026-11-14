#!/usr/bin/env node

import { Database } from "../src/db/db.ts";
import { parseArgs } from "node:util";

import { join } from "node:path";
import { configDirectory, loadConfig } from "../src/config.ts";
import { buildDebugReport, parseDebugDuration } from "../src/observability/debug-report.ts";
import { readStructuredLogTail } from "../src/observability/log.ts";

function usage(): string {
	return "Usage: npm run debug -- [--since <30s|15m|2h|7d>]\n";
}

export async function main(args = process.argv.slice(2), rootDir = configDirectory()): Promise<number> {
	let values: { since?: string; help?: boolean };
	try {
		({ values } = parseArgs({
			args,
			options: {
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
	const sinceMs = parseDebugDuration(values.since!);
	if (sinceMs == null) {
		process.stderr.write(usage());
		return 2;
	}

	let db: Database | null = null;
	try {
		const config = loadConfig(rootDir, { identityOnly: true });
		db = new Database(config.dbPath, { readOnly: true, timeout: 5_000 });
		const report = buildDebugReport(db, {
			chatId: config.groupChatId,
			sinceMs,
			logs: readStructuredLogTail(join(config.dataDir, "daemon.log")),
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
