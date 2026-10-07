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
| `/fire status` | 其他 bot 的消息能否触发这个 bot，以及剩余次数 |

只有 `telegram_admins` 里的人可用：

| 命令 | 作用 |
|---|---|
| `/model` | 用按钮从 Pi 已登录的全部模型中选择，保存到配置并立即换成新会话 |
| `/new` | 丢弃当前上下文、开启新会话；bot 之后只看到新消息。适合 bot 被某个误解带偏时使用 |
| `/compact` | 立即把上下文压缩成摘要（会调用摘要模型，产生少量费用） |
| `/set` | 弹出按钮菜单，点选插话概率（0–1）和主动插话后的冷却时间，立即生效 |
| `/fire on` / `/fire off` | 允许 / 禁止其他 bot 的消息触发这个 bot；不带参数的 `/fire` 切换开关 |

- `/model`、`/set` 会写回 `telegram.config.ts`，重启后仍然有效。
- bot 正在回复时，`/model`、`/new`、`/compact` 会提示稍后重试，不会打断回复。
- 换模型或 `/new` 后旧会话文件仍保留在本机。

## 让其他 bot 触发 bot（`/fire`）

默认 bot 只对人类的消息作出反应。`/fire on` 让其他 bot 的消息也能触发它：

- **作用范围**：只作用于收到命令的 bot（或 `/fire@bot_username on` 指定的 bot），只在本群。其他 bot 不受影响。只有人类管理员能开关；bot 发出的命令一律忽略。
- **规则与人类相同**：bot 的消息按正常顺序路由（@ > 回复 > `name` > `routing_p`）。正常选中的 bot 没开 `/fire` 时什么都不发生，**不会**改投给别的 bot。bot 永远不会被自己的消息触发，bot 编辑消息也不会再次触发。这类触发不算待回复的点名，bot 可以选择不说话。
- **防循环额度**：群里每出现一条人类消息后，每个开了 `/fire` 的 bot 最多被 bot 连续触发 3 次。额度用完后忽略 bot 消息，直到有人发言或管理员再次发送 `/fire on`。因 bot 正忙或冷却而跳过的触发不消耗额度。`/fire status` 显示剩余次数。
- **不持久化**：设置只保存在内存里，重启后所有 bot 恢复关闭。
- **同一部署的 bot**：你的某个 bot 发言并保存成功后，daemon 会在本地把这条消息交给其他 bot 路由，所以一起配置的 bot 可以互相触发。命令回复（`/status`、`/fire` 等）和你在 Pi TUI 里手动发送的消息永远不会触发任何 bot。
- **部署之外的 bot**：只有 Telegram 真的把它们的消息投递过来才能触发。按 Telegram Bot FAQ，群里的 bot 收不到其他 bot 的消息，开启 `/fire` 不会改变这一点。

## 备份

1. `bun run stop`，确认 `bun run status` 显示未运行；
2. 复制 `telegram.config.ts`、`.env`、`personas/*.local.md` 和整个 `data/`；
3. `.env` 和私有 persona 放在安全的位置。

SQLite（`data/agent.db`）是唯一的聊天历史来源，Telegram 不能用来恢复历史。

## 接入另一个群

一份部署只对应一个群。接入第二个群需要另一个独立的 clone，并使用各自的 `.env`、配置、persona、bot token 和 `data/`。不要在同一目录里切换配置文件后同时运行两份：它们会混用聊天历史、抢同一个进程锁。

下一步：[故障排查](troubleshooting.md)。
