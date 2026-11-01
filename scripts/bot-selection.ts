import { parseArgs } from "node:util";
import type { BotConfig } from "../src/config.ts";

/** Parse the shared, required `--bot <id>` selector used by scripts that act as one configured bot. */
export function selectConfiguredBot<T extends Pick<BotConfig, "id">>(bots: readonly T[], args: readonly string[]): T {
	const valid = `valid bot ids: ${bots.map((bot) => bot.id).join(", ")}`;
	const { values } = parseArgs({ args: [...args], options: { bot: { type: "string" } } });
	if (!values.bot) throw new Error(`missing required --bot <id>; ${valid}`);
	const bot = bots.find((candidate) => candidate.id === values.bot);
	if (!bot) throw new Error(`unknown bot id "${values.bot}"; ${valid}`);
	return bot;
}
