#!/usr/bin/env node
// Installation preflight: local configuration/catalog/auth checks, never a generation or Telegram request.
import { parseArgs } from "node:util";
import { ConfigError, configDirectory, loadConfig, MIN_COMPACTION_RESERVE } from "../src/config.ts";
import {
	assertBotModelConfigured,
	createInstalledPiModelRuntime,
	PiModelConfigurationError,
} from "../src/agent/model-runtime.ts";
import { assertPiVisionExecutorReady, createPiVisionExecutor } from "../src/media/vision.ts";
import { createDecider } from "../src/agent/decider.ts";

export async function main(args = process.argv.slice(2), configDir = configDirectory()): Promise<number> {
	let category = "invalid_arguments";
	try {
		const { values } = parseArgs({
			args,
			options: { models: { type: "boolean" }, help: { type: "boolean", short: "h" } },
		});
		if (values.help) {
			process.stdout.write("Usage: node check-config.js [--models]\n");
			return 0;
		}
		category = "invalid_configuration";
		const config = loadConfig(configDir);
		if (values.models) {
			category = "runtime_unavailable";
			// Pi restores its local catalog and credentials. No explicit network refresh is needed here.
			const runtime = await createInstalledPiModelRuntime({ cwd: config.configDir });
			const { bot } = config;
			assertBotModelConfigured({ ...bot, thinkingLevel: bot.reasoningEffort }, runtime);
			if (runtime.getModel(bot.provider, bot.model)!.contextWindow <= MIN_COMPACTION_RESERVE) {
				category = "context_window_too_small";
				throw new Error();
			}
			if (bot.tools.viewImage && !runtime.getModel(bot.provider, bot.model)!.input.includes("image"))
				throw new PiModelConfigurationError("image_input_unsupported", bot.provider, bot.model);
			if (bot.decider) {
				category = "decider_unavailable";
				createDecider(runtime, bot.decider, bot.name);
			}
			if (config.media.mode === "hybrid")
				assertPiVisionExecutorReady(createPiVisionExecutor(runtime, config.media.visionModel));
		}
		process.stdout.write(
			`${JSON.stringify({ ok: true, bot: config.bot.name, models_checked: values.models === true })}\n`,
		);
		return 0;
	} catch (error) {
		if (error instanceof PiModelConfigurationError) category = error.category;
		else if (error instanceof ConfigError) category = "invalid_configuration";
		process.stderr.write(`${JSON.stringify({ ok: false, category })}\n`);
		return 1;
	}
}

if (import.meta.main) process.exitCode = await main();
