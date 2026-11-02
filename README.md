# Pi Telegram Agent

[中文](README.md) · [English](README.en.md) · [在线文档](https://mizorewww.github.io/pi-extension-telegram-agent/zh/)

基于 [Pi SDK](https://github.com/earendil-works/pi) 的自托管 Telegram 群聊 Agent 守护进程。

它不是一问一答的指令机器人，而是把 **一个或多个不同人设的 AI 群友** 长期放进同一个 Telegram 群里：平时看群聊、按概率接话或保持沉默；被点名时必定回应；需要时能翻历史记录、上网查资料、写脚本算数据、在独立 Linux 容器里处理文件并把生成的图表/文档发回群里。

---

## 核心特性

### 1. 像真群友一样的对话与路由
- **确定性触发，不白花 Token**：是否调用模型由本地代码决定。人类 `@bot`、回复 bot 或在消息里提到它的名字（`name`）时**必定回应**（持久化为回复义务，网络波动或重启后自动补回）；普通群消息按 `routing_p` 概率分配给至多一个空闲且不在冷却期的 bot。
- **允许沉默**：即使被概率抽中，模型若觉得没必要插嘴，不调 `send` 即可保持沉默，不会往群里发废话。
- **原生群聊表达**：通过唯一的公开输出通道 `send` 发送 Markdown 消息（自动转为经典 Telegram entities，兼容旧客户端）、贴纸（Sticker 目录或群友发过的贴纸）、Emoji Reaction，以及工作区产出的图片与文件。
- **可控的 Bot 互动（`/fire`）**：默认忽略其他 bot 的消息以防死循环；管理员开启 `/fire` 后，本群 bot 之间可按正常路由互相接话（每次人类发言后最多连续触发 3 次）。

### 2. 按需开启的分层工具集
每个 bot 可在配置中独立开关工具，未开启的工具不会出现在该 bot 的提示词中：

| 工具 / 模式 | 作用 | 开启方式 |
|---|---|---|
| `send` | 在群里发文字、发 sticker、点 reaction、发工作区文件（关掉即为纯观察 bot） | `tools.send`（默认 `true`） |
| `hybrid` 视觉 | 便宜的视觉模型将每张新图 / 贴纸 / 视频（FFmpeg 抽 1–3 帧）转成文字描述存入 SQLite 并跨 bot 共享；需要看细节时主模型按需调用 `view_image` 查看原图 | 顶层 `media.mode: "hybrid"` |
| `search` | 通过 TinyFish 联网搜索（最多 5 条摘要）或分页读取公开网页正文（自动拦截内网与回环地址） | `tools.search: true` + `.env` 配置 `tiny_fish_api_key` |
| `codemode` + `tg_messages` | 在 Pi 的 QuickJS（Wasm）沙箱中运行 JavaScript：精确计算、并行组合工具调用、用 `tg_messages`（SQLite FTS5 trigram 全文索引）检索本群完整历史消息。脚本内可先 `send` 一句“我去查一下”，干完活再发结果 | `tools.codemode: true` |
| `job` | 将几分钟的批量 `codemode` 脚本放到后台执行，不阻塞当前对话，跑完后自动唤醒 bot 回复发起人 | `tools.codemode` 与 `tools.send` 同开时自动注册 |
| `sandbox`（工作区） | 每 bot 一个隔离的 rootless Docker Linux 容器（Python / Node / FFmpeg / ImageMagick / Poppler / Git）：用 `tg_download` 拷入群附件、`sh_exec` 跑命令处理数据或画图，再通过 `send.files` 直接发回群里 | `tools.sandbox: true` + 顶层 `sandbox` 配置 |
| `tasks`（后台任务） | 启动一次性容器运行完整的 Pi 研究工作流（支持 `.pi` 下的 `pi-subagents` 与 skills），长耗时调研完成后唤醒 bot 汇报结论并附带产出文件 | `tools.tasks: true` + 顶层 `tasks` 配置 |

### 3. 围绕 Prompt Cache 设计的省钱架构
- **SQLite 为唯一事实来源**：所有群消息、编辑、引用快照、视觉描述都以不可变事件写入本地 SQLite（`data/agent.db`），重启不丢上下文。
- **严格前缀（Strict Prefix Invariant）**：System Prompt、人设、Sticker 目录与工具定义严格固定；新消息、编辑和媒体描述只作为新批次追加在末尾，**永不改写已发出的历史消息前缀**，最大化命中 Provider Prompt Cache。
- **双阈值自动压缩**：当上下文接近窗口上限或上下文图片字节超预算时，自动调用便宜的 `compaction_model` 将旧对话压缩为状态摘要（自动剥离模型内部 thinking 以防推测变“事实”）。

---

## 快速开始

### 1. 环境准备
- [Bun](https://bun.sh/)（运行 daemon 与测试）
- 本机安装 [Pi CLI](https://github.com/earendil-works/pi)（用于登录模型 Provider，凭据保存在 `~/.pi/agent/auth.json`）
- 一个 Telegram Supergroup，以及在 [@BotFather](https://t.me/BotFather) 创建并**关闭了 Group Privacy** 的 bot（已拉入群并有发言权限）
- （可选）主机安装 `ffmpeg`（用于视频抽帧理解）与 rootless Docker（用于 `sandbox` 工作区与 `tasks`，详见 [工作区运维手册](docs/runbooks/sandbox.md)）

### 2. 安装与登录模型

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
bun install --frozen-lockfile

# 打开 Pi 完成模型 Provider 登录与默认模型选择（完成后退出即可）
pi
# 在 Pi 内输入：/login  和  /model
```

### 3. 编写配置并启动

```bash
cp telegram.config.example.ts telegram.config.ts
cp personas/template.zh.md personas/friend.local.md
```

新建 `.env`（注意使用 `key: value` **冒号格式**）：

```yaml
telegram_bot_token: 123456789:AAH...
# 若开启 tools.search 则填：
# tiny_fish_api_key: tf-...
```

编辑 `telegram.config.ts`（最小可用示例，完整字段说明见 [`telegram.config.example.ts`](telegram.config.example.ts)）：

```ts
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  group_peer_id: 1234567890, // 你的 Telegram 群 ID（支持正数、负数或 -100 前缀）
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  media: { mode: "hybrid" }, // 开启图片/视频理解
  telegram_admins: [987654321], // 管理员的数字 Telegram user_id（可私聊 @userinfobot 获取）
  bots: [
    {
      id: "friend",
      name: "小雪", // 群里叫这个名字也会触发回应
      token_env: "telegram_bot_token",
      persona_path: "personas/friend.local.md",
      routing_p: 0.1, // 普通群消息 10% 概率接话
      tools: { send: true, search: false, codemode: true },
    },
  ],
});
```

前台启动测试：

```bash
bun run start
```

看到日志输出 `"event":"ready"` 后，去 Telegram 群里 `@你的bot` 或发送 `/status` 即可测试。长期运行建议使用 systemd 托管，详见 [Daemon 运维手册](docs/runbooks/daemon.md)。

---

## 群内控制命令

所有控制命令直接在 Telegram 群内发送（多 bot 时可用 `/command@bot_username` 定向）。命令与回复**永远不会进入模型的对话上下文**。

| 命令 | 权限 | 说明 |
|---|---|---|
| `/help` | 全员 | 查看命令列表与说明 |
| `/status` | 全员 | 查看该 bot 运行状态、上下文构成色块条、Token 用量、Cache 命中率、速度与累计费用 |
| `/fire status` | 全员 | 查看其他 bot 消息触发本 bot 的开关状态与剩余额度 |
| `/task` | 全员 | 查看该 bot 最近的后台任务状态与 Token 消耗 |
| `/model` | 管理员 | 弹出内联按钮菜单，从 Pi 已认证的全部模型中分页切换（自动写回 `telegram.config.ts` 并开新会话） |
| `/set` | 管理员 | 弹出内联按钮菜单，调整插话概率（`routing_p`）与冷却时间（`cooldown_ms`），立即生效并写回配置 |
| `/new` | 管理员 | 丢弃当前上下文并开启全新会话（当 bot 被误解带偏时使用） |
| `/compact` | 管理员 | 立即触发一次上下文摘要压缩 |
| `/fire [on\|off]` | 管理员 | 开启 / 关闭 / 切换其他 bot 消息对本 bot 的触发 |
| `/box reset` | 管理员 | 立即重置该 bot 的 Linux 工作区容器（平时每周一 05:00 自动清空） |
| `/task cancel tN` | 管理员 | 取消正在运行的后台任务 `tN` |

---

## 诊断与文档

当 bot 没反应或行为异常时，先在主机上运行只读诊断工具（不联网、不写库、不暴露密钥）：

```bash
bun run debug -- --since 30m
bun run debug -- --bot friend --since 2h
```

- **用户指南**（[中文在线版](https://mizorewww.github.io/pi-extension-telegram-agent/zh/) · [本地目录](docs/user-guide/zh/src/README.md)）：
  - [它能做什么](docs/user-guide/zh/src/features.md) · [安装与首次配置](docs/user-guide/zh/src/getting-started.md) · [配置与添加 bot](docs/user-guide/zh/src/configuration.md) · [日常运维与群内命令](docs/user-guide/zh/src/operations.md) · [故障排查](docs/user-guide/zh/src/troubleshooting.md) · [设计与哲学](docs/user-guide/zh/src/design.md)
- **主机运维（Runbooks）**：
  - [Daemon 与 systemd 托管](docs/runbooks/daemon.md) · [Bot 工作区与后台任务容器（Rootless Docker）](docs/runbooks/sandbox.md)
- **架构与工程文档**：
  - [文档总索引](docs/index.md) · [系统架构](docs/architecture.md) · [Cache 工程](docs/cache.md) · [数据模型](docs/data-model.md) · [开发指南（AGENTS.md）](AGENTS.md)

基于 BSD 2-Clause 协议开源，详见 [LICENSE](LICENSE)。
