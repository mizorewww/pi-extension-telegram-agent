// Search security boundary: it never fetches a non-public target.

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
