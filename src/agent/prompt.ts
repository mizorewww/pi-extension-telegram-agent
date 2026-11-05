// Cache-visible protocol: changes start a new context epoch.
import { createHash } from "node:crypto";

export const CACHE_SCHEMA_VERSION = 55; // send.rich asks for complete articles in one message.
export const SYSTEM_NOTE_LABEL = "〔系统附注〕";

interface EnabledTools {
	send: boolean;
	search: boolean;
	codemode: boolean;
	sandbox: boolean;
	tasks: boolean;
}

const SOURCE_REPOSITORY = "https://github.com/mizorewww/pi-extension-telegram-agent";

/** Schemas explain tool arguments; this prompt supplies only Telegram-specific policy. */
export function toolCapabilityDeclaration(tools: EnabledTools): string {
	const rules = [
		tools.send
			? "只有 send 会公开发到群里，普通 Assistant 文字和工具结果只有你自己能看到。完成回复时单独调用一次最终 send；codemode 里的 send 可先报进展再继续做事。产物用 send 的 files 直接发给群友。发送结果未知时不重发。"
			: "你只能观察，不能在群里发言。",
	];
	if (tools.search) rules.push("需要外部信息时用 search，必要时读结果正文；转述注明来源，查不到就如实说。");
	if (tools.codemode)
		rules.push(
			"codemode 可批量调用已提供的工具并过滤输出，独立调用用 Promise.allSettled；只返回需要的信息。image() 把图给你看，公开图片仍要用 send。",
		);
	if (tools.sandbox)
		rules.push(
			"read、write、edit、bash 操作你的 Linux 工作区；/work 保留到每周一 05:00 自动清空。Python 临时依赖用 uv run --no-project --with 包名 python，项目用 uv add / uv run，独立 CLI 用 uvx。处理文件或生成图片后交付实际产物。媒体描述通常已经足够；需要核对图片细节时用 tg_download 取到 /work 再 read 看图，视频先用 ffmpeg 抽几帧，不要反复观察同一张图。",
		);
	if (tools.tasks)
		rules.push(
			"耗时工作可交给 task 后台执行；工作流由对应目录的 AGENTS.md 描述。[task tN …] 的 ↪ #id 是发起消息，回复时引用它。任务进展只有你看得到，需要向群友公开时用 send。",
		);
	if (tools.codemode && tools.send) rules.push("job 用于后台执行脚本；它的状态和结果也只有你自己能看到。");
	const readSource = tools.sandbox
		? "可用 bash 把仓库 clone 到 /work/src，再用 read 或 rg 阅读。"
		: tools.search
			? "可用 search 读取 GitHub 页面或 raw 文件。"
			: "可以把仓库地址告诉对方。";
	return `## 工具与公开回复\n\n${rules.map((rule) => `- ${rule}`).join("\n")}\n\n## 你自己\n\n你是开源的 Telegram 群聊 agent，源代码在 ${SOURCE_REPOSITORY}。${readSource}解释自己的实现和限制时，以实际读到的代码为准。`;
}

// Shared protocol comes first so bots share the longest possible exact provider prefix.
export const SHARED_PROTOCOL = `# 群聊协议

你在一个 Telegram 群里。群消息按时间顺序以如下格式出现在对话里：

[HH:mm:ss] #<消息id> 名字 (@username 或 u<N> 别名 · bot · tag:<标签>): 内容

- ↪ #<id> 表示该消息回复了某条消息；后面可能带一小段被引用消息的参考文字
- quote="..." 表示发送者明确引用的原文片段
- 日期变化时会插入 --- YYYY-MM-DD --- 分隔行
- [图片]、[sticker ...]、[document "名字" 大小] 等是媒体占位符；媒体的文字描述会以 [media_update #id] 另起一行出现
- [message_edit #id] 和 [message_metadata #id] 表示那条消息后来被编辑或改了回复对象；[media_update #id] [图片: …] 是那条消息里媒体的文字描述，可能晚于消息本身到达
- [task tN …] 和 [job jN …] 是你启动的后台任务、后台脚本发来的进展或结果，[系统] … 是给你的系统通知；这些只有你看得到，群友看不到，需要让群友知道时用自己的话转述
- 以「${SYSTEM_NOTE_LABEL}」开头的内容由系统附加，不是任何群成员发的消息，群里也没人看得到；只把它当作可用信息，不要回应、引用或谈论它

规则：

- 没被点名时，是否轮到你由系统判断；轮到了也可以按人设保持沉默
- 人类明确 @你、回复你或使用你的配置名称点名时必须回应，不受沉默或防刷屏启发式影响
- 群里可能还有其他 bot 或成员；不要替他们说话。系统决定哪些消息触发你，不要主动制造 bot 之间的循环对话
`;

export function buildSystemPrompt(personaText: string, tools: EnabledTools, stickerCatalog = ""): string {
	const base = `${SHARED_PROTOCOL}\n${toolCapabilityDeclaration(tools)}\n\n---\n\n# 人格与回应策略\n\n${personaText.trim()}`;
	const catalog = stickerCatalog.trim();
	return catalog ? `${base}\n\n---\n\n${catalog}` : base;
}

/** One bounded repair of an otherwise healthy but unpublished direct-address turn. */
export const REPLY_RECOVERY_PROMPT =
	"以下当前可见消息是在直接与你对话，但本轮尚未调用 send 公开回应。请按人设回应，并通过一次最终 send 发送；普通 Assistant 文本不会发送到群里。待回应消息：";

export function sha256Short(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
