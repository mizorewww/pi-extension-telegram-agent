// Security boundary of the search tool: it never fetches a non-public target or leaks
// queries/URLs/keys into telemetry, and long pages stay readable page by page.

import { expect, test } from "bun:test";
import { runTinyFishTool, validatePublicHttpUrl } from "../src/tools/search.ts";

test("search accepts only public HTTP(S) targets and never fetches the rest", async () => {
	expect(validatePublicHttpUrl("https://[2001:4860:4860::8888]/").hostname).toBe("2001:4860:4860::8888");
	let calls = 0;
	const fetchPage = async () => {
		calls++;
		throw new Error("must not run");
	};
	for (const url of [
		"ftp://example.com/file",
		"https://user:password@example.com/",
		"http://localhost/",
		"http://127.0.0.1/",
		"http://2130706433/",
		"http://0x7f000001/",
		"http://10.1.2.3/",
		"http://169.254.169.254/latest/meta-data/",
		"http://192.168.1.1/",
		"http://[::1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[fe80::1]/",
	]) {
		expect((await runTinyFishTool("key", { url }, { fetchPage })).content).toBe("search failed: invalid_url");
	}
	expect(calls).toBe(0);
});

test("search marks pages untrusted and keeps secrets out of telemetry", async () => {
	const deps = {
		search: async () => [{ title: "T", url: "https://example.com", snippet: "S" }],
		fetchPage: async () => ({
			title: "T",
			hostname: "example.com",
			content: "body-secret",
			characters: 11,
			truncated: false,
		}),
	};
	const query = await runTinyFishTool("api-secret", { query: "query-secret" }, deps);
	const page = await runTinyFishTool("api-secret", { url: "https://example.com/p?token=url-secret#f" }, deps);
	const dual = await runTinyFishTool("api-secret", { query: "q", url: "https://example.com" }, deps);
	expect(page.content).toContain("[END UNTRUSTED WEB CONTENT]");
	expect(dual.content).toBe("search failed: invalid_request");
	const telemetry = JSON.stringify([query.event, query.details, page.event, page.details, dual.event]);
	for (const secret of ["query-secret", "url-secret", "body-secret", "api-secret"])
		expect(telemetry).not.toContain(secret);
});

// Regression: bytes/2 token estimate cut CJK pages to ~1.3k chars with no way to read on.
test("search pages through a long fetched page without refetching it", async () => {
	let calls = 0;
	const text = Array.from({ length: 30_000 }, (_, i) => "天地玄黄宇宙洪荒"[i % 8]).join("");
	const fetchPage = async () => {
		calls++;
		return { title: "T", hostname: "example.com", content: text, characters: text.length, truncated: false };
	};
	const url = "https://example.com/long-cjk";
	const read = (offset?: number) =>
		runTinyFishTool("key", offset === undefined ? { url } : { url, offset }, { fetchPage });
	const body = (content: string) => content.split("\n\n").slice(1).join("\n\n").split("\n[")[0] as string;

	let offset = 0;
	let joined = "";
	for (let page = 0; page < 20; page++) {
		const result = await read(page === 0 ? undefined : offset);
		const chunk = body(result.content);
		if (page === 0) expect(chunk.length).toBeGreaterThan(3_000);
		joined += chunk;
		if (result.details.next_offset === undefined) {
			expect(result.content).toContain("[END OF PAGE]");
			break;
		}
		offset = result.details.next_offset as number;
		expect(result.content).toContain(`offset: ${offset}`);
	}
	expect(joined).toBe(text);
	expect(calls).toBe(1);
});
