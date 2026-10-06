import type { BotConfig } from "../config.ts";
import type { InlineKeyboardMarkup } from "./api.ts";

/** Preset choices; callback data carries only these values, so a forged button cannot set others. */
const ROUTING_CHOICES = [0, 0.1, 0.25, 0.5, 0.75, 1] as const;
const COOLDOWN_CHOICES = [
	[0, "关"],
	[2_000, "2 秒"],
	[10_000, "10 秒"],
	[30_000, "30 秒"],
	[60_000, "1 分钟"],
	[300_000, "5 分钟"],
] as const;

export type SettingsChoice = { parameter: "routing_p" | "cooldown_ms"; value: number };

/** `set:r:<value>` / `set:c:<ms>` back to a preset choice; anything else is a stale or forged button. */
export function parseSettingsChoice(data: string): SettingsChoice | null {
	const match = /^set:([rc]):(\d+(?:\.\d+)?)$/.exec(data);
	if (!match) return null;
	const value = Number(match[2]);
	if (match[1] === "r") return ROUTING_CHOICES.includes(value as never) ? { parameter: "routing_p", value } : null;
	return COOLDOWN_CHOICES.some(([ms]) => ms === value) ? { parameter: "cooldown_ms", value } : null;
}

export function cooldownLabel(ms: number): string {
	return COOLDOWN_CHOICES.find(([value]) => value === ms)?.[1] ?? `${ms / 1000} 秒`;
}

export function renderSettingsMenu(bot: BotConfig): { text: string; replyMarkup: InlineKeyboardMarkup } {
	const mark = (selected: boolean, label: string) => `${selected ? "✓ " : ""}${label}`;
	return {
		text: [
			`${bot.name} · 插话设置`,
			`插话概率：${bot.routingP}（没被点名时接话的机会；@、回复、点名总会回应）`,
			`冷却：${cooldownLabel(bot.samplingCooldownMs)}（主动接话后多久内不再主动接话）`,
			"点按钮立即生效并写回配置，重启后仍然有效。",
		].join("\n"),
		replyMarkup: {
			inline_keyboard: [
				[{ text: "插话概率", callback_data: "set:noop" }],
				ROUTING_CHOICES.map((value) => ({
					text: mark(bot.routingP === value, String(value)),
					callback_data: `set:r:${value}`,
				})),
				[{ text: "冷却", callback_data: "set:noop" }],
				COOLDOWN_CHOICES.slice(0, 3).map(([ms, label]) => ({
					text: mark(bot.samplingCooldownMs === ms, label),
					callback_data: `set:c:${ms}`,
				})),
				COOLDOWN_CHOICES.slice(3).map(([ms, label]) => ({
					text: mark(bot.samplingCooldownMs === ms, label),
					callback_data: `set:c:${ms}`,
				})),
			],
		},
	};
}
