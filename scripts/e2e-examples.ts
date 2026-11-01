// E2E check of the prompt's tool examples (src/agent/tool-examples.md): every 【脚本】 example runs
// in Pi's codemode sandbox against the real script tools — tg_messages on a read-only database,
// real TinyFish search, a scratch work box "ex", real Telegram getFile. tg_post is only recorded,
// nothing is sent to the group. Paid search calls and network; run only with authorization.
// Usage: bun run scripts/e2e-examples.ts --photo <msg id> --pdf <msg id> --thread <msg id> --sender @user [--only 03]
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { loadConfig } from "../src/config.ts";
import { WorkBox } from "../src/sandbox/box.ts";
import { BotApi } from "../src/telegram/api.ts";
import { queryMessages } from "../src/tools/messages.ts";
import { runTinyFishTool } from "../src/tools/search.ts";

const args = process.argv.slice(2);
const arg = (name: string) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : undefined;
};
const [photo, pdf, thread, sender] = ["photo", "pdf", "thread", "sender"].map(arg);
if (!photo || !pdf || !thread || !sender) {
	console.error("usage: --photo <id> --pdf <id> --thread <id> --sender @user [--only NN]");
	process.exit(2);
}
const config = loadConfig(process.cwd());
if (!config.sandbox) throw new Error("this deployment has no sandbox section");
const db = new Database(config.dbPath, { readonly: true });
const box = new WorkBox("ex", config.sandbox);
const api = new BotApi(config.bots[0]!.token);
const posts: string[] = [];

// Placeholder ids in the examples, mapped onto real messages of this deployment.
const substitutions: [string, string][] = [
	["5678", photo],
	["5690", photo],
	["5680", pdf],
	["4321", thread],
	["@alice", sender],
	["https://example.com/phone-review", "https://zh.wikipedia.org/wiki/锂离子电池"],
];
const scripts = [
	...readFileSync("src/agent/tool-examples.md", "utf8").matchAll(/【脚本】([^\n]*)\n```js\n([\s\S]*?)```/g),
].map((match, index) => ({
	name: String(index + 1).padStart(2, "0"),
	title: match[1]!.trim(),
	code: substitutions.reduce((code, [from, to]) => code.replaceAll(from, to), match[2]!),
}));

const tools = [
	{ name: "tg_messages", execute: async (input: any) => queryMessages(db, config.groupChatId, input) },
	{ name: "search", execute: async (input: any) => (await runTinyFishTool(config.tinyfishApiKey, input)).content },
	{ name: "sh_exec", execute: async (input: any) => await box.exec(input.command, input.timeout_s) },
	{ name: "sh_reset", execute: async () => ({ reset: true }) },
	{
		name: "tg_download",
		execute: async (input: any) => {
			const row = db
				.query("SELECT media FROM messages WHERE chat_id = ? AND message_id = ?")
				.get(config.groupChatId, input.message_id) as { media: string | null } | null;
			const media = row?.media ? JSON.parse(row.media) : null;
			if (!media) throw new Error("tg_download failed: no attachment on that message");
			const file = await api.getFile(media.file_id);
			const bytes = await api.downloadFile(file.file_path!);
			const extension = /\.[A-Za-z0-9]{1,8}$/.exec(file.file_path!)?.[0] ?? "";
			const path = await box.writeFile(`inbox/${input.message_id}${extension}`, bytes);
			return { path, size: bytes.byteLength, kind: media.kind };
		},
	},
	{
		name: "tg_post",
		execute: async (input: any) => {
			posts.push(input.message);
			return { sent: [posts.length] };
		},
	},
];

let failed = 0;
for (const script of scripts.filter((s) => !arg("only") || s.name === arg("only"))) {
	const sandbox = new CodemodeSandbox({ tools, timeoutMs: 240_000 });
	const started = Date.now();
	posts.length = 0;
	const result = await sandbox.execute(script.code);
	await sandbox.close();
	const output = [
		...result.output.map((item) => (item.type === "text" ? item.text : `[${item.type}]`)),
		...(result.ok && result.value !== undefined
			? [typeof result.value === "string" ? result.value : JSON.stringify(result.value)]
			: []),
	].join("\n");
	// An example that prints nothing would leave the bot with nothing to say: count it as a failure.
	const ok = result.ok && output.trim().length > 0;
	if (!ok) failed++;
	console.log(
		`\n=== ${script.name} ${ok ? "OK" : "FAIL"} ${((Date.now() - started) / 1000).toFixed(1)}s ${script.title}`,
	);
	console.log(result.ok ? output.slice(0, 600) : `${result.error.kind}: ${result.error.message}`);
	if (posts.length) console.log(`tg_post: ${posts.join(" | ")}`);
}
await box.reset();
console.log(`\n${scripts.length - failed}/${scripts.length} examples passed`);
process.exit(failed ? 1 : 0);
