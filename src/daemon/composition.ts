import type { Database } from "bun:sqlite";
import type { AppConfig, BotConfig } from "../config.ts";
import { setBotState } from "../db/db.ts";
import type { BotIdentity } from "../agent/router.ts";
import { Poller, type MessageHandler } from "../telegram/poller.ts";

export interface IdentityApi {
	getMe(): Promise<{ id: number; username: string }>;
}

export interface DeploymentComposition<Api extends IdentityApi, Runtime> {
	botApis: Map<string, Api>;
	runtimes: Map<string, Runtime>;
	identities: BotIdentity[];
	botNames: Map<string, string>;
	botUserIds: Map<string, number>;
}

/** Build the identity/runtime maps consumed by routing, Telegram control, and IPC. */
export async function composeDeployment<Api extends IdentityApi, Runtime>(
	db: Database,
	config: Pick<AppConfig, "bots">,
	factories: {
		createApi: (bot: BotConfig) => Api;
		createRuntime: (bot: BotConfig, api: Api, apis: ReadonlyMap<string, Api>) => Promise<Runtime>;
		onIdentity?: (bot: BotConfig, identity: BotIdentity) => void | Promise<void>;
	},
): Promise<DeploymentComposition<Api, Runtime>> {
	const botApis = new Map(config.bots.map((bot) => [bot.id, factories.createApi(bot)] as const));
	const identities: BotIdentity[] = [];
	for (const bot of config.bots) {
		const me = await botApis.get(bot.id)!.getMe();
		setBotState(db, bot.id, "bot_user_id", String(me.id));
		setBotState(db, bot.id, "bot_username", me.username);
		const identity = { id: bot.id, userId: me.id, username: me.username, name: bot.name };
		identities.push(identity);
		await factories.onIdentity?.(bot, identity);
	}

	const runtimes = new Map<string, Runtime>();
	for (const bot of config.bots) {
		runtimes.set(bot.id, await factories.createRuntime(bot, botApis.get(bot.id)!, botApis));
	}

	return {
		botApis,
		runtimes,
		identities,
		botNames: new Map(config.bots.map((bot) => [bot.id, bot.name] as const)),
		botUserIds: new Map(identities.map((identity) => [identity.id, identity.userId] as const)),
	};
}

/** Construct one independent polling boundary per configured bot after identities exist. */
export function composePollers(
	db: Database,
	config: Pick<AppConfig, "bots" | "groupPeerId" | "media">,
	onMessage: MessageHandler,
): Poller[] {
	// media_update deltas (persisted vision descriptions) exist only in vision mode; context mode
	// attaches image blocks to the message event itself and never injects description text.
	const emitMediaUpdates = config.media.mode === "vision";
	return config.bots.map((bot) => new Poller(db, bot.id, bot.token, config.groupPeerId, onMessage, emitMediaUpdates));
}
