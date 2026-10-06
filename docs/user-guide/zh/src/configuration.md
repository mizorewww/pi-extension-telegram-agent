# 配置与添加 bot

所有设置都在项目根的 `telegram.config.ts`；仓库里的 [`telegram.config.example.ts`](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/telegram.config.example.ts) 列出了全部字段和注释。改完执行 `bun run restart`（或 Pi 里 `/tg restart`）生效。

## 文件

| 文件 | 内容 | 提交到 Git |
|---|---|---|
| `telegram.config.ts` | 群、bot、模型、路由、工具、上限 | 否 |
| `.env` | bot token、TinyFish key 等 secret | 否 |
| `personas/*.local.md` | 你的 bot 人格 | 否 |
| `telegram.config.example.ts`、`personas/template.*.md` | 公开示例 | 是 |

`.env` 用冒号格式（不是 `KEY=value`）：

```text
telegram_bot_token: 123456:REPLACE_WITH_BOTFATHER_TOKEN
```

## 最小配置

```ts
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  group_peer_id: 1234567890,
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  bots: [{
    id: "friend",
    name: "Mochi",
    token_env: "telegram_bot_token",
    persona_path: "personas/friend.local.md",
    routing_p: 0.1,
  }],
});
```

没写的字段都用默认值。配置错误时启动会一次列出所有问题。

## 添加 bot

1. 在 `.env` 加一行新 token，例如 `helper_bot_token: ...`；
2. 从 `personas/template.zh.md` 复制一份新的 persona；
3. 在 `bots` 数组里追加一项（`id` 唯一，只含字母、数字、`_`、`-`）；
4. 重启，在 Pi 里用 `/tg attach <id>` 确认。

每个 bot 有独立的 token、人格、会话和统计；它们共享同一个群的聊天记录，看得到彼此的发言，但不会互相触发。

## 什么时候回应

- **必定回应**：有人 @ 它、回复它的消息，或在消息里提到它的 `name`。
- **概率插话**：普通消息按 `routing_p` 的概率交给某个 bot（所有 bot 的 `routing_p` 加起来不能超过 1）。被选中的 bot 正忙或在冷却期（`sampling_cooldown_ms`，默认 2000）就跳过，不会转给别的 bot；即使被选中，bot 也可以按人格选择不说话。
- `routing_p: 0` 只关闭概率插话，点名仍然有效。
- bot 发的消息不会触发其它 bot。

## 模型

- `provider` / `model` 可以写在顶层（所有 bot 共用），也可以在单个 bot 里覆盖；换 provider 时必须同时写 `model`。省略时继承 Pi `/model` 的默认值。
- `reasoning_effort` 默认 `off`，必须是该模型真正支持的档位（在 Pi `/model` 里能看到），否则启动会报错。
- `compaction_model` 是生成上下文摘要用的便宜模型（`provider/model:effort`）；摘要失败时保留原上下文，不会改用主模型。
- 自建网关或代理：在 Pi 的 `~/.pi/agent/models.json` 里注册（`baseUrl`、`api: "openai-completions"`、`apiKey`、每个模型的 `input`、`contextWindow`、`maxTokens`），在 Pi `/model` 里确认后写进配置即可，不需要改本项目。
- 在群里可以用 `/model` 按钮直接换模型（管理员），见[群内命令](operations.md#群内命令)。

## 工具

```ts
tools: { send: true, search: false, run_js: false }
```

- `send`：在群里发言、发 sticker、点 reaction。关掉就是只看不说的观察 bot。
- `search`：联网搜索或读取一个公开网页（TinyFish），需要在 `.env` 加 `tiny_fish_api_key`。不会自动打开群里的每个链接，也不能访问内网地址。
- `run_js`：在沙箱里跑小段 JavaScript 做精确计算。沙箱仍有残余风险，默认关闭。

## 图片和视频

`media.mode` 决定 bot 怎么“看”媒体：

| 模式 | 方式 | 要求 |
|---|---|---|
| `"vision"`（默认） | 打开 `vision.enabled: true` 后，辅助视觉模型（`auxiliary_visual_model`）把每张图/视频描述成文字，结果所有 bot 共用 | 主模型无要求 |
| `"context"` | 图片和视频截帧直接交给主模型，不调用视觉模型；每次最多 `media.max_images_per_turn`（默认 4）张 | 主模型必须支持图片输入 |

语音、音频、普通文件、TGS 动画贴纸在两种模式下都只是文字占位。视频需要主机装有 FFmpeg。

## 上限与默认值

| 字段 | 默认 | 作用 |
|---|---|---|
| `context_window` | 65,536 | 主模型最多使用的上下文 |
| `compaction_threshold` | 32,768 | 上下文超过它就压缩成摘要（最多 `context_window − 16,384`） |
| `compaction_keep_recent` | 1 | 压缩后保留的最近原文 token 数；1 表示只留摘要和最后一轮，群聊建议 20,000 |
| `max_suffix_tokens` / `max_message_tokens` | 12,000 / 4,096 | 每轮新消息和单条消息的上限 |
| `context_image_budget_bytes` | 10,000,000 | 上下文里图片总字节超过它就额外压缩 |
| `provider_timeout_ms` / `provider_retries` | 300,000 / 2 | 单次请求超时与自动重试次数 |
| `cache_retention` | `"short"` | provider prompt cache 保留策略 |
| `telemetry_retention_days` 等 | 90 / 30 / 365 | 用量、原始 update、消息事件的保留天数 |
| `telegram_admins` | 空 | 能用群内管理命令的人（数字 user id 或 `@username`） |

这些值大部分也可以在单个 bot 里覆盖。

改了模型、人格、工具、媒体模式等影响模型输入的设置后，重启时 bot 会开启新的会话（旧会话文件保留），这是正常的。

下一步：[在 Pi 中聊天和观察](using-pi.md)。
