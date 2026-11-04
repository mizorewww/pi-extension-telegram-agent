import assert from "node:assert/strict";
// The test preload blocks every external fetch, so `npm test` can never make a paid call.

import { test } from "node:test";

test("npm test rejects paid/external fetches even when real credentials exist", async () => {
	await assert.rejects(fetch("https://api.search.tinyfish.ai/?query=must-not-run"), {
		message: "external network is disabled in npm test",
	});
});
