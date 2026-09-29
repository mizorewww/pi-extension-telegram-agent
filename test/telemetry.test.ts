process.env.TZ = "Asia/Singapore";

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	statsText,
	telegramFeedHeaderLine,
	telegramFooterLines,
	telegramFooterUsage,
} from "../.pi/extensions/tg-extension.ts";
import { IpcServer } from "../src/daemon/ipc-server.ts";
import { openDb } from "../src/db/db.ts";
import { loadBotStats } from "../src/db/usage.ts";
import type { BotStats, RuntimeControlSnapshot, UsageRun } from "../src/ipc.ts";
import { BOT_STATUS_FIELD_KEYS, botStatusFields, buildBotStatusView } from "../src/observability/status.ts";
import { fitContextBreakdown, summarizeBotUsage } from "../src/observability/usage.ts";
import { TimelineClient, type TimelineEvent } from "../src/plugin/timeline.ts";

const directories = new Set<string>();

afterEach(() => {
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "tg-telemetry-"));
	directories.add(directory);
	return directory;
}

function insertRun(
	db: Database,
	input: {
		ts: number;
		model: string;
		context: number;
		read: number;
		write: number;
		miss: number;
		output: number;
		reasoning: number;
		latency: number | null;
		cost: number;
		compaction: boolean;
		estimatedRead?: number | null;
		breakdown?: { system: number; tools: number; compacted: number; messages: number };
		thinking?: number;
		send?: number;
		sendSamples?: number;
	},
): number {
	const result = db
		.query(
			`INSERT INTO llm_runs
			 (bot_id, ts, model, epoch, context_tokens, cache_read, cache_write, cache_miss,
			  output_tokens, reasoning_tokens, latency_ms, cost, compaction, cache_read_estimated,
			  system_tokens, tools_tokens, compacted_history_tokens, message_tokens,
			  thinking_ms, send_ms, send_samples)
			 VALUES ('A', ?, ?, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.ts,
			input.model,
			input.context,
			input.read,
			input.write,
			input.miss,
			input.output,
			input.reasoning,
			input.latency,
			input.cost,
			input.compaction ? 1 : 0,
			input.estimatedRead ?? null,
			input.breakdown?.system ?? 0,
			input.breakdown?.tools ?? 0,
			input.breakdown?.compacted ?? 0,
			input.breakdown?.messages ?? 0,
			input.thinking ?? 0,
			input.send ?? 0,
			input.sendSamples ?? 0,
		);
	return Number(result.lastInsertRowid);
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(label)), 1_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("unified usage telemetry", () => {
	test("renders provider-order context segments and average speed", () => {
		const breakdown = fitContextBreakdown(
			{ system: 8_000, tools: 4_000, compactedHistory: 2_000, messages: 18_000 },
			32_768,
		);
		expect(Object.values(breakdown).reduce((sum, value) => sum + value, 0)).toBe(32_768);
		const stats: BotStats = {
			runs: 2,
			contextTokens: 40_000,
			cacheRead: 0,
			cacheWrite: 0,
			cacheMiss: 40_000,
			estimatedCacheRuns: 0,
			outputTokens: 200,
			speedOutputTokens: 200,
			reasoningTokens: 0,
			totalLatencyMs: 10_000,
			latencySamples: 2,
			totalThinkingMs: 2_000,
			thinkingSamples: 2,
			totalSendMs: 400,
			sendSamples: 2,
			firstRunTs: 1,
			cost: 0,
			epoch: 1,
			lastRunId: 1,
			last: {
				id: 1,
				botId: "A",
				ts: 1,
				model: "m",
				epoch: 1,
				contextTokens: 32_768,
				cacheRead: 0,
				cacheWrite: 0,
				cacheMiss: 32_768,
				outputTokens: 100,
				reasoningTokens: 0,
				latencyMs: 1_250,
				contextBreakdown: breakdown,
				cost: 0,
			},
		};
		const view = buildBotStatusView(
			{ id: "A", name: "A", provider: "p", model: "m", reasoningEffort: "off", routingP: 0, samplingCooldownMs: 0 },
			stats,
			undefined,
			65_536,
		);
		const plain = botStatusFields(view).find((field) => field.key === "context_breakdown")?.value;
		const visual = botStatusFields(view, true).find((field) => field.key === "context_breakdown")?.value;
		expect(plain).toMatch(/^S .* · T .* · C .* · M .* · F /);
		const visualLines = visual?.split("\n") ?? [];
		expect(visualLines).toHaveLength(6);
		expect(visualLines[0]).toBe(
			`${"🟥".repeat(8)}${"🟪".repeat(4)}${"🟫".repeat(2)}${"🟦".repeat(18)}${"🟩".repeat(32)}`,
		);
		expect(visualLines.slice(1)).toEqual([
			"🟥 `system prompt     12.5%`",
			"🟪 `tool desc          6.3%`",
			"🟫 `compacted history  3.1%`",
			"🟦 `message           28.1%`",
			"🟩 `free              50.0%`",
		]);
		expect(botStatusFields(view).find((field) => field.key === "speed")?.value).toBe(
			"20.0 tok/s · send 200 ms · think 1.00 s",
		);
	});

	test("keeps all context legend rows, sums percents to 100.0, and renders local time", () => {
		const stats: BotStats = {
			runs: 1,
			contextTokens: 3_000,
			cacheRead: 0,
			cacheWrite: 0,
			cacheMiss: 3_000,
			estimatedCacheRuns: 0,
			outputTokens: 10,
			speedOutputTokens: 10,
			reasoningTokens: 0,
			totalLatencyMs: 0,
			latencySamples: 0,
			totalThinkingMs: 0,
			thinkingSamples: 0,
			totalSendMs: 0,
			sendSamples: 0,
			firstRunTs: 1_786_251_069_000,
			cost: 0,
			epoch: 1,
			lastRunId: 1,
			last: {
				id: 1,
				botId: "A",
				ts: 1_786_251_069_000,
				model: "m",
				epoch: 1,
				contextTokens: 3_000,
				cacheRead: 0,
				cacheWrite: 0,
				cacheMiss: 3_000,
				outputTokens: 10,
				reasoningTokens: 0,
				latencyMs: null,
				contextBreakdown: { system: 0, tools: 0, compactedHistory: 1_000, messages: 2_000 },
				cost: 0,
			},
		};
		const view = buildBotStatusView(
			{ id: "A", name: "A", provider: "p", model: "m", reasoningEffort: "off", routingP: 0, samplingCooldownMs: 0 },
			stats,
			undefined,
			9_000,
		);
		const fields = botStatusFields(view, true);
		const legend =
			fields
				.find((field) => field.key === "context_breakdown")
				?.value.split("\n")
				.slice(1) ?? [];
		expect(legend.map((line) => line.slice(0, 2))).toEqual(["🟥", "🟪", "🟫", "🟦", "🟩"]);
		const percents = legend.map((line) => Number(/([\d.]+)%`$/.exec(line)?.[1]));
		// Exact thirds are 11.1 / 22.2 / 66.7 only after largest-remainder rounding (naive rounding gives 100.0 - 0.1).
		expect(percents).toEqual([0, 0, 11.1, 22.2, 66.7]);
		expect(percents.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 6);
		expect(botStatusFields(view).find((field) => field.key === "context_breakdown")?.value).toBe(
			"S 0.0% · T 0.0% · C 11.1% · M 22.2% · F 66.7%",
		);
		// TZ is pinned to Asia/Singapore at the top of this file: 1_786_251_069_000 is 2026-08-09T04:51:09Z = 12:51:09 +08.
		expect(fields.find((field) => field.key === "latest_request")?.value).toStartWith("2026-08-09 12:51:09 · ");
		expect(fields.find((field) => field.key === "lifetime")?.value).toContain("since 2026-08-09 12:51:09");
	});

	test("footer shows unknown context when a compaction is newer than the latest main run", () => {
		const last: UsageRun = {
			id: 5,
			botId: "A",
			ts: 10,
			model: "m",
			epoch: 2,
			contextTokens: 50_000,
			cacheRead: 0,
			cacheWrite: 0,
			cacheMiss: 50_000,
			outputTokens: 100,
			reasoningTokens: 0,
			latencyMs: 1_000,
			cost: 0.01,
		};
		const base: BotStats = {
			runs: 1,
			contextTokens: 50_000,
			cacheRead: 0,
			cacheWrite: 0,
			cacheMiss: 50_000,
			estimatedCacheRuns: 0,
			outputTokens: 100,
			speedOutputTokens: 100,
			reasoningTokens: 0,
			totalLatencyMs: 1_000,
			latencySamples: 1,
			totalThinkingMs: 0,
			thinkingSamples: 1,
			totalSendMs: 0,
			sendSamples: 0,
			firstRunTs: 10,
			cost: 0.01,
			epoch: 2,
			lastRunId: 5,
			last,
		};
		const bot = {
			id: "A",
			name: "A",
			provider: "p",
			model: "m",
			reasoningEffort: "off",
			routingP: 1,
			samplingCooldownMs: 0,
		} as const;
		const host = { modelRegistry: { getAvailable: () => [] }, model: undefined };
		const runtime: RuntimeControlSnapshot = {
			state: "idle",
			epoch: 2,
			provider: "p",
			model: "m",
			reasoningEffort: "off",
			contextWindow: 100_000,
			routingP: 1,
			samplingCooldownMs: 0,
			lastCompact: null,
		};
		expect(telegramFooterUsage("A", { A: base }, { A: runtime }, [bot], host)?.contextPercent).toBe(50);
		// A live compaction run (id 6) was folded into totals but must not keep the pre-compaction percent.
		const compacted: BotStats = { ...base, runs: 2, lastRunId: 6, last };
		expect(telegramFooterUsage("A", { A: compacted }, { A: runtime }, [bot], host)?.contextPercent).toBeNull();
		// The next main run (id 7) makes the context known again.
		const resumed: BotStats = { ...compacted, lastRunId: 7, last: { ...last, id: 7, contextTokens: 20_000 } };
		expect(telegramFooterUsage("A", { A: resumed }, { A: runtime }, [bot], host)?.contextPercent).toBe(20);
	});

	test("uses live session context and hides a previous epoch breakdown", () => {
		const stats: BotStats = {
			runs: 1,
			contextTokens: 117_340,
			cacheRead: 0,
			cacheWrite: 0,
			cacheMiss: 117_340,
			estimatedCacheRuns: 0,
			outputTokens: 129,
			speedOutputTokens: 129,
			reasoningTokens: 0,
			totalLatencyMs: 0,
			latencySamples: 0,
			totalThinkingMs: 0,
			thinkingSamples: 0,
			totalSendMs: 0,
			sendSamples: 0,
			firstRunTs: 1,
			cost: 0,
			epoch: 43,
			lastRunId: 1,
			last: {
				id: 1,
				botId: "B",
				ts: 1,
				model: "m",
				epoch: 43,
				contextTokens: 117_340,
				cacheRead: 0,
				cacheWrite: 0,
				cacheMiss: 117_340,
				outputTokens: 129,
				reasoningTokens: 0,
				latencyMs: null,
				contextBreakdown: { system: 10_000, tools: 1_000, compactedHistory: 50_000, messages: 56_340 },
				cost: 0,
			},
		};
		const view = buildBotStatusView(
			{ id: "B", name: "B", provider: "p", model: "m", reasoningEffort: "off", routingP: 0, samplingCooldownMs: 0 },
			stats,
			{
				state: "idle",
				epoch: 45,
				provider: "p",
				model: "m",
				reasoningEffort: "off",
				contextWindow: 65_536,
				currentContextTokens: null,
				routingP: 0,
				samplingCooldownMs: 0,
				lastCompact: null,
			},
		);
		const fields = botStatusFields(view, true);
		expect(fields.find((field) => field.key === "context_current")?.value).toBe("— / 65,536 (—)");
		expect(fields.find((field) => field.key === "context_breakdown")?.value).toBe("—");
	});

	test("keeps compose guidance in the one-line attached-feed header", () => {
		const styles: Array<[string, string]> = [];
		const theme = {
			fg: (color: string, text: string) => {
				styles.push([color, text]);
				return text;
			},
			bold: (text: string) => {
				styles.push(["bold", text]);
				return text;
			},
		};
		const indicator = { text: "choose bot on send", color: "accent" } as const;

		expect(telegramFeedHeaderLine(100, theme, "all bots", indicator)).toBe(
			" Telegram · all bots · attached · choose bot on send · /tg more · /tg detach",
		);
		expect(visibleWidth(telegramFeedHeaderLine(32, theme, "all bots", indicator))).toBeLessThanOrEqual(32);
		expect(styles).toContainEqual(["success", "attached"]);
		expect(styles).toContainEqual(["bold", "choose bot on send"]);
	});

	test("separates latest conversation context from retention totals", () => {
		const db = openDb(":memory:");
		try {
			const mainId = insertRun(db, {
				ts: 1_786_251_069_000,
				model: "chat-model",
				context: 1_000,
				read: 700,
				write: 50,
				miss: 250,
				output: 120,
				reasoning: 30,
				latency: 1_250,
				cost: 0.125,
				compaction: false,
			});
			insertRun(db, {
				ts: 1_786_251_070_000,
				model: "compact-model",
				context: 500,
				read: 0,
				write: 0,
				miss: 500,
				output: 50,
				reasoning: 0,
				latency: null,
				cost: 0.025,
				compaction: true,
			});

			const stats = loadBotStats(db, "A");
			const summary = summarizeBotUsage(stats, 128_000);
			const runtime = {
				state: "idle",
				epoch: 3,
				provider: "test",
				model: "chat-model",
				reasoningEffort: "high",
				contextWindow: 128_000,
				currentContextTokens: 777,
				routingP: 0.25,
				samplingCooldownMs: 2_000,
				lastCompact: null,
			} satisfies RuntimeControlSnapshot;
			const bot = {
				id: "A",
				name: "Bot A",
				provider: "test",
				model: "chat-model",
				reasoningEffort: "medium",
				routingP: 0.25,
				samplingCooldownMs: 2_000,
			} as const;
			const host = {
				modelRegistry: {
					getAvailable: () => [
						{
							provider: "test",
							id: "chat-model",
							contextWindow: 128_000,
							reasoning: true,
						},
					],
				},
				model: undefined,
				thinkingLevel: "off" as const,
			};
			const piStatus = statsText("A", stats, bot, runtime, host);
			const footerUsage = telegramFooterUsage(null, { A: stats }, { A: runtime }, [bot], host);
			// The daemon clamps the effective window below the catalog; the footer percent must
			// follow the runtime snapshot, never the raw catalog value.
			const catalogHost = {
				...host,
				modelRegistry: {
					getAvailable: () => [{ provider: "test", id: "chat-model", contextWindow: 1_000_000, reasoning: true }],
				},
			};
			expect(telegramFooterUsage(null, { A: stats }, { A: runtime }, [bot], catalogHost)?.contextWindow).toBe(128_000);
			const footerLines = telegramFooterLines(
				100,
				{ fg: (_color, text) => text },
				{
					cwd: "/home/test/project",
					home: "/home/test",
					branch: "main",
					sessionName: "ops",
					usage: footerUsage,
					availableProviderCount: 2,
					statuses: new Map(),
				},
			);

			expect(stats.runs).toBe(2);
			expect(stats.contextTokens).toBe(1_500);
			expect(stats.last?.id).toBe(mainId);
			expect(summary.context).toEqual({ tokens: 1_000, contextWindow: 128_000, percent: 0.78125 });
			expect(summary.cacheHitPercent).toBeCloseTo(46.666, 2);
			expect(summary.averageLatencyMs).toBe(1_250);
			expect(piStatus).toContain("model=test/chat-model · reasoning high · epoch 3");
			expect(piStatus).not.toContain("reasoning medium");
			expect(piStatus).toContain("context_current=777 / 128,000 (0.6%)");
			expect(piStatus).toContain("cache_and_cost=CH 46.7% · $0.1500");
			expect(footerLines[0]).toBe("~/project (main) • ops");
			// The compaction run is newer than the last main run, so the footer context is unknown
			// until the next main response (docs/telemetry.md).
			expect(footerLines[1]).toStartWith("↑750 ↓170 R700 W50 CH46.7% $0.1500 ?/128k (auto)");
			expect(footerLines[1]).toEndWith("(test) chat-model • high");
			expect(visibleWidth(footerLines[1]!)).toBe(100);
			expect(footerLines).toHaveLength(2);
			expect(
				piStatus
					.split("\n")
					.slice(1)
					.map((line) => line.slice(0, line.indexOf("="))),
			).toEqual([...BOT_STATUS_FIELD_KEYS]);

			const empty = summarizeBotUsage(loadBotStats(db, "B"), 128_000);
			expect(empty.context).toEqual({ tokens: null, contextWindow: 128_000, percent: null });
			expect(empty.cacheHitPercent).toBeNull();
		} finally {
			db.close();
		}
	});

	test("sums immutable per-run costs across model switches in status and footer", () => {
		const db = openDb(":memory:");
		try {
			insertRun(db, {
				ts: 1_786_251_069_000,
				model: "deepseek-v4-flash",
				context: 1_000,
				read: 700,
				write: 0,
				miss: 300,
				output: 120,
				reasoning: 30,
				latency: 1_250,
				cost: 0.720_977_83,
				compaction: false,
			});
			insertRun(db, {
				ts: 1_786_251_070_000,
				model: "glm-5.2",
				context: 8_076,
				read: 0,
				write: 0,
				miss: 8_076,
				output: 66,
				reasoning: 0,
				latency: 7_500,
				cost: 0.033_866_2,
				compaction: false,
				estimatedRead: 7_600,
			});

			const stats = loadBotStats(db, "A");
			const runtime = {
				state: "idle",
				epoch: 4,
				provider: "ollama-cloud",
				model: "glm-5.2",
				reasoningEffort: "high",
				contextWindow: 1_000_000,
				routingP: 1,
				samplingCooldownMs: 2_000,
				lastCompact: null,
			} satisfies RuntimeControlSnapshot;
			const bot = {
				id: "A",
				name: "Bot A",
				provider: "ollama-cloud",
				model: "glm-5.2",
				reasoningEffort: "high",
				routingP: 1,
				samplingCooldownMs: 2_000,
			} as const;
			const host = {
				modelRegistry: {
					getAvailable: () => [{ provider: "ollama-cloud", id: "glm-5.2", contextWindow: 1_000_000, reasoning: true }],
				},
				model: undefined,
				thinkingLevel: "off" as const,
			};
			const status = statsText("A", stats, bot, runtime, host);
			const footer = telegramFooterLines(
				100,
				{ fg: (_color, text) => text },
				{
					cwd: "/tmp/project",
					home: "/tmp",
					branch: null,
					sessionName: undefined,
					usage: telegramFooterUsage("A", { A: stats }, { A: runtime }, [bot], host),
					availableProviderCount: 1,
					statuses: new Map(),
				},
			);

			expect(stats.cost).toBeCloseTo(0.754_844_03, 10);
			expect(stats.last?.model).toBe("glm-5.2");
			expect(stats.last?.cacheEstimated).toBe(true);
			expect(stats.estimatedCacheRuns).toBe(1);
			expect(
				db
					.query("SELECT cache_read, cache_read_estimated, cache_miss, cost FROM llm_runs ORDER BY id DESC LIMIT 1")
					.get(),
			).toEqual({ cache_read: 0, cache_read_estimated: 7_600, cache_miss: 8_076, cost: 0.033_866_2 });
			expect(status).toContain("latest_usage=↑miss ≈476 · ↓output 66 · R ≈7,600");
			expect(status).toContain("cache_and_cost=CH ≈91.4% · $0.754844");
			expect(footer[1]).toContain("↑≈776");
			expect(footer[1]).toContain("R≈8.3k");
			expect(footer[1]).toContain("CH≈91.4%");
			expect(footer[1]).toContain("$0.754844");
		} finally {
			db.close();
		}
	});

	test("live compaction usage updates totals without replacing latest context", async () => {
		const directory = temporaryDirectory();
		const db = openDb(join(directory, "agent.db"));
		const mainId = insertRun(db, {
			ts: 1_786_251_069_000,
			model: "chat-model",
			context: 1_000,
			read: 700,
			write: 50,
			miss: 250,
			output: 120,
			reasoning: 30,
			latency: 1_250,
			cost: 0.125,
			compaction: false,
		});
		const socketPath = join(directory, "daemon.sock");
		const runtimeStatus = {
			state: "idle",
			epoch: 3,
			provider: "deepseek",
			model: "deepseek-v4-flash",
			reasoningEffort: "high",
			contextWindow: 1_000_000,
			routingP: 0.25,
			samplingCooldownMs: 2_000,
			lastCompact: null,
		} satisfies RuntimeControlSnapshot;
		const ipc = new IpcServer(
			db,
			socketPath,
			new Map([["A", "bot A"]]),
			new Map([["A", 1]]),
			async () => {
				throw new Error("manual send unused");
			},
			() => runtimeStatus,
		);
		ipc.start();
		let baselineResolve!: () => void;
		let baselineStatus: RuntimeControlSnapshot | undefined;
		let updatedResolve!: (stats: BotStats) => void;
		const baseline = new Promise<void>((resolve) => {
			baselineResolve = resolve;
		});
		const updated = new Promise<BotStats>((resolve) => {
			updatedResolve = resolve;
		});
		const client = new TimelineClient(socketPath, "A", {
			onEvent: (event: TimelineEvent) => {
				if (event.type !== "stats" || !event.stats.A) return;
				if (event.stats.A.runs === 1) {
					baselineStatus = event.statuses.A;
					baselineResolve();
				}
				if (event.stats.A.runs === 2) updatedResolve(event.stats.A);
			},
		});
		try {
			expect(await client.connect()).toBe(true);
			await withTimeout(baseline, "baseline stats timed out");
			expect(baselineStatus).toEqual(runtimeStatus);
			const compaction: UsageRun = {
				id: mainId + 1,
				botId: "A",
				ts: 1_786_251_070_000,
				model: "compact-model",
				epoch: 3,
				contextTokens: 500,
				cacheRead: 0,
				cacheWrite: 0,
				cacheMiss: 500,
				outputTokens: 50,
				reasoningTokens: 0,
				latencyMs: null,
				cost: 0.025,
				compaction: true,
			};
			// A push whose id is already inside the snapshot (`id <= lastId`) must not be folded a second time.
			ipc.broadcastUsage({ ...compaction, id: mainId, contextTokens: 999, compaction: false });
			ipc.broadcastUsage(compaction);
			const stats = await withTimeout(updated, "live compaction stats timed out");
			expect(stats.runs).toBe(2);
			expect(stats.contextTokens).toBe(1_500);
			expect(stats.last?.id).toBe(mainId);
			// The daemon reports the newest run id so the footer can detect a compaction after `last`.
			expect(stats.lastRunId).toBe(mainId + 1);
		} finally {
			client.dispose();
			ipc.stop();
			db.close();
		}
	});
});
