// Process-wide HTTP/1.1 dispatcher (adapted from Pi coding-agent/p2).
// Node's bundled fetch negotiates HTTP/2 per origin; a dead session can fail or wedge every later
// request with ERR_HTTP2_INVALID_SESSION, and mid-stream termination can emit unhandled Client 'error'.

import { EventEmitter } from "node:events";
import * as undici from "undici";

const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;
const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

const ignoreError = (_error: unknown): void => {};

function quiet<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreError);
	}
	return dispatcher;
}

const createClient = (origin: string | URL, options: object): undici.Dispatcher =>
	quiet(new undici.Client(origin, options as undici.Client.Options));

const createOriginDispatcher = (origin: string | URL, options: object): undici.Dispatcher => {
	const poolOptions = options as undici.Pool.Options;
	if (poolOptions.connections === 1) return createClient(origin, poolOptions);
	return quiet(new undici.Pool(origin, { ...poolOptions, factory: createClient }));
};

export function configureHttpDispatcher(timeoutMs = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const idleTimeout =
		Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.floor(timeoutMs) : DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	undici.setGlobalDispatcher(
		quiet(
			new undici.EnvHttpProxyAgent({
				allowH2: false,
				proxyTunnel: true,
				bodyTimeout: idleTimeout,
				headersTimeout: idleTimeout,
				connect: { autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS },
				clientFactory: createClient,
				factory: createOriginDispatcher,
			}),
		),
	);
	const canInstall =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (canInstall) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}
