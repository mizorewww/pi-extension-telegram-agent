# 日常运维

## 规范命令

```bash
bun run start
bun run status
bun run restart
bun run stop
```

- `start`：后台启动并等待pid/socket readiness；配置错误会在任何 bot polling 前失败。
- `restart`：串行停止同 deployment 的pid owner与孤儿进程，等PID、pid file与socket释放后只启动一次替代进程。
- `status`：验证PID确实属于当前仓库daemon，不只相信pid file。
- `stop`：SIGTERM优雅停止所有bot、agent与IPC资源。

日志位于 `data/daemon.log`。controller只回显有界、credential-redacted末尾；不要把完整 `.env` 或未经检查的日志贴进 issue。

## 配置变更

配置不热重载。编辑 `telegram.config.ts`、`.env` 或 persona 后运行：

```bash
bun run restart
```

已有配置也可在 Pi 运行 `/tg config` 进行验证或受保护编辑。replace 会留下本机 `.bak-<nonce>`；确认新 deployment ready 后再按你的备份策略处理，不要在同一任务顺手删除。

## 数据与备份

默认持久资源在 `data/` 与项目本机 session 目录。SQLite 是 canonical history；Telegram 不是历史恢复来源。

备份前：

1. `bun run stop`；
2. 确认 `bun run status` 不再报告 running；
3. 复制整个 deployment 的配置、persona、data 与 session 资源到访问受控的位置；
4. 保护 `.env` 和 private persona，不上传公共 artifact。

不要只复制DB后在同一目录并行启动两份daemon。

## Telegram 群内控制

公开只读命令：`/help`、`/status`。

`/status` 只展示实际接收命令的bot；用`/status@bot_username`可明确指定。富消息展示 runtime 状态、provider/model/effective reasoning、当前 context/window/%、按1,024 tokens一个红/紫/棕/蓝/绿方块表示的system/tool/摘要/messages/free分段、平均tok/s/send/think耗时、最近主对话请求、SQLite 保留期累计、缓存命中率、延迟/费用、路由与最近一次 compact。方块条单独一行，图例逐项显示在下面。当前context直接读取Pi session；compact后到下一次主请求前显示unknown，不会继续展示旧epoch数值。它与 Pi `/tg status` 共用[统一 telemetry 口径](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/telemetry.md)。若 Telegram 在创建消息前明确拒绝富消息方法或格式，daemon 会改发一次独立生成的纯文本版本；超时、限流和服务端错误等结果不确定时不会重发，以免重复回复。

`telegram_admins` allowlist 才能运行：

```text
/model
/compact
/new
/set <routing_p|cooldown_ms> <value>
```

在 Telegram 的 Bot 命令菜单选择 `/model`（多 Bot 群可用 `/model@bot_username`），按提供商和分页按钮浏览 Pi 当前已认证的全部可用模型，包括已安装的 provider 扩展。点选后保存该 Bot 的模型到 `telegram.config.ts`，立即建立新会话，旧会话文件保留；选择当前模型不会重置会话。Bot 忙碌时请稍后重试。Reasoning 尽量沿用当前档位，不支持时按 Pi 的模型能力调整，并在结果中显示；图片上下文模式拒绝不支持图片的模型。菜单本身不调用 LLM，切换模型后的首次对话会建立新缓存。

命令默认作用于接收消息的 bot，带 `@bot_username` 后缀时定向到对应 bot。这些命令由确定性 control plane 消费，不进入 persona/provider context。`compact` 会调用现有辅助摘要模型，可能产生费用；busy bot 不会被 abort。`new` 丢弃当前上下文、用当前模型开启新会话（旧会话文件保留在本机），bot 之后只看到新消息，适合上下文被带偏时重置；busy 时请稍后重试。`set` 写穿 `telegram.config.ts`，新值重启后仍然生效。

## 真实验证

默认 `bun test` 不调用 Telegram/provider；test preload 会机械拒绝一切非 loopback 网络访问。需要真实网络时，脚本强制选择bot：

```bash
bun run scripts/smoke-pi.ts --bot friend
bun run scripts/e2e-agent.ts --bot friend
bun run scripts/e2e-compaction.ts --bot friend
```

这些操作可能产生费用或群消息。运行前先读[daemon runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/daemon.md)，记录bot、预期副作用与回滚步骤。

## 为什么必须隔离工作目录

当前一个工作目录只支持一个群 deployment。这不是临时的UI限制：以下资源都由工作目录拥有，并没有deployment namespace：

- 单一`group_peer_id`和SQLite canonical history，包括每只bot的consumed cursor、visible refs与reply obligation；
- agent session与context epoch；
- 每只poller的Telegram update offset，以及共享router secret；
- daemon PID、control lock与Unix socket。

所以，在同一checkout中只换配置文件并行运行不会形成两个deployment。它可能把一个群的history送入另一个群的模型context、用错误offset跳过update，或让两个daemon争抢同一PID/socket。

第二个群应使用独立clone或worktree，并分别保存`.env`、config、persona和Telegram bot tokens；同时隔离整个`data`/DB、session、PID/lock/socket与daemon工作目录。不要只复制DB，也不要让两个目录指回同一data路径。

这种边界符合项目的极简原则：用文件系统隔离这个已有、可检查的安全边界，而不是为尚未要求的多租户场景增加namespace、热加载和第二套控制面。完整原则见[成本设计概览](design-cost.md)；技术权威见[项目说明](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/project.md)。

下一步：[故障排查](troubleshooting.md)。
