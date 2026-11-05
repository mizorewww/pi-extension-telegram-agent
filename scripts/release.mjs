// Package on the target OS: Pi resolves its workers, WASM and native binaries from installed packages.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.arch !== "x64")
	throw new Error("Release packages must be built on Linux x64; use the GitHub Release workflow.");
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node.js 24 or newer is required.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tag = `v${manifest.version}`;
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Release version must be MAJOR.MINOR.PATCH.");
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== tag)
	throw new Error(`Release tag must match package.json (${tag}).`);
const output = join(root, "dist", "release");
const temporary = mkdtempSync(join(tmpdir(), "pi-telegram-release-"));
const stage = join(temporary, "pi-telegram-agent");
const archive = `pi-telegram-agent-${tag}-linux-x64.tar.gz`;

try {
	mkdirSync(stage);
	for (const path of [
		"package.json", "package-lock.json", "LICENSE", "README.md", "CHANGELOG.md", "deploy",
		"telegram.config.example.ts", ".env.example", "personas/template.en.md", "personas/template.zh.md",
		"dist/src", ...["check-config", "debug-report", "smoke-pi", "e2e-agent", "e2e-compaction"].map(name => `dist/scripts/${name}.js`),
	]) {
		mkdirSync(dirname(join(stage, path)), { recursive: true });
		cpSync(join(root, path), join(stage, path), { recursive: true });
	}
	execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit" });
	// Run from the isolated artifact: no repository node_modules, credentials, provider or Telegram calls.
	const probe = join(stage, ".release-check.mjs");
	writeFileSync(probe, `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { packagedDaemon } from "@earendil-works/pi-env";
globalThis.fetch = async () => { throw new Error("Release smoke must stay offline"); };
await import("./dist/src/agent/runtime.js");
const sandbox = new CodemodeSandbox({ timeoutMs: 10000 });
try { const result = await sandbox.execute("return 6 * 7"); assert.equal(result.ok, true); assert.equal(result.value, 42); }
finally { await sandbox.close(); }
const images = await createNodePhotonImages({ idleMs: 1 });
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==", "base64"));
assert.ok(await images.prepare(png, "image/png", DEFAULT_IMAGE_LIMITS));
const harness = await Harness.open(await openNodeSqliteStorage(":memory:"), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
try { assert.ok(await harness.root(BACKGROUND_CONTEXT)); } finally { await harness.close(BACKGROUND_CONTEXT); }
assert.match(execFileSync(packagedDaemon({ platform: "linux", arch: "x64" }), ["--version"], { encoding: "utf8" }), /pi-env 1\\.5\\.0/);
console.log("PASS: packaged runtime, QuickJS worker/WASM, Photon worker/WASM, SQLite and pi-env");
`);
	try {
		execFileSync(process.execPath, [probe], { cwd: stage, stdio: "inherit", timeout: 30_000 });
	} finally {
		rmSync(probe);
	}
	mkdirSync(output, { recursive: true });
	execFileSync("tar", ["-czf", join(output, archive), "-C", temporary, "pi-telegram-agent"], { stdio: "inherit" });
	cpSync(join(stage, "deploy/install.sh"), join(output, "install.sh"));
	let sums = "";
	for (const name of [archive, "install.sh"]) {
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(join(output, name))) hash.update(chunk);
		sums += `${hash.digest("hex")}  ${name}\n`;
	}
	writeFileSync(join(output, "SHA256SUMS"), sums);
	console.log(`Release assets: ${output}`);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
