# Pi Telegram Agent

[中文](README.md) · [English](README.en.md)

让几个各有性格的 AI bot 长期住进你的 Telegram 群：它们会按概率接话、发动态 sticker、看图和视频，像真实的群友。你在本机的 Pi 终端里观察和控制一切。

## 为什么用它

- **快**：daemon 常驻本机，消息进来直接路由，没有冷启动。
- **省**：provider prefix cache 让重复上下文不重复计费；路由、去重、状态全靠确定性代码，不花模型调用。
- **简单**：一套配置、一套结构。一个文件管所有设置，改完重启即生效。

## 快速开始

需要：[Bun](https://bun.sh/)、一个 Telegram supergroup、至少一个 [BotFather](https://t.me/BotFather) token（bot 已加入群并关闭 privacy mode，否则看不到普通群消息）。默认 vision 模式对主模型没有图片输入要求（可选的辅助视觉模型把媒体转成文字描述）；只有改用 `media.mode: "context"` 让主模型直接看图时，所选模型才必须支持图片输入（用 Pi `/model` 确认）。视频抽帧在两种模式下都需要主机安装 `ffmpeg`（同时提供 `ffprobe`）；不安装时视频只有文字占位，其余功能不受影响。

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
bun install
bun run pi
```

在打开的 Pi 里依次做两件事：

1. `/login` 登录模型 provider，`/model` 选默认模型（认证由 Pi 保管，不进本仓库）。
2. `/tg config` 启动配置向导，按提示填群 ID、token、persona。向导验证通过后 daemon 自动就绪。

完成。去群里 @ 你的 bot 或者说句话试试；发 `/help` 查看群命令。

> 注意：Pi 的输入框没有密码遮罩，粘贴 token 时请用私密终端，不要录屏。

## 日常使用

```bash
bun run start      # 后台启动
bun run pi         # 打开观察/控制界面
bun run status     # 查看状态
bun run restart    # 改配置后重启生效
bun run stop       # 停止
```

群里直接发 `/help`、`/status`；管理员（`telegram_admins`）还可以用 `/compact`、`/set` 调参——`/set` 会把新值直接写回配置文件。

## 配置

只有一个配置文件 `telegram.config.ts`，每个字段都带注释——复制 [telegram.config.example.ts](telegram.config.example.ts) 改几个值即可；secret（token、API key）放在 `.env` 里。加一只 bot 就是在 `bots` 数组里加一项，不用改代码。

详细配置见[配置指南](docs/user-guide/zh/src/configuration.md)。

## 需要帮助

- 常见问题与排障：[故障排查](docs/user-guide/zh/src/troubleshooting.md)
- daemon 运维（重启、日志、诊断）：[daemon runbook](docs/runbooks/daemon.md)（`bun run debug` 一键出诊断报告）
- 完整用户指南：[中文](docs/user-guide/zh/src/README.md) · [English](docs/user-guide/en/src/README.md)

## 参与开发

从 [AGENTS.md](AGENTS.md) 和[开发指南](docs/engineering/development-guide.md)开始；文档总索引在 [docs/index.md](docs/index.md)。项目采用 MIT 协议，见 [LICENSE](LICENSE)。
