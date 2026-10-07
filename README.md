# Pi Telegram Agent

[中文](README.md) · [English](README.en.md)

让几个各有性格的 AI bot 长期住进你的 Telegram 群：被 @ 时回应、偶尔主动接话、发 sticker、看图和视频，像真实的群友。你在本机的 Pi 终端里观察和控制一切。

- **快**：daemon 常驻本机，消息进来直接路由，没有冷启动。
- **省**：是否回应由确定性代码决定，不白花模型调用；prompt 前缀保持不变以复用 provider cache（实际折扣取决于 provider）。
- **简单**：一个配置文件；加一个 bot 就是在数组里加一项。

## 快速开始

需要：

- [Bun](https://bun.sh/) 和本机安装的 [Pi](https://github.com/earendil-works/pi)（`pi` 在 PATH 中）；
- 一个 Telegram supergroup，和至少一个 [BotFather](https://t.me/BotFather) bot：**关闭 group privacy** 并加入群；
- 可选：`ffmpeg`，让 bot 能看懂视频。

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
bun install --frozen-lockfile
bun run pi
```

在打开的 Pi 里：

1. `/login` 登录模型 provider，`/model` 选默认模型（凭据只保存在 Pi 里）；
2. `/tg config` 运行配置向导，填群 ID、token、persona。完成后 daemon 自动就绪。

去群里 @ 你的 bot 试试。

> Pi 的输入框没有密码遮罩，粘贴 token 时不要录屏或共享屏幕。

## 日常使用

```bash
bun run start      # 后台启动（长期运行建议用 systemd，见 runbook）
bun run pi         # 打开观察 / 控制界面（/tg attach）
bun run status     # 查看状态
bun run restart    # 改配置后重启生效
bun run stop       # 停止
bun run debug      # 只读诊断报告
```

群内命令：所有人可用 `/help`、`/status`、`/fire status`；`telegram_admins` 中的管理员还可用 `/model`（按钮换模型）、`/new`（开启新会话）、`/compact`（压缩上下文）、`/set`（调整插话概率与冷却）、`/fire on|off`（允许其他 bot 的消息触发本 bot，有连续次数上限）。

## 文档

- 用户指南：[中文](docs/user-guide/zh/src/README.md) · [English](docs/user-guide/en/src/README.md)
- [配置](docs/user-guide/zh/src/configuration.md) · [故障排查](docs/user-guide/zh/src/troubleshooting.md) · [daemon 运维](docs/runbooks/daemon.md)
- 参与开发：从 [AGENTS.md](AGENTS.md) 和 [docs/index.md](docs/index.md) 开始

BSD 2-Clause 协议，见 [LICENSE](LICENSE)。
