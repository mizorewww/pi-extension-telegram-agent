# Runbook：daemon 运维

启动、停止、托管、观察与恢复 daemon 的操作步骤。配置项含义见用户指南的[配置章节](../user-guide/zh/src/configuration.md)。

## 命令

```bash
bun run start      # 后台启动，等待 socket 可连接才报告 ready（最多 60 秒）
bun run status     # 校验 pid 确实属于本仓库 daemon
bun run restart    # 停掉本 deployment 的全部 daemon（含孤儿），全部退出后再启动一个
bun run stop       # SIGTERM 优雅停止
bun run src/main.ts start --foreground   # 前台运行，调试用
```

Pi 中等价：`/tg start`、`/tg restart`（ready 后自动重连当前 feed）、`/tg stop`、`/tg status-daemon`。

- 配置不热重载，改 `telegram.config.ts`、`.env` 或 persona 后执行 `restart`。群内 `/set`、`/model`、`/new` 立即生效，无需重启。
- 并发 `restart` 由 `data/daemon.control.lock` 串行，第二个会报 `restart already in progress`。
- 启动超过 60 秒但进程仍存活时只报告 starting（例如首次拉取 sticker 目录），用 `status` 或日志确认。

## 生产托管（Linux systemd user unit）

`~/.config/systemd/user/telegram-agent.service`：

```ini
[Unit]
Description=Pi Telegram agent daemon
After=network-online.target
Wants=network-online.target
# 令牌被撤销等致命错误不要无限重启
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=/home/<user>/pi-extension-telegram-agent
# 每次（重）启动前轮转日志，与 CLI 一致（8 MiB × 3 代）
ExecStartPre=/usr/bin/bun -e "import('./src/observability/log.ts').then((m) => m.rotateLogFile('data/daemon.log'))"
ExecStart=/bin/sh -c 'exec /usr/bin/bun run src/daemon/index.ts >> data/daemon.log 2>&1'
# 日志与 shell 新建的文件只对本用户可读
UMask=0077
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now telegram-agent
sudo loginctl enable-linger <user>          # 未登录时也随开机启动
systemctl --user restart telegram-agent     # 部署新代码后
```

- 用 systemd 托管时**不要**再用 `bun run start` 另起一个；`bun run status` 仍可用来查看。两个 daemon 会争抢同一 token（Telegram 409）。
- `bun run stop` 是干净退出，不会触发 `Restart=on-failure`。5 分钟内失败 5 次后 systemd 停止重启（例如 token 失效），修好后 `systemctl --user reset-failed telegram-agent` 再启动。
- 整机 OOM 连 user manager 一起杀掉时，`Restart` 与 linger 都救不回来；先找资源耗尽的来源。

## 部署新代码

```bash
git pull --ff-only
bun install --frozen-lockfile
bun test && bun run check
systemctl --user restart telegram-agent     # 或 bun run restart
bun run status
```

cache-visible 变化或 Pi 版本变化会让每个 bot 新建 session（日志 `session_ready` 的 `state: "new"`），这是预期行为，旧 session 文件保留。

## 观察

```bash
bun run debug -- --since 30m          # 只读诊断报告，见 debugging-guide
tail -f data/daemon.log               # JSONL 结构化日志，不含正文
```

- 每个 bot 启动时的 `sticker-catalog` 行报告 `catalog/sendable/missing_file_id`；`missing_file_id > 0` 的贴纸不会提供给该 bot。检查 set 名或 token 权限，不要复制另一个 bot 的 `file_id`。
- 需要视频抽帧的模式下缺 FFmpeg 会有一条 `video_transcoder_unavailable` 提示，不阻塞启动。

## 重置一个 bot 的上下文

bot 的上下文被带偏（例如反复纠结某个误解）时，管理员在群里发 `/new`（多 bot 时用 `/new@bot_username`）。新 session 只看到之后的消息，旧 session 文件保留在 `data/sessions/<bot>/`。不要直接删除 session 文件或改数据库。

## 备份

1. `bun run stop`（或 `systemctl --user stop telegram-agent`），确认 `status` 不再显示 running；
2. 复制整个 deployment：`telegram.config.ts`、`.env`、`personas/*.local.md`、`data/`；
3. `.env` 与私有 persona 存放在受控位置，不上传公共位置。

不要只复制数据库后在同一目录并行启动第二份 daemon。

## 故障恢复

| 现象 | 处理 |
|---|---|
| `status` 报重复或孤儿 daemon | `bun run restart`；它只处理本仓库真实的 daemon 入口 |
| pid 文件损坏且 socket 同时存在 | controller 拒绝猜测；先检查 `data/daemon.pid`、`data/daemon.sock` 与 `ps`，不要 signal 未确认身份的 pid |
| Telegram 409 | 同一 token 被另一个进程轮询；确认只有一个 daemon（systemd 与手动 start 不要并存） |
| 401 / 404 | token 被撤销或错误：修正 `.env` 后重启；daemon 会整体退出而不是留下半个进程 |
| 数据库报 “predates the current schema” | 旧库不迁移：停 daemon，把 `data/agent.db*` 移到别处，重启从空库开始 |
| 群内命令报“权限不足” | 检查发送者 numeric user id 或 `@username` 是否在 `telegram_admins` |
| 手动发送提示结果未知 | 先在群里确认是否已出现，再决定是否重发 |

## 真实环境验证（opt-in）

以下脚本会调用真实 provider 与 Telegram，可能产生费用和群消息，必须用 `--bot` 指定 bot：

```bash
bun run scripts/smoke-pi.ts --bot <id>
bun run scripts/e2e-agent.ts --bot <id>
bun run scripts/e2e-compaction.ts --bot <id>
```

运行前记录目标 bot、预期副作用和回滚步骤。
