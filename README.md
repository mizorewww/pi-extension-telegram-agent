# Pi Telegram Agent

在 Linux 服务器上运行一键安装：

```bash
curl -fsSL https://github.com/mizorewww/pi-extension-telegram-agent/releases/latest/download/install.sh -o /tmp/pi-telegram-agent-install.sh && sudo bash /tmp/pi-telegram-agent-install.sh
```

脚本会下载正式发布包、校验 SHA256、安装独立的 Node.js 24、建立服务用户，并带你完成 Telegram、模型、人设与工具配置。每一步都会展示当前阶段、耗时和 ETA；交互阶段随你的输入推进。

```text
[1/7] 下载并校验程序与 Node 24 · 已用 8s · ETA 约 52s
[2/7] 配置独立账户与目录 · 用时 3s · 完成
[3/7] 安装版本文件 · 用时 1s · 完成
[4/7] 正在配置应用 · ETA 由输入进度决定
```

## 准备好这些信息

服务器环境为 **Linux x86_64、systemd 和 sudo 权限**。安装器使用 `curl`、`tar` 和 `xz`；工作区启用时，主机会使用 Docker CLI、 `dockerd-rootless.sh`、`rootlesskit`、`slirp4netns`、`newuidmap` 与 `newgidmap`。视频识别使用主机上的 FFmpeg。

配置向导会依次收集：

- **Telegram**：supergroup ID、管理员的数字 user ID、BotFather 创建的 bot token。把 bot 加入群组，为它开启群消息读取与发言权限。
- **模型**：Pi provider、模型、reasoning 档位，以及对应的 API key 或 OAuth 登录。已有 Pi 认证可直接用于配置。
- **Bot**：名称、人设、接话判断模型（可选，OpenRouter Decider）、冷却时间，以及发送、搜索、脚本和工作区工具。
- **媒体与任务**：hybrid 媒体描述、TinyFish key、研究工作流和任务并发。
- **运行参数**：上下文预算、请求超时、重试、保留期，以及容器资源配额。

每个配置步骤提供当前值与默认值。最终审阅会展示将要保存的设置，凭据采用隐藏输入与脱敏显示。

## 它在群里做什么

Pi Telegram Agent 把一个带有人设的 AI 成员放进 Telegram 群，一次部署对应一个 bot。群友通过 @、回复或名称邀请 bot 回应；其余消息（包括其他 bot 的发言）交给一个小型判断模型决定要不要接话，它只读最近几行消息，不进入 bot 的上下文；没有配置判断模型时每条都接。

| 能力 | 使用方式 |
|---|---|
| 群聊表达 | 文字、贴纸、reaction，以及生成的图片和文件 |
| 看图与视频 | hybrid 由聊天模型为每个媒体缓存一次描述；需要细节时 bot 用 `tg_download` 取到工作区，再用 Pi 原生 `read` 看图 |
| 搜索与历史 | TinyFish 检索公开资料，`tg_messages` 查询群内归档 |
| 编程工作区 | Pi 原生 `read`、`write`、`edit`、`bash` 在隔离容器中处理文件与数据 |
| 后台研究 | `task` 运行工作流，`job` 执行脚本，结果回到发起对话 |

Pi 1.5.0 负责会话、持久化、队列、压缩、工具执行和任务恢复。Telegram 适配层负责群聊路由、媒体、公开发送与管理员操作。压缩和 hybrid 媒体描述都使用当前聊天模型。

## 使用与维护

安装成功后，在群里 @ 你的 bot 即可开始。管理员可通过群内菜单调整配置：

| 命令 | 作用 |
|---|---|
| `/help`、`/status` | 查看用法、当前状态与 Pi 累计用量 |
| `/model` | 选择已认证的模型并立即切换 |
| `/new`、`/compact` | 开启新会话、压缩当前上下文 |
| `/task` | 查看和管理后台任务 |
| `/box reset` | 清空工作区 |

服务器上的操作入口：

```bash
sudo telegram-agent status
sudo telegram-agent configure
sudo telegram-agent restart
sudo telegram-agent logs
sudo telegram-agent debug --since 30m
```

再次执行安装命令即可升级。已有配置会进入向导供你审阅；自动化部署可使用 `sudo bash /tmp/pi-telegram-agent-install.sh v1.1.0 --non-interactive`，由预检验证现有配置。

| 内容 | 位置与所有者 |
|---|---|
| 发布程序与独立 Node | `/opt/pi-telegram-agent`，由 root 管理 |
| 配置、人设、工作流与 `.env` | `/etc/pi-telegram-agent`，由服务用户管理 |
| 数据库、媒体、日志与 Pi 认证 | `/var/lib/pi-telegram-agent`，由服务用户管理 |
| daemon | `pi-telegram-agent` 用户、系统级 `telegram-agent.service` |
| 工作区容器 | 独立 `tgbox` 用户的 rootless Docker |

备份时先运行 `sudo telegram-agent stop`，保存 `/etc/pi-telegram-agent` 与 `/var/lib/pi-telegram-agent`，再运行 `sudo telegram-agent start`。完整发布记录见 [CHANGELOG](CHANGELOG.md)。

## 开发与支持

开发环境使用 Node.js 24 和 npm：

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
npm ci
npm test
npm run check
npm run lint
```

测试覆盖 cache 协议、网络边界、沙箱、搜索和管理员权限。发布流程在 Linux x64 上校验 worker、Wasm、SQLite 与 Pi 执行环境，然后生成安装包和校验文件。

欢迎提交 [Issue](https://github.com/mizorewww/pi-extension-telegram-agent/issues) 和 Pull Request。问题报告可附版本、复现步骤与脱敏后的 `telegram-agent debug` 输出。项目采用 [BSD 2-Clause License](LICENSE)。
