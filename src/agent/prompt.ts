// System prompt assembly. This is cache-visible protocol (docs/cache.md).
// Any change here => bump CACHE_SCHEMA_VERSION and start a new context epoch.

import { createHash } from "node:crypto";

export const CACHE_SCHEMA_VERSION = 18; // v18: compaction includes discarded split-turn prefixes and preserves active image refs

// Fixed shared protocol is deliberately the first byte of every bot's system prompt so bots in
// the same provider/cache cohort share the longest possible exact prefix.
export const TOOL_CAPABILITY_DECLARATION = `## 可用工具

你有三个工具：search（联网搜索，也可读取一个公开网页）、run_js（运行小型计算）、send（唯一的公开发言通道）。被问"能不能搜索/查资料/看网页"时如实说明；需要外部信息时直接用 search。`;

export const SHARED_PROTOCOL = `# 群聊协议

你在一个 Telegram 群里。群消息按时间顺序以如下格式出现在对话里：

[HH:mm:ss] #<消息id> 名字 (@username 或 u<N> 别名 · bot · tag:<标签>): 内容

- ↪ #<id> 表示该消息回复了某条消息；后面可能带一小段被引用消息的参考文字
- quote="..." 表示发送者明确引用的原文片段
- 日期变化时会插入 --- YYYY-MM-DD --- 分隔行
- [图片]、[sticker ...] 等是媒体占位符：占位符内可能直接带该媒体的文字描述，或占位符之后紧跟该媒体的实际图片（图片、静态 sticker、video 抽帧），两种情况你都能知道媒体内容

规则：

- 未被点名的概率插话可以按人设保持沉默
- 人类明确 @你、回复你或使用你的配置名称点名时必须回应，不受概率插话的沉默或防刷屏启发式影响
- 群里可能还有其他 bot 或成员；他们的消息你能看到，但不要替他们说话，也不要回复其他 bot 的消息

${TOOL_CAPABILITY_DECLARATION}
`;

export function buildSystemPrompt(personaText: string, stickerCatalog = ""): string {
	const base = `${SHARED_PROTOCOL}\n---\n\n# 人格与回应策略\n\n${personaText.trim()}`;
	const catalog = stickerCatalog.trim();
	return catalog ? `${base}\n\n---\n\n${catalog}` : base;
}

/**
 * Chat-oriented compaction summary prompt (state, not replay). Part of the cache-visible
 * protocol: the summary grammar lives at the boundary of a new epoch, so its prompt is
 * hashed by the golden test (REQ-TEST-0001 R2).
 */
export const COMPACTION_SUMMARY_PROMPT = `你在为一个长期住在 Telegram 群里的 AI 群友压缩记忆。把被压缩的群聊历史总结成"状态"而不是逐条复述，供它之后延续人设和上下文。

保留：
- 重要人物关系、称呼和互动模式
- 已知稳定事实和长期话题
- 正在讨论的问题、结论和争议点
- 承诺和未解决事项
- 必要的消息引用（#消息id）
- 这个人设真正会关心的信息

输出中文，分段，直接给摘要正文，控制在 800 字以内。`;

export function sha256Short(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
