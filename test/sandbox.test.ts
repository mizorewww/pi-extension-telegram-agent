// Security boundaries of the model-facing tools: run_js cannot reach the host realm, and
// search never fetches a non-public target or leaks queries/URLs/keys into telemetry.

import { expect, test } from "bun:test";
import { BWRAP, runJs, sandboxCommand } from "../src/tools/run-js.ts";
import { runTinyFishTool, validatePublicHttpUrl } from "../src/tools/search.ts";

test("run_js exposes no host globals", async () => {
	const r = await runJs("[typeof process, typeof require, typeof Bun, typeof fetch].join(',')");
	expect(r.ok).toBe(true);
	expect(r.output).toContain("undefined,undefined,undefined,undefined");
});

// Real payloads against the real sandbox; do not weaken them.
for (const vector of [
	'console.log.constructor("return typeof process")()',
	'this.constructor.constructor("return typeof process")()',
	'(async function(){}).constructor("return typeof process")()',
	'new Function("return typeof process")()',
	'eval("typeof process")',
]) {
	test(`run_js escape vector is blocked: ${vector}`, async () => {
		const r = await runJs(vector);
		expect(r.ok).toBe(false);
		expect(r.output).not.toContain('"object"');
	});
}

test("run_js bounds runaway loops and output", async () => {
	expect((await runJs("while(true){}")).ok).toBe(false);
	const flood = await runJs("for (let i = 0; i < 1000; i++) console.log('x'.repeat(100)); 'done'");
	expect(flood.output.length).toBeLessThanOrEqual(4096 + 20);
}, 15000);

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

// Defense in depth below the vm: even raw code (no vm) inside the confinement must not see the
// project, .env or the network. Only runs where bubblewrap exists (production Linux hosts).
test.skipIf(!BWRAP)(
	"run_js confinement hides the project and the network from raw code",
	async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join, resolve } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "runjs-confine-"));
		try {
			const probe = `const fs = require("node:fs");
let file = "hidden"; try { fs.readFileSync(${JSON.stringify(resolve("package.json"))}); file = "visible"; } catch {}
let net = "blocked"; try { await fetch("http://1.1.1.1", { signal: AbortSignal.timeout(2000) }); net = "open"; } catch {}
console.log(JSON.stringify({ file, net }));`;
			writeFileSync(join(dir, "wrapper.mjs"), probe);
			writeFileSync(join(dir, "code.js"), "");
			const { command, args } = sandboxCommand(process.execPath, dir);
			const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "ignore" });
			const out = await new Response(child.stdout).text();
			expect(JSON.parse(out.trim())).toEqual({ file: "hidden", net: "blocked" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	15000,
);
