import assert from "node:assert/strict";
// Search security boundary: it never fetches a non-public target.

import { test } from "node:test";
import { runTinyFishTool, validatePublicHttpUrl } from "../src/tools/search.ts";

test("search accepts only public HTTP(S) targets and never fetches the rest", async () => {
	assert.equal(validatePublicHttpUrl("https://[2001:4860:4860::8888]/").hostname, "2001:4860:4860::8888");
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
		"http://[::127.0.0.1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:0:127.0.0.1]/",
		"http://[64:ff9b::169.254.169.254]/",
		"http://[2002:7f00:0001::1]/",
		"http://[fe80::1]/",
	]) {
		assert.equal((await runTinyFishTool("key", { url }, { fetchPage })).content, "search failed: invalid_url");
	}
	assert.equal(calls, 0);
});
