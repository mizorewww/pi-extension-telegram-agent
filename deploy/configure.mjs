#!/usr/bin/env node
// Installation UI only; config.ts owns validation and Pi owns models and login.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { compile } from "@earendil-works/pi-schema";
import {
	configDirectory,
	configSchema,
	loadConfig,
	loadConfigSource,
	parseEnvFile,
	MIN_COMPACTION_RESERVE,
} from "../dist/src/config.js";
import { loadPiModelDefaults } from "../dist/src/agent/model-settings.js";
import { assertBotModelConfigured, createInstalledPiModelRuntime } from "../dist/src/agent/model-runtime.js";
import { createDecider, DEFAULT_DECIDER_THRESHOLD, GEMINI_DECIDER_PROVIDER } from "../dist/src/agent/decider.js";

const directory = configDirectory(),
	configPath = join(directory, "telegram.config.ts");
const properties = configSchema.properties;
const defaults = {
	reasoning_effort: "off",
	cache_retention: "short",
	context_window: 65536,
	compaction_threshold: 32768,
	compaction_keep_recent: 20000,
	cooldown_ms: 2000,
	provider_timeout_ms: 300000,
	provider_retries: 2,
	raw_update_retention_days: 30,
	message_event_retention_days: 365,
};
const labels = {
	reasoning_effort: "思考强度",
	cache_retention: "提示缓存保留（none/short/long）",
	context_window: "上下文窗口（token）",
	compaction_threshold: "自动压缩触发值（token）",
	compaction_keep_recent: "压缩后保留近期内容（token）",
	cooldown_ms: "接话后再次判断的冷却（毫秒）",
	provider_timeout_ms: "服务商每次请求超时（毫秒）",
	provider_retries: "服务商额外重试次数",
	raw_update_retention_days: "原始更新保留（天）",
	message_event_retention_days: "消息事件保留（天）",
	send: "允许发送消息",
	search: "启用 TinyFish 搜索",
	semantic: "启用群历史语义搜索（Gemini embedding，需要 Code Mode）",
	codemode: "启用 Pi Code Mode",
	sandbox: "启用沙箱文件/终端工具",
	tasks: "启用 Pi 后台任务",
	sticker_sets: "贴纸集名称（逗号分隔，- 清空）",
	max_per_turn: "每轮最多描述的媒体数",
	concurrency: "媒体处理并发数",
	image: "沙箱镜像",
	docker_host: "rootless Docker 地址",
	memory: "沙箱内存（例如 1g）",
	cpus: "沙箱 CPU 核数",
	pids: "沙箱进程上限",
	network: "允许沙箱联网",
	max_running: "后台任务最大并发",
	timeout_minutes: "后台任务超时（分钟）",
};
let stage = 0,
	category = "invalid_arguments",
	hidden = false,
	rl;
const cancelled = new AbortController(),
	files = new Map();
const print = (text) => process.stdout.write(text + "\n");
const step = (number, title) => {
	stage = number;
	print("\n正在配置… [" + stage + "/7] " + title + " ETA：等待输入");
};
const absolute = (path) => resolve(directory, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
const render = (value) => JSON.stringify(value, null, "\t").replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, "$1$2:");
function atomic(path, content) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = path + "." + randomUUID() + ".tmp";
	try {
		writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}
async function ask(label, fallback = "", schema, secret = false, signal) {
	const validator = schema && compile(schema);
	for (;;) {
		const shown = secret
			? fallback
				? "已保存；回车保留"
				: "隐藏输入"
			: Array.isArray(fallback)
				? fallback.join(",")
				: String(fallback);
		const question = "[" + stage + "/7] " + label + (shown ? " [" + shown + "]" : "") + "：";
		if (secret) process.stdout.write(question);
		hidden = secret;
		let text;
		try {
			text = (
				await rl.question(secret ? "" : question, {
					signal: signal ? AbortSignal.any([signal, cancelled.signal]) : cancelled.signal,
				})
			).trim();
		} finally {
			hidden = false;
			if (secret) print("");
		}
		let value = text || fallback;
		if (schema?.type === "boolean")
			value = /^(y|yes|true|1|是)$/i.test(String(value))
				? true
				: /^(n|no|false|0|否)$/i.test(String(value))
					? false
					: value;
		else if (schema?.type === "number" || schema?.type === "integer") value = Number(value);
		else if (schema?.type === "array")
			value =
				text === "-"
					? []
					: typeof value === "string"
						? value
								.split(/[,，\s]+/)
								.filter(Boolean)
								.map((part) => (schema.items.type === "integer" ? Number(part) : part))
						: value;
		if (!validator || validator.check(value)) return value;
		print("输入不符合 " + label + " 的类型或范围，请重试。");
	}
}
const yes = (label, fallback = false) => ask(label, fallback, { type: "boolean" });
const choose = (label, values, fallback = values[0]) => {
	if (!values.length) {
		category = "empty_model_or_auth_catalog";
		throw new Error();
	}
	return ask(label + "（" + values.join(" / ") + "）", fallback, { enum: values });
};
async function fields(target, schema, values, keys = Object.keys(values)) {
	for (const key of keys) target[key] = await ask(labels[key] ?? key, target[key] ?? values[key], schema[key]);
}
async function advanced(title, target, schema, values, keys = Object.keys(values)) {
	print(title + "：" + keys.map((key) => key + "=" + (target[key] ?? values[key])).join("，"));
	if (await yes("展开修改" + title + "？")) await fields(target, schema, values, keys);
	else for (const key of keys) target[key] ??= values[key];
}

async function main() {
	if (process.argv.length === 3 && process.argv[2] === "--non-interactive") {
		const { main: check } = await import("../dist/scripts/check-config.js");
		process.exitCode = await check(["--models"], directory);
		return;
	}
	if (process.argv.length > 2) throw new Error();
	category = "interactive_terminal_required";
	if (!process.stdin.isTTY) throw new Error();
	const output = new Writable({
		write(chunk, _encoding, done) {
			if (!hidden) process.stdout.write(chunk);
			done();
		},
	});
	rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
	rl.on("SIGINT", () => cancelled.abort());
	rl.on("close", () => cancelled.abort());
	category = "invalid_configuration";
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const config = existsSync(configPath) ? loadConfigSource(configPath) : {};
	const env = parseEnvFile(join(directory, ".env")),
		needed = {};
	const secret = async (key, label) => {
		if (needed[key]) return;
		needed[key] = await ask(
			label,
			env[key] ?? process.env[key] ?? "",
			{ type: "string", minLength: 1, pattern: "^[^\\r\\n]+$" },
			true,
		);
	};
	step(1, "Telegram 群和管理员");
	config.group_peer_id = await ask("群 ID（正数、负数和 -100 前缀均可）", String(config.group_peer_id ?? ""), {
		type: "string",
		pattern: "^-?[1-9][0-9]*$",
	});
	config.telegram_admins = await ask(
		"管理员 Telegram 数字 ID（逗号分隔；- 禁用管理命令）",
		config.telegram_admins ?? [],
		properties.telegram_admins,
	);

	step(2, "Pi 模型和认证");
	category = "model_runtime_unavailable";
	const runtime = await createInstalledPiModelRuntime({ cwd: directory });
	const pi = loadPiModelDefaults(directory);
	const modelsPath = join(getAgentDir(), "models.json");
	const custom = existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")) : { providers: {} };
	const configuredProviders = new Set();
	async function authenticate(id, provider) {
		if (configuredProviders.has(id)) return;
		const methods = [];
		if (provider.auth.apiKey?.login) methods.push("API key");
		if (provider.auth.oauth) methods.push("OAuth 登录");
		const actions = runtime.hasConfiguredAuth(id)
			? ["保留现有认证", ...(methods.length ? ["删除现有认证并重新登录"] : [])]
			: [];
		actions.push(...methods);
		let action = await choose("认证（登录成功立即保存到 Pi；与应用配置分别保存）", actions);
		if (action === "删除现有认证并重新登录") {
			await runtime.logout(id);
			action = await choose("重新登录", methods);
		}
		if (action !== "保留现有认证") {
			category = "provider_login_failed";
			await runtime.login(id, action === "API key" ? "api_key" : "oauth", {
				signal: cancelled.signal,
				prompt: async (prompt) =>
					prompt.type === "select"
						? ask(
								prompt.message + "（" + prompt.options.map((item) => item.id + ": " + item.label).join(" / ") + "）",
								prompt.options[0]?.id,
								{ enum: prompt.options.map((item) => item.id) },
								false,
								prompt.signal,
							)
						: ask(prompt.message, "", { type: "string", minLength: 1 }, true, prompt.signal),
				notify: (event) => {
					if (event.type === "auth_url") print("Pi 登录：" + event.url + "\n" + (event.instructions ?? ""));
					else if (event.type === "device_code")
						print("Pi 登录：" + event.verificationUri + "\n设备码：" + event.userCode);
					else if (event.type === "info") {
						print(event.message);
						for (const link of event.links ?? []) print(link.url);
					} else print("正在等待 Pi 认证… ETA：等待服务商响应");
				},
			});
		}
		configuredProviders.add(id);
	}
	async function model(selection, fallback) {
		print(
			"可用服务商：" +
				runtime
					.getProviders()
					.map((provider) => provider.id)
					.join(", "),
		);
		selection.provider = await ask(
			"服务商 ID（可输入新自定义服务商）",
			selection.provider ?? fallback.provider ?? "openai",
			{ type: "string", pattern: "^[A-Za-z0-9_-]+$" },
		);
		const id = selection.provider;
		let provider = runtime.getProvider(id);
		if (!provider || (await yes("修改此服务商的 base URL / 自定义模型？"))) {
			const current = custom.providers?.[id] ?? {};
			const baseUrl = await ask("base URL（完整 http(s) 地址，不含凭据或 query）", current.baseUrl ?? "", {
				type: "string",
				pattern: "^https?://",
			});
			const url = new URL(baseUrl);
			if (url.username || url.password || url.search || url.hash) {
				category = "invalid_provider_endpoint";
				throw new Error();
			}
			const api = await choose(
				"API 协议",
				[...new Set(runtime.getModels().map((entry) => entry.api))],
				current.api ?? "openai-completions",
			);
			const models = [...(current.models ?? [])];
			do {
				const modelId = await ask("自定义模型 ID", selection.model ?? fallback.model ?? "", {
					type: "string",
					minLength: 1,
				});
				const previous = models.find((entry) => entry.id === modelId) ?? {};
				const definition = { ...previous, id: modelId, name: modelId };
				definition.contextWindow = await ask("模型上下文上限（token）", previous.contextWindow ?? 65536, {
					type: "integer",
					minimum: 32768,
				});
				definition.maxTokens = await ask("模型最大输出（token）", previous.maxTokens ?? 16384, {
					type: "integer",
					minimum: 1,
					maximum: definition.contextWindow,
				});
				definition.reasoning = await yes("模型支持思考？", previous.reasoning ?? false);
				definition.input = (await yes("模型支持图片输入？", previous.input?.includes("image") ?? true))
					? ["text", "image"]
					: ["text"];
				definition.cost = previous.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				await advanced(
					"每百万 token 价格（美元；未知可填 0）",
					definition.cost,
					Object.fromEntries(
						["input", "output", "cacheRead", "cacheWrite"].map((key) => [key, { type: "number", minimum: 0 }]),
					),
					{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				);
				const index = models.findIndex((entry) => entry.id === modelId);
				if (index < 0) models.push(definition);
				else models[index] = definition;
				selection.model = modelId;
			} while (await yes("再添加一个模型？"));
			custom.providers ??= {};
			custom.providers[id] = { ...current, api, baseUrl, authHeader: true, models };
			runtime.registerProvider(id, custom.providers[id]);
			files.set(modelsPath, JSON.stringify(custom, null, "\t") + "\n");
			provider = runtime.getProvider(id);
		}
		await authenticate(id, provider);
		const catalog = runtime.getModels(id);
		selection.model = await choose(
			"模型 ID",
			catalog.map((entry) => entry.id),
			selection.model ?? (id === fallback.provider ? fallback.model : undefined) ?? catalog[0]?.id,
		);
		selection.reasoning_effort = await choose(
			"思考强度",
			getSupportedThinkingLevels(runtime.getModel(id, selection.model)),
			selection.reasoning_effort ?? "off",
		);
	}
	await model(config, pi);

	step(3, "机器人、角色和工具");
	category = "invalid_bot_configuration";
	config.name = await ask("群内显示名称 / 触发词", config.name ?? "bot", properties.name);
	config.token_env = await ask("Bot token 的 .env 键名", config.token_env ?? "telegram_bot_token", {
		type: "string",
		pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
	});
	await secret(config.token_env, "BotFather 提供的 bot token");
	const persona = await choose("角色来源", [
		...(config.persona_path ? ["保留"] : []),
		"中文模板",
		"English template",
		"已有文件",
		"输入文字",
	]);
	if (persona === "已有文件")
		config.persona_path = await ask(
			"角色文件路径（相对配置目录或绝对路径）",
			config.persona_path ?? "",
			properties.persona_path,
		);
	else if (persona !== "保留") {
		const text =
			persona === "输入文字"
				? ((await ask("角色文字（用 \\n 换行）", "", { type: "string", minLength: 1 })) + "\n").replaceAll(
						"\\n",
						"\n",
					)
				: readFileSync(
						new URL("../personas/template." + (persona === "中文模板" ? "zh" : "en") + ".md", import.meta.url),
						"utf8",
					);
		config.persona_path = "personas/bot.md";
		files.set(absolute(config.persona_path), text);
	}
	config.tools ??= {};
	await fields(config.tools, properties.tools.properties, {
		send: true,
		search: false,
		semantic: false,
		codemode: false,
		sandbox: false,
		tasks: false,
	});
	if (config.tools.tasks) config.tools.sandbox = true;
	if (config.tools.semantic) config.tools.codemode = true;
	await fields(config, properties, { sticker_sets: [] });
	if (config.tools.search) await secret("tiny_fish_api_key", "TinyFish API key");
	if (config.tools.semantic) await secret("gemini_api_key", "Gemini API key");
	print("没被点名的消息：配置接话判断模型时由它决定是否接话，否则每条都接。");
	if (await yes("使用接话判断模型（Gemini Decisions 或 Pi classifier）？", Boolean(config.decider))) {
		const decider = config.decider ?? { model: `${GEMINI_DECIDER_PROVIDER}/gemini-decision-1` };
		decider.model = await ask("判断模型（provider/model）", decider.model, properties.decider.properties.model);
		const providerId = decider.model.slice(0, decider.model.indexOf("/"));
		if (providerId === GEMINI_DECIDER_PROVIDER) await secret("gemini_api_key", "Gemini API key");
		else await authenticate(providerId, runtime.getProvider(providerId));
		decider.threshold = await ask(
			"接话阈值（0–1，越高越安静）",
			decider.threshold ?? DEFAULT_DECIDER_THRESHOLD,
			properties.decider.properties.threshold,
		);
		config.decider = decider;
	} else delete config.decider;

	step(4, "图片和视频");
	config.media ??= {};
	config.media.mode = await choose("媒体模式", ["off", "hybrid"], config.media.mode ?? "off");
	if (config.media.mode === "hybrid") {
		print("hybrid 模式由聊天模型为每个新媒体写一次文字描述，聊天模型需要支持图片输入。");
		await advanced("媒体参数", config.media, properties.media.properties, { max_per_turn: 2, concurrency: 2 });
	} else config.media = { mode: "off" };

	step(5, "工作沙箱和后台任务");
	if (config.tools.sandbox) {
		config.sandbox ??= {};
		await advanced("沙箱参数", config.sandbox, properties.sandbox.properties, {
			image: "tg-box:4",
			docker_host: "unix:///run/tgbox/docker.sock",
			memory: "1g",
			cpus: 2,
			pids: 256,
			network: true,
		});
	} else delete config.sandbox;
	if (config.tools.tasks) {
		config.tasks ??= { workflows: {} };
		const names = await ask("工作流名称（逗号分隔）", Object.keys(config.tasks.workflows), {
			type: "array",
			minItems: 1,
			uniqueItems: true,
			items: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" },
		});
		const workflows = {};
		for (const name of names) {
			const create = await yes("为 " + name + " 输入 AGENTS.md 指令？", !config.tasks.workflows[name]);
			workflows[name] = create
				? "tasks/" + name
				: await ask(name + " 工作流目录（包含 AGENTS.md）", config.tasks.workflows[name] ?? "", {
						type: "string",
						minLength: 1,
					});
			if (create)
				files.set(
					join(absolute(workflows[name]), "AGENTS.md"),
					((await ask("任务指令（用 \\n 换行）", "", { type: "string", minLength: 1 })) + "\n").replaceAll("\\n", "\n"),
				);
		}
		config.tasks.workflows = workflows;
		await advanced("任务参数", config.tasks, properties.tasks.properties, { max_running: 2, timeout_minutes: 45 });
	} else delete config.tasks;

	step(6, "高级参数");
	print(
		"Pi 压缩固定预留 " + MIN_COMPACTION_RESERVE + " token；compaction_threshold 不得超过 context_window 减去该预留。",
	);
	defaults.compaction_threshold = Math.floor((config.context_window ?? defaults.context_window) / 2);
	await advanced(
		"全局参数",
		config,
		properties,
		defaults,
		Object.keys(defaults).filter((key) => key !== "reasoning_effort"),
	);

	step(7, "审阅和保存");
	category = "invalid_configuration";
	print("最终配置（密钥不显示）：\nexport default " + render(config) + ";");
	print("凭据：" + Object.keys(needed).join(", ") + "（均隐藏）；Pi 认证：" + [...configuredProviders].join(", "));
	if (!(await yes("确认验证并保存？", true))) {
		category = "cancelled";
		throw new Error();
	}
	print("正在配置… [7/7] 验证配置与本地 Pi 模型 ETA：约 5 秒");
	Object.assign(process.env, needed);
	const validation = mkdtempSync(join(directory, ".configure-"));
	try {
		const candidate = structuredClone(config);
		if (files.has(absolute(candidate.persona_path))) {
			const path = join(validation, "persona.md");
			atomic(path, files.get(absolute(candidate.persona_path)));
			candidate.persona_path = path;
		}
		for (const [name, path] of Object.entries(candidate.tasks?.workflows ?? {})) {
			const content = files.get(join(absolute(path), "AGENTS.md"));
			if (content !== undefined) {
				candidate.tasks.workflows[name] = join(validation, name);
				atomic(join(validation, name, "AGENTS.md"), content);
			}
		}
		const path = join(validation, "telegram.config.ts");
		atomic(path, "export default " + render(candidate) + ";\n");
		const resolved = loadConfig(directory, { configPath: path });
		const { bot } = resolved;
		assertBotModelConfigured({ ...bot, thinkingLevel: bot.reasoningEffort }, runtime);
		const selected = runtime.getModel(bot.provider, bot.model);
		if (selected.contextWindow <= MIN_COMPACTION_RESERVE) {
			category = "context_window_too_small";
			throw new Error();
		}
		if (resolved.media.mode === "hybrid" && !selected.input.includes("image")) {
			category = "image_input_unsupported";
			throw new Error();
		}
		if (bot.decider) {
			category = "decider_unavailable";
			createDecider(runtime, bot.decider, bot.name, resolved.geminiApiKey);
		}
		category = "configuration_write_failed";
		for (const [target, content] of files) atomic(target, content);
		atomic(
			join(directory, ".env"),
			Object.entries({ ...env, ...needed })
				.map(([key, value]) => key + ": " + value + "\n")
				.join(""),
		);
		atomic(configPath, "export default " + render(config) + ";\n");
	} finally {
		rmSync(validation, { recursive: true, force: true });
	}
	print("正在配置… [7/7] 已保存并通过本地验证 ETA：0 秒");
}

try {
	await main();
} catch (error) {
	if (cancelled.signal.aborted) category = "cancelled";
	else if (
		["unknown_model", "unauthenticated_provider", "unsupported_reasoning_effort", "image_input_unsupported"].includes(
			error?.category,
		)
	)
		category = error.category;
	process.stderr.write(
		"配置失败 [" + category + "]（步骤 " + stage + "/7）。请修正该步骤后重新运行安装命令；凭据内容不会写入诊断。\n",
	);
	process.exitCode = 1;
} finally {
	rl?.close();
}
