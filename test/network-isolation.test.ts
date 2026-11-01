// The test preload blocks every external fetch, so `bun test` can never make a paid call.

import { expect, test } from "bun:test";

test("bun test rejects paid/external fetches even when real credentials exist", async () => {
	await expect(fetch("https://api.search.tinyfish.ai/?query=must-not-run")).rejects.toThrow(
		"external network is disabled in bun test",
	);
});
