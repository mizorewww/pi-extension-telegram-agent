# Pi Telegram Agent

[中文](README.md) · [English](README.en.md) · [在线文档](https://mizorewww.github.io/pi-extension-telegram-agent/zh/)

基于 [Pi Durable 1.5.0](https://github.com/earendil-works/pi) 的自托管 Telegram 群聊 agent。一个或多个不同人设的 bot 长期住在同一个群里：被点名时回应，平时按概率接话，需要时查资料、翻历史、处理文件并交付结果。

本项目只维护 Telegram 封装。Pi 管理会话、持久化队列、压缩、重试、工具执行、后台任务和累计用量；模型目录与认证继续使用 Pi 已安装的 provider。Pi Durable 是实验性接口，各包精确锁定 1.5.0。

## 能做什么

| 能力 | 配置 | 行为 |
|---|---|---|
| 群内发言 | `tools.send`，默认开启 | 唯一公开通道，发送文字、sticker、reaction、图片和文件；关闭后只观察 |
| 图片与视频 | `media.mode: "hybrid"` | 同一媒体描述一次并跨 bot 共享；`view_image` 按需把原图或视频帧作为 Pi 原生图片交给模型 |
| 搜索 | `tools.search` + TinyFish key | 搜索或分页读取公开网页，拒绝内网与回环地址 |
| 脚本与历史检索 | `tools.codemode` | Pi QuickJS 中组合工具、计算、筛选结果；`tg_messages` 查询本群归档 |
| Linux 工作区 | `tools.sandbox` + `sandbox` | 原生 read/write/edit/bash 经 pi-env 在 rootless Docker 里执行；`tg_download` 拷入附件，send 交付产物 |
| 后台研究 | `tools.tasks` + `tasks` | 工作流目录的 `AGENTS.md` 指导 Pi child conversation，共享隔离工作区和宿主认证 |
| 后台脚本 | codemode 与 send 同开 | `job` 运行 Pi 原生工具任务，不额外调用模型 |

@、回复和配置名称由确定性代码路由；普通消息按概率交给至多一个 bot，忙碌时跳过。直接点名的待答内容持久化，健康结束却没回应时最多补答一次。默认忽略 bot 触发，管理员可用 `/fire` 开启有次数限制的互动。

只有 send 会发到群里。文字转换为转义 HTML，使用经典 Telegram 消息；结果未知的发送不自动重发。后台任务在重启后按 Pi 的工具恢复规则继续，已经开始但结果未知的 unsafe 操作不会盲目重做。

## 上下文与成本

群消息归档在 `data/agent.db`，每个 bot 的 Pi 会话、任务和用量在 `data/pi/<bot>.sqlite`。同一上下文片段内只追加输入，保留已有前缀；压缩、换模型和 `/new` 建立新前缀。

压缩使用当前聊天模型和 reasoning effort，固定预留 16,384 token。有效规划窗口取模型目录、`context_window`、`compaction_threshold + 16,384` 的最小值；摘要输出最多 13,107 token，并受模型输出上限约束。Pi 1.5.0 不会自动分块超大的摘要输入，也不能精确估算加密 thinking 签名成本。

hybrid 平时使用缓存描述，只有需要细节才看原图；图片字节由 Pi 持久化。`/status` 展示 Pi 原生累计账本，包含 child 与历史，`/new` 不清零；费用以 provider 账单为准。

## 快速开始

需要 Node.js 24+、已安装的 Pi CLI，以及在 BotFather 创建、关闭 group privacy 并加入目标 supergroup 的 bot。视频理解需要主机 FFmpeg；工作区需要 Linux rootless Docker 和 `tg-box:4`，见[工作区运维](docs/runbooks/sandbox.md)。

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
npm ci
npm run build
pi
# 在 Pi 中用 /login 登录，用 /model 选择默认模型，然后退出。
cp telegram.config.example.ts telegram.config.ts
cp personas/template.zh.md personas/friend.local.md
```

新建 `.env`，使用冒号格式：

```text
telegram_bot_token: 123456:REPLACE_WITH_BOTFATHER_TOKEN
```

编辑 `telegram.config.ts`，填群 ID、bot 名称和 persona 路径。省略 provider/model 可沿用 Pi 的默认选择。最小示例：

```ts
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  group_peer_id: 1234567890,
  telegram_admins: [987654321],
  bots: [{
    id: "friend",
    name: "小雪",
    token_env: "telegram_bot_token",
    persona_path: "personas/friend.local.md",
    routing_p: 0.1,
  }],
});
```

`npm start` 前台启动；看到 `ready` 后在群里 @ bot 或使用 `/status`。长期运行交给 systemd，更新后先执行 `npm ci && npm run build` 再重启。同一 token 不要在开发机和服务器上同时轮询。

## 群内控制

| 命令 | 权限 | 作用 |
|---|---|---|
| `/help`、`/status` | 所有人 | 帮助、当前状态、上下文估算与 Pi 累计用量 |
| `/fire status`、`/task` | 所有人 | bot 互动额度、后台任务状态 |
| `/model`、`/set` | 管理员 | 按钮选择模型或路由参数，立即应用并原子写回 `telegram.config.ts` |
| `/new` | 管理员 | 等待旧回复和后台工作停止后重置会话及工作区 |
| `/compact` | 管理员 | 使用当前聊天模型执行原生压缩，会产生费用 |
| `/fire [on\|off]` | 管理员 | 控制其他 bot 是否可以触发本 bot |
| `/box reset`、`/task cancel tN` | 管理员 | 清空工作区、取消后台任务 |

多 bot 时用 `/command@bot_username` 指定目标。控制消息和回复不进入模型上下文。完整配置见 [配置示例](telegram.config.example.ts)。

## 诊断与文档

```bash
npm run debug -- --bot friend --since 30m
```

诊断只读归档、路由事实和结构化日志；实时 Pi 状态用 `/status`。备份整个 `data/` 以及私有配置、persona 和 `.env`。从旧 AgentSession 版本升级时，旧 JSONL 不导入新 Harness，群消息归档继续保留；升级流程见运维文档。

- [用户指南](docs/user-guide/zh/src/README.md)：[安装](docs/user-guide/zh/src/getting-started.md) · [配置](docs/user-guide/zh/src/configuration.md) · [操作](docs/user-guide/zh/src/operations.md) · [排障](docs/user-guide/zh/src/troubleshooting.md) · [设计](docs/user-guide/zh/src/design.md)
- [Daemon 与 systemd](docs/runbooks/daemon.md) · [Rootless 工作区](docs/runbooks/sandbox.md)
- [文档索引](docs/index.md) · [架构](docs/architecture.md) · [Cache](docs/cache.md) · [用量](docs/telemetry.md) · [开发约束](AGENTS.md)

BSD 2-Clause，见 [LICENSE](LICENSE)。
