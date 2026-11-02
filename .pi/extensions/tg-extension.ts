import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { loadConfig, type BotConfig } from "../../src/config.ts";
import type { AgentStreamFrame, BotStats, MsgItem, RuntimeControlSnapshot, TimelineItem } from "../../src/ipc.ts";
import {
	itemKey,
	readMediaImage,
	TimelineClient,
	type TimelineEvent,
	type TimelineHooks,
} from "../../src/plugin/timeline.ts";
import {
	activityComponent,
	detachedEntry,
	type FeedEntry,
	fmtDay,
	itemComponent,
	type StatusBot,
	statsText,
	streamComponent,
	telegramFeedHeaderLine,
	telegramStatusLine,
	telegramUsage,
	type ToolPresentationHost,
} from "../../src/plugin/tg-view.ts";

export { activityComponent, itemComponent, statsText, telegramStatusLine, telegramUsage };

const ENTRY_TYPE = "telegram-chat";
const FEED_WIDGET_KEY = "telegram-feed";
const STATUS_KEY = "telegram";
const MAX_ACTIVE_STREAMS = 32;
const MAX_ENDED_STREAMS = 64;

type TimelineFactory = (filter: string | null, hooks: TimelineHooks) => TimelineClient;
type TgCommandDispatch = "attach" | "more" | "detach" | "status";

/** Every /tg subcommand; `bot` names its single optional trailing argument. */
const TG_COMMANDS: Record<TgCommandDispatch, { description: string; bot?: "bot" }> = {
	attach: { description: "Open all bots or one bot for chat", bot: "bot" },
	more: { description: "Load one older history page" },
	detach: { description: "Disconnect the live feed" },
	status: { description: "Show detailed usage", bot: "bot" },
};

function formatTgHelp(): string {
	const syntax = Object.entries(TG_COMMANDS).map(([token, command]) =>
		command.bot ? `${token} [${command.bot}]` : token,
	);
	return `usage: /tg ${syntax.join(" | ")}`;
}

function completeTgArguments(
	argumentPrefix: string,
	bots: readonly Pick<BotConfig, "id" | "name">[],
): { value: string; label: string; description?: string }[] | null {
	const tokens = argumentPrefix.trimStart().split(/\s+/);
	const command = tokens.length === 2 ? TG_COMMANDS[tokens[0] as TgCommandDispatch] : undefined;
	const candidates =
		tokens.length === 1
			? Object.entries(TG_COMMANDS).map(([token, { description }]) => ({ token, label: token, description }))
			: command?.bot
				? bots.map((bot) => ({
						token: bot.id,
						label: bot.name === bot.id ? bot.id : `${bot.id} (${bot.name})`,
						description: `Telegram bot ${bot.name}`,
					}))
				: [];
	const partial = tokens.at(-1)!.toLocaleLowerCase("en");
	const matches = candidates.filter((candidate) => candidate.token.toLocaleLowerCase("en").startsWith(partial));
	if (matches.length === 0) return null;
	const prefix = tokens.length === 2 ? `${tokens[0]} ` : "";
	return matches.map(({ token, label, description }) => ({ value: `${prefix}${token}`, label, description }));
}

type ParsedTgCommand =
	| { ok: true; dispatch: TgCommandDispatch; arguments: string[] }
	| { ok: false; reason: "empty" | "unknown" | "extra" };

/** An unknown bot argument is passed through so the handler can name the configured bots. */
function parseTgArguments(input: string): ParsedTgCommand {
	const tokens = input.trim() ? input.trim().split(/\s+/) : [];
	if (tokens.length === 0) return { ok: false, reason: "empty" };
	const dispatch = tokens[0] as TgCommandDispatch;
	const command = Object.hasOwn(TG_COMMANDS, dispatch) ? TG_COMMANDS[dispatch] : undefined;
	if (!command) return { ok: false, reason: "unknown" };
	if (tokens.length > (command.bot ? 2 : 1)) return { ok: false, reason: "extra" };
	return { ok: true, dispatch, arguments: tokens.slice(1) };
}

class TelegramFeed extends Tui.Container {
	readonly client: TimelineClient;
	private readonly content = new Tui.Container();
	private readonly streamContent = new Tui.Container();
	private readonly items: TimelineItem[] = [];
	private readonly cardSlots = new Map<string, Tui.Container>();
	private readonly streams = new Map<string, Extract<AgentStreamFrame, { phase: "update" }>>();
	private readonly endedStreams = new Set<string>();
	private statsValue: Record<string, BotStats> = {};
	private statusesValue: Record<string, RuntimeControlSnapshot> = {};
	private closed = false;

	constructor(
		readonly filter: string | null,
		private readonly theme: Theme,
		factory: TimelineFactory,
		private readonly changed: (event: TimelineEvent, feed: TelegramFeed) => void,
		private readonly requestRender: () => void,
		private readonly toolHost?: ToolPresentationHost,
	) {
		super();
		this.addChild(this.content);
		this.addChild(this.streamContent);
		this.client = factory(filter, { onEvent: (event) => this.onEvent(event) });
	}

	get stats(): Record<string, BotStats> {
		return this.statsValue;
	}
	get statuses(): Record<string, RuntimeControlSnapshot> {
		return this.statusesValue;
	}
	start(): void {
		void this.client.connect();
	}
	more(): boolean {
		return this.client.requestOlder();
	}

	/** Drop the live socket and ephemeral state; already-rendered history stays. Idempotent. */
	detach(): void {
		if (this.closed) return;
		this.closed = true;
		this.client.dispose();
		this.clearStreams();
	}

	private onEvent(event: TimelineEvent): void {
		if (event.type === "append") {
			this.items.push(...event.items);
			this.appendItems(event.items);
		} else if (event.type === "prepend") {
			this.items.unshift(...event.items);
			this.rebuildItems();
		} else if (event.type === "stats") {
			this.statsValue = event.stats;
			this.statusesValue = event.statuses;
		} else if (event.type === "vision") {
			this.patchItems((item) => item.fileUniqueId === event.fileUniqueId && item.mediaDesc !== event.text, {
				mediaDesc: event.text,
			});
		} else if (event.type === "media") {
			this.patchItems((item) => item.fileUniqueId === event.fileUniqueId && item.mediaPath !== event.mediaPath, {
				mediaPath: event.mediaPath,
			});
		} else if (event.type === "stream") {
			this.applyStream(event.stream);
		} else {
			this.clearStreams();
		}
		this.changed(event, this);
	}

	private appendItems(items: TimelineItem[]): void {
		let previousDay =
			this.items.length > items.length ? fmtDay(this.items[this.items.length - items.length - 1]!.ts) : "";
		for (const item of items) {
			const day = fmtDay(item.ts);
			if (day !== previousDay)
				this.content.addChild(new Tui.Text(this.theme.fg("dim", `──────── ${day} ────────`), 1, 0));
			const slot = new Tui.Container();
			slot.addChild(itemComponent(item, this.theme, readMediaImage, this.toolHost));
			this.cardSlots.set(itemKey(item), slot);
			this.content.addChild(slot);
			this.content.addChild(new Tui.Spacer(1));
			previousDay = day;
		}
	}

	private rebuildItems(): void {
		this.content.clear();
		this.cardSlots.clear();
		this.appendItems(this.items);
	}

	/** Apply `patch` to every matching message and re-render only those cards in place. */
	private patchItems(predicate: (item: MsgItem) => boolean, patch: Partial<MsgItem> = {}): void {
		let refreshed = false;
		for (let index = 0; index < this.items.length; index++) {
			const item = this.items[index]!;
			if (item.kind !== "msg" || !predicate(item)) continue;
			const updated = { ...item, ...patch };
			this.items[index] = updated;
			const slot = this.cardSlots.get(itemKey(updated));
			if (!slot) continue;
			slot.clear();
			slot.addChild(itemComponent(updated, this.theme, readMediaImage, this.toolHost));
			refreshed = true;
		}
		if (refreshed) this.requestRender();
	}

	private applyStream(stream: AgentStreamFrame): void {
		const key = `${stream.botId}:${stream.streamId}`;
		if (stream.phase === "end") {
			this.streams.delete(key);
			this.rememberEnded(key);
			this.rebuildStreams();
			return;
		}
		if (this.endedStreams.has(key)) return;
		if (!this.streams.has(key) && this.streams.size >= MAX_ACTIVE_STREAMS) {
			const oldest = this.streams.keys().next().value as string | undefined;
			if (oldest) this.streams.delete(oldest);
		}
		this.streams.delete(key);
		this.streams.set(
			key,
			stream.phase === "start"
				? {
						...stream,
						phase: "update",
						activity: {
							version: 1,
							activityId: stream.streamId,
							startedAt: stream.ts,
							sections: [],
							truncated: false,
						},
					}
				: stream,
		);
		this.rebuildStreams();
	}

	private rememberEnded(key: string): void {
		this.endedStreams.delete(key);
		this.endedStreams.add(key);
		while (this.endedStreams.size > MAX_ENDED_STREAMS) {
			const oldest = this.endedStreams.keys().next().value as string | undefined;
			if (!oldest) break;
			this.endedStreams.delete(oldest);
		}
	}

	private rebuildStreams(): void {
		this.streamContent.clear();
		for (const stream of this.streams.values()) {
			this.streamContent.addChild(streamComponent(stream, this.theme, this.toolHost));
			this.streamContent.addChild(new Tui.Spacer(1));
		}
	}

	private clearStreams(): void {
		if (this.streams.size === 0) return;
		this.streams.clear();
		this.rebuildStreams();
	}
}

/** `/tg status [bot]`: one short IPC connection reads a fresh stats + runtime snapshot, then disconnects. */
function showTelegramStatus(
	ctx: ExtensionContext,
	filter: string | null,
	factory: TimelineFactory,
	bots: readonly StatusBot[],
): Promise<void> {
	return new Promise<void>((resolve) => {
		let client: TimelineClient;
		let done = false;
		const finish = (text: string, type: "info" | "error") => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			client.dispose();
			ctx.ui.notify(text, type);
			resolve();
		};
		const timer = setTimeout(() => finish("timed out waiting for Telegram telemetry", "error"), 3000);
		client = factory(filter, {
			onEvent: (event) => {
				if (event.type === "stats") {
					const text = Object.entries(event.stats)
						.map(([id, stats]) =>
							statsText(
								id,
								stats,
								bots.find((bot) => bot.id === id),
								event.statuses[id],
								ctx,
							),
						)
						.join("\n\n");
					finish(text || "no telemetry yet", "info");
				} else if (event.type === "disconnected") finish(event.reason, "error");
			},
		});
		void client.connect();
	});
}

export function registerTelegramExtension(pi: ExtensionAPI, rootDir = process.cwd()): void {
	const factory: TimelineFactory = (filter, hooks) =>
		new TimelineClient(join(rootDir, "data", "daemon.sock"), filter, hooks);
	const feeds = new Map<string, TelegramFeed>();
	let pending: { data: FeedEntry; changed: (event: TimelineEvent, feed: TelegramFeed) => void } | null = null;
	let active: TelegramFeed | null = null;
	let lastUi: ExtensionContext["ui"] | null = null;
	let bots: BotConfig[] | undefined;
	let requestHostRender: (() => void) | null = null;
	let toolHost: ToolPresentationHost | undefined;

	/** Startup-validated config, read from disk once per process. Throws on error. */
	const loadBots = (): BotConfig[] => {
		if (!bots) bots = loadConfig(rootDir).bots;
		return bots;
	};
	const configuredBots = (): BotConfig[] => {
		try {
			return loadBots();
		} catch {
			return [];
		}
	};
	const findBot = (id: string, ui: ExtensionContext["ui"]): BotConfig | undefined => {
		try {
			const all = loadBots();
			const bot = all.find((candidate) => candidate.id === id);
			if (bot) return bot;
			ui.notify(
				`unknown bot id "${id}"; configured bots: ${all.map((candidate) => candidate.id).join(", ") || "(none)"}`,
				"error",
			);
		} catch (error) {
			ui.notify(`config error: ${(error as Error).message}`, "error");
		}
		return undefined;
	};
	/** null = all bots, undefined = invalid (already notified). */
	const resolveFilter = (arg: string | undefined, ui: ExtensionContext["ui"]): string | null | undefined =>
		arg ? findBot(arg, ui)?.id : null;

	const clearFeedUi = (ui: ExtensionContext["ui"] | null) => {
		requestHostRender = null;
		toolHost = undefined;
		ui?.setWidget(FEED_WIDGET_KEY, undefined);
		ui?.setStatus(STATUS_KEY, undefined);
	};
	/** The one way a live feed stops: socket closed, widget/footer restored. */
	const teardownFeed = (ui: ExtensionContext["ui"] | null) => {
		active?.detach();
		active = null;
		clearFeedUi(ui);
	};
	const mountFeedUi = (filter: string | null, ctx: ExtensionContext) => {
		const scope = filter ? `bot ${filter}` : "all bots";
		ctx.ui.setWidget(
			FEED_WIDGET_KEY,
			(tui, theme) => {
				requestHostRender = () => tui.requestRender();
				toolHost = { ui: tui, cwd: ctx.cwd };
				return {
					render: (width) => [telegramFeedHeaderLine(width, theme, scope)],
					invalidate() {},
				};
			},
			{ placement: "aboveEditor" },
		);
	};
	const attachFeed = (filter: string | null, ctx: ExtensionContext) => {
		teardownFeed(ctx.ui);
		mountFeedUi(filter, ctx);
		const data = { instanceId: randomUUID(), filter };
		pending = {
			data,
			changed: (event, feed) => {
				requestHostRender?.();
				if (event.type === "stats" && active === feed) {
					const usage = telegramUsage(filter, feed.stats, feed.statuses, configuredBots(), ctx);
					ctx.ui.setStatus(STATUS_KEY, usage ? telegramStatusLine(usage) : undefined);
				}
				if (event.type === "disconnected" && active === feed) {
					teardownFeed(ctx.ui);
					ctx.ui.notify(`Telegram feed disconnected: ${event.reason}`, "error");
				}
			},
		};
		pi.appendEntry<FeedEntry>(ENTRY_TYPE, data);
		if (pending) {
			pending = null;
			clearFeedUi(ctx.ui);
			ctx.ui.notify("Pi did not mount the Telegram transcript entry", "error");
		}
	};

	pi.registerEntryRenderer<FeedEntry>(ENTRY_TYPE, (entry, _renderOptions, theme) => {
		const data = entry.data as FeedEntry | undefined;
		if (!data) return new Tui.Text(theme.fg("error", "invalid Telegram feed entry"), 1, 0);
		const existing = feeds.get(data.instanceId);
		if (existing) return existing;
		if (pending?.data.instanceId !== data.instanceId) return detachedEntry(data, theme);
		const feed = new TelegramFeed(data.filter, theme, factory, pending.changed, () => requestHostRender?.(), toolHost);
		pending = null;
		feeds.set(data.instanceId, feed);
		active = feed;
		feed.start();
		return feed;
	});

	pi.on("session_shutdown", () => {
		teardownFeed(lastUi);
		for (const feed of feeds.values()) feed.detach();
	});

	pi.registerCommand("tg", {
		description: `Telegram: ${formatTgHelp().slice("usage: /tg ".length)}`,
		getArgumentCompletions: (argumentPrefix) => completeTgArguments(argumentPrefix, configuredBots()),
		handler: async (args, ctx) => {
			lastUi = ctx.ui;
			const parsed = parseTgArguments(args);
			if (!parsed.ok) {
				ctx.ui.notify(formatTgHelp(), parsed.reason === "empty" ? "info" : "error");
				return;
			}
			const sub = parsed.dispatch;
			const botArg = parsed.arguments[0];
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Telegram UI requires interactive mode", "error");
				return;
			}
			if (sub === "attach") {
				const filter = resolveFilter(botArg, ctx.ui);
				if (filter === undefined) return;
				attachFeed(filter, ctx);
			} else if (sub === "more") {
				if (!active?.client.isConnected) ctx.ui.notify("no connected Telegram feed; run /tg attach first", "warning");
				else if (!active.more())
					ctx.ui.notify(
						active.client.hasMore ? "Telegram history request already in progress" : "oldest Telegram record reached",
						"info",
					);
			} else if (sub === "detach") {
				if (!active) ctx.ui.notify("no live Telegram feed", "warning");
				else teardownFeed(ctx.ui);
			} else if (sub === "status") {
				const filter = resolveFilter(botArg, ctx.ui);
				if (filter === undefined) return;
				await showTelegramStatus(ctx, filter, factory, configuredBots());
			}
		},
	});
}

export default function telegramExtension(pi: ExtensionAPI): void {
	registerTelegramExtension(pi);
}
