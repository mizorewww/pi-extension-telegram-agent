import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { BotConfig } from "../config.ts";
import type { InlineKeyboardMarkup } from "./api.ts";

const PAGE_SIZE = 8;

/** Stable, bounded callback identities also work after a daemon restart or catalog reorder. */
export function modelMenuKey(provider: string, model?: string): string {
	return createHash("sha256")
		.update(JSON.stringify([provider, model ?? null]))
		.digest("hex")
		.slice(0, 24);
}

export interface ModelMenuView {
	text: string;
	replyMarkup: InlineKeyboardMarkup;
}

export function renderModelMenu(
	bot: BotConfig,
	models: readonly Model<Api>[],
	data = "model:r:0",
): ModelMenuView | null {
	const root = /^model:r:(\d{1,6})$/.exec(data);
	const providerPage = /^model:p:([a-f0-9]{24}):(\d{1,6})$/.exec(data);
	if (!root && !providerPage) return null;
	const providers = [...new Set(models.map((model) => model.provider))].sort();
	const provider = providerPage ? providers.find((id) => modelMenuKey(id) === providerPage[1]) : undefined;
	if (providerPage && !provider) return null;
	const page = Number(root?.[1] ?? providerPage![2]);
	const choices = provider
		? models
				.filter((model) => model.provider === provider)
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((model) => ({
					text: `${bot.provider === model.provider && bot.model === model.id ? "✓ " : ""}${model.id}`,
					callback_data: `model:s:${modelMenuKey(model.provider, model.id)}`,
				}))
		: providers.map((id) => ({ text: id, callback_data: `model:p:${modelMenuKey(id)}:0` }));
	const pages = Math.max(1, Math.ceil(choices.length / PAGE_SIZE));
	if (page >= pages) return null;
	const rows = choices.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((button) => [button]);
	const prefix = provider ? `model:p:${modelMenuKey(provider)}` : "model:r";
	const navigation = [];
	if (page > 0) navigation.push({ text: "‹ 上一页", callback_data: `${prefix}:${page - 1}` });
	if (page + 1 < pages) navigation.push({ text: "下一页 ›", callback_data: `${prefix}:${page + 1}` });
	if (navigation.length) rows.push(navigation);
	if (provider) rows.push([{ text: "‹ 提供商", callback_data: "model:r:0" }]);
	return {
		text: [
			`${bot.name} · 模型选择`,
			`当前：${bot.provider}/${bot.model}（${bot.reasoningEffort}）`,
			choices.length
				? `${provider ?? "请选择提供商"} · ${page + 1}/${pages}`
				: "Pi 暂无可用模型，请先在 Pi 中完成 /login。",
			"选择后立即保存并开启新会话；忙碌时请稍后重试。",
			"Reasoning 尽量沿用当前档位，不支持时按模型能力调整并显示结果。",
		].join("\n"),
		replyMarkup: { inline_keyboard: rows },
	};
}
