// Unit/replay tests are hermetic even when a developer's real .env is present.
// Local loopback servers remain available for protocol-level integration tests.

import { setLogSink } from "../src/observability/log.ts";

// Production writes JSONL to stdout. Tests capture individual events explicitly and keep the
// default suite output quiet, including high-volume boundedness fixtures.
setLogSink(() => {});

const nativeFetch = globalThis.fetch.bind(globalThis);

function isLoopback(hostname: string): boolean {
	const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
	let target: URL;
	try {
		target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
	} catch {
		return nativeFetch(input, init);
	}
	if ((target.protocol === "http:" || target.protocol === "https:") && !isLoopback(target.hostname)) {
		return Promise.reject(new Error("external network is disabled in npm test"));
	}
	return nativeFetch(input, init);
}) as typeof fetch;
