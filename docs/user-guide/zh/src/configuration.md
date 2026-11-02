# 配置与添加 bot

所有设置都在项目根的 `telegram.config.ts`；仓库里的 [`telegram.config.example.ts`](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/telegram.config.example.ts) 列出了全部字段和注释。改完重启 daemon 生效（`systemctl --user restart telegram-agent`，或重新 `bun run start`）。

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
4. 重启，在群里用 `/status` 确认。

每个 bot 有独立的 token、人格、会话和统计；它们共享同一个群的聊天记录，看得到彼此的发言，但不会互相触发，除非管理员开启 `/fire`（见下文）。

## 什么时候回应

- **必定回应**：有人 @ 它、回复它的消息，或在消息里提到它的 `name`。
- **概率插话**：普通消息按 `routing_p` 的概率交给某个 bot（所有 bot 的 `routing_p` 加起来不能超过 1）。被选中的 bot 正忙或在冷却期（`cooldown_ms`，默认 2000）就跳过，不会转给别的 bot；即使被选中，bot 也可以按人格选择不说话。
- `routing_p: 0` 只关闭概率插话，点名仍然有效。
- bot 发的消息不会触发其它 bot，除非管理员为某个 bot 开启了 [`/fire`](operations.md)。

## 模型

- `provider` / `model` 可以写在顶层（所有 bot 共用），也可以在单个 bot 里覆盖；换 provider 时必须同时写 `model`。省略时继承 Pi `/model` 的默认值。
- `reasoning_effort` 默认 `off`，必须是该模型真正支持的档位（在 Pi `/model` 里能看到），否则启动会报错。
- `compaction_model` 是生成上下文摘要用的便宜模型（`provider/model:effort`）；摘要失败时保留原上下文，不会改用主模型。
- 自建网关或代理：在 Pi 的 `~/.pi/agent/models.json` 里注册（`baseUrl`、`api: "openai-completions"`、`apiKey`、每个模型的 `input`、`contextWindow`、`maxTokens`），在 Pi `/model` 里确认后写进配置即可，不需要改本项目。
- 在群里可以用 `/model` 按钮直接换模型（管理员），见[群内命令](operations.md#群内命令)。

## 工具

每个 bot 在 `tools` 里单独开关，默认只开 `send`：

```ts
tools: { send: true, search: false, codemode: false, sandbox: false, tasks: false }
```

| 开关 | 作用 | 前提 |
|---|---|---|
| `send` | 在群里发言、发 sticker、点 reaction；关掉就是只看不说的观察 bot | 无 |
| `search` | 联网搜索（最多 5 条摘要）或读一个公开网页，长网页分页读完；不能访问 localhost 和内网地址 | `.env` 里有 `tiny_fish_api_key` |
| `codemode` | 让 bot 写 JavaScript 脚本（Pi 原生 QuickJS 沙箱）：精确计算、在脚本里批量调用其他工具并筛选结果、检索本群全部历史消息。脚本没有网络和文件系统，可以在脚本里调用 `send` | 无 |
| `sandbox` | bot 自己的 Linux 工作区（Docker 容器）：在脚本里执行命令、拷入群友发的文件；`send` 可以把工作区里的图片（≤10 MB 的 jpg/png/webp）和文件（≤50 MB）直接发到群里 | `codemode: true`，顶层 `sandbox` 段，主机准备好 rootless Docker |
| `tasks` | 把耗时的深入搜索、调研交给后台任务，完成后回复发起人 | `sandbox: true`，顶层 `tasks` 段 |

看图工具 `view_image` 没有开关，`media.mode: "hybrid"` 时所有 bot 自动拥有（见下文）。

### 工作区（`sandbox`）

```ts
sandbox: { image: "tg-box:2", docker_host: "unix:///run/tgbox/docker.sock", memory: "1g", cpus: 2, pids: 256, network: true },
```

上面就是默认值，只写要改的字段即可，但 `sandbox` 段本身必须存在。每个开了 `sandbox` 的 bot 有一个常驻容器，以独立 Linux 用户的 rootless Docker 运行，不挂载主机目录、不带任何凭证。`network: false` 可以给工作区断网。

- 工作区里的文件一直保留到每周一 05:00（daemon 所在机器的本地时间）自动清空；清空后 bot 会收到通知。
- 管理员随时可以在群里 `/box reset`，bot 自己也能在工作区坏掉时清空。
- 主机准备（建 `tgbox` 用户、rootless Docker、构建镜像）见 [sandbox runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/sandbox.md)。目前只在 Linux 主机上验证过。

### 后台任务（`tasks`）

```ts
tasks: { workflows: { search: "~/pi-tasks/search" }, max_running: 2, timeout_minutes: 45, memory: "3g", cpus: 2 },
```

- `workflows` 是“名字 → 目录”，目录里必须有一个 `.pi`（Pi 的项目设置、扩展、提示词）。bot 开任务时选一个工作流；每个任务在一次性容器里用这份 `.pi` 运行 Pi，与工作区共用 `/work`，所以产出的文件 bot 可以直接发到群里。
- `max_running` 是每个 bot 同时运行的任务数，超过 `timeout_minutes` 的任务判为失败；`memory` / `cpus` 是每个任务容器的上限。
- 任务里的 Pi 需要自己的模型凭证，放在一个专用的 Docker 卷里，准备方法见 [sandbox runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/sandbox.md#任务凭证卷)。
- 群里的样子：bot 先回复“我去查了”；任务的进展、需要你补充的问题和结果会作为 `[task tN …]` 交给 bot，由 bot 转述并回复发起人。补充信息直接回复 bot 即可，它会转给任务。daemon 重启时进行中的任务会中断，bot 会告诉发起人。

## 图片和视频

`media.mode` 决定 bot 怎么“看”媒体：

| 模式 | 方式 | 要求 |
|---|---|---|
| `"off"`（默认） | 只显示 `[图片]` 这类文字占位 | 无 |
| `"hybrid"` | 视觉模型（`media.vision_model`）把每张新图片/视频描述成文字一次，所有 bot 共用；bot 觉得描述不够时用 `view_image` 打开某条消息的原图或视频帧，被回复或检索到的旧消息也能看 | 主模型支持图片输入 |

想让 bot 看懂图片就用 `hybrid`：平时只付文字描述的费用，真正需要细看时才把原图交给主模型。

`media.max_per_turn` 是每轮最多描述的新媒体数（默认 2），`media.concurrency` 是并行处理数（默认 2）。语音、音频、普通文件、TGS 动画贴纸在所有模式下都只是文字占位（开了 `sandbox` 的 bot 可以把文件拷进工作区处理）。视频需要主机装有 FFmpeg。

## 上限与默认值

| 字段 | 默认 | 作用 |
|---|---|---|
| `context_window` | 65,536 | 主模型最多使用的上下文 |
| `compaction_threshold` | `context_window` 的一半 | 上下文超过它就压缩成摘要（最多 `context_window − 16,384`） |
| `compaction_keep_recent` | 20,000 | 压缩后保留的最近原文 token 数（约 1–2 轮） |
| `max_suffix_tokens` / `max_message_tokens` | 12,000 / 4,096 | 每轮新消息和单条消息的上限 |
| `context_image_budget_bytes` | 10,000,000 | 上下文里图片总字节超过它就额外压缩 |
| `provider_timeout_ms` / `provider_retries` | 300,000 / 2 | 单次请求超时与自动重试次数 |
| `cache_retention` | `"short"` | provider prompt cache 保留策略 |
| `telemetry_retention_days` 等 | 90 / 30 / 365 | 用量、原始 update、消息事件的保留天数 |
| `telegram_admins` | 空 | 能用群内管理命令的人的数字 user id（不接受 username，因为 username 可以被改名或转让） |

这些值大部分也可以在单个 bot 里覆盖。写错或已废弃的字段会在启动时报错，并提示应该改成什么。

不知道自己的数字 user id？私聊 [@userinfobot](https://t.me/userinfobot) 即可查到。

改了模型、人格、工具、媒体模式等影响模型输入的设置后，重启时 bot 会开启新的会话（旧会话文件保留），这是正常的。

下一步：[日常运维与群内命令](operations.md)。
