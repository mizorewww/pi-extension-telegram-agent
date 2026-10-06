# 日常运维与群内命令

## 启动和停止

```bash
bun run start      # 后台启动
bun run status     # 查看是否在运行
bun run restart    # 修改配置后重启
bun run stop       # 停止
```

日志在 `data/daemon.log`（结构化 JSON，不含聊天正文）。长期运行建议用 systemd 托管，步骤见 [daemon runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/daemon.md)。

## 群内命令

在群里直接发送。命令默认作用于收到它的 bot；有多个 bot 时用 `/command@bot_username` 指定。这些命令由程序直接处理，不会进入 bot 的对话上下文，也不消耗模型调用（`/compact` 除外）。

所有人可用：

| 命令 | 作用 |
|---|---|
| `/help` | 命令说明 |
| `/status` | 这个 bot 的状态、上下文占比、用量与费用 |

只有 `telegram_admins` 里的人可用：

| 命令 | 作用 |
|---|---|
| `/model` | 用按钮从 Pi 已登录的全部模型中选择，保存到配置并立即换成新会话 |
| `/new` | 丢弃当前上下文、开启新会话；bot 之后只看到新消息。适合 bot 被某个误解带偏时使用 |
| `/compact` | 立即把上下文压缩成摘要（会调用摘要模型，产生少量费用） |
| `/set` | 弹出按钮菜单，点选插话概率（0–1）和主动插话后的冷却时间，立即生效 |

- `/model`、`/set` 会写回 `telegram.config.ts`，重启后仍然有效。
- bot 正在回复时，`/model`、`/new`、`/compact` 会提示稍后重试，不会打断回复。
- 换模型或 `/new` 后旧会话文件仍保留在本机。

## 备份

1. `bun run stop`，确认 `bun run status` 显示未运行；
2. 复制 `telegram.config.ts`、`.env`、`personas/*.local.md` 和整个 `data/`；
3. `.env` 和私有 persona 放在安全的位置。

SQLite（`data/agent.db`）是唯一的聊天历史来源，Telegram 不能用来恢复历史。

## 接入另一个群

一份部署只对应一个群。接入第二个群需要另一个独立的 clone，并使用各自的 `.env`、配置、persona、bot token 和 `data/`。不要在同一目录里切换配置文件后同时运行两份：它们会混用聊天历史、抢同一个进程锁。

下一步：[故障排查](troubleshooting.md)。
