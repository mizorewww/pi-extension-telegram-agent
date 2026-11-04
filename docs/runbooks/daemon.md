# Runbook：daemon 运维

启动、停止、托管、观察与恢复 daemon 的操作步骤。配置项含义见用户指南的[配置章节](../user-guide/zh/src/configuration.md)。

## 命令

进程只由 systemd 托管，仓库不自带 start/stop 控制器：

```bash
systemctl --user start telegram-agent
systemctl --user restart telegram-agent     # 改 telegram.config.ts、.env 或 persona 后
systemctl --user stop telegram-agent
systemctl --user status telegram-agent
bun run start                               # 前台运行（没有 systemd 的机器、调试），Ctrl-C 停止
```

- 配置不热重载，改配置后重启。群内 `/set`、`/model`、`/new` 立即生效，无需重启。
- 同一份部署只能跑一个 daemon：pid 文件记录的进程还活着时，第二个会直接退出（`daemon already running`）。

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
# 每次（重）启动前轮转日志（8 MiB × 3 代）
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

- 用 systemd 托管时**不要**再 `bun run start` 另起一个：两个 daemon 会争抢同一 token（Telegram 409）。
- `systemctl --user stop` 是干净退出。5 分钟内失败 5 次后 systemd 停止重启（例如 token 失效），修好后 `systemctl --user reset-failed telegram-agent` 再启动。
- 整机 OOM 连 user manager 一起杀掉时，`Restart` 与 linger 都救不回来；先找资源耗尽的来源。

## 部署新代码

Pi 升级到 1.5.0 时，宿主依赖与任务镜像必须一起更新（镜像构建见 [sandbox runbook](sandbox.md)），并更新服务器安装的 provider 扩展以兼容 1.5。cache schema v47 会启用新 session/epoch；旧 session 文件与 SQLite schema 保留。

```bash
git pull --ff-only
bun install --frozen-lockfile
bun test && bun run check
systemctl --user restart telegram-agent
systemctl --user status telegram-agent
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

1. `systemctl --user stop telegram-agent`，确认 `status` 不再显示 running；
2. 复制整个 deployment：`telegram.config.ts`、`.env`、`personas/*.local.md`、`data/`；
3. `.env` 与私有 persona 存放在受控位置，不上传公共位置。

不要只复制数据库后在同一目录并行启动第二份 daemon。

## 故障恢复

| 现象 | 处理 |
|---|---|
| 启动报 `daemon already running` | 另有一个 daemon 在跑（多半是 systemd 之外手动起的）：用 `data/daemon.pid` 和 `ps` 确认是本仓库的进程后再停掉它 |
| Telegram 409 | 同一 token 被另一个进程轮询；确认只有一个 daemon（systemd 与手动 start 不要并存） |
| 401 / 404 | token 被撤销或错误：修正 `.env` 后重启；daemon 会整体退出而不是留下半个进程 |
| 数据库报 “predates the current schema” | 旧库不迁移：停 daemon，把 `data/agent.db*` 移到别处，重启从空库开始 |
| 群内命令报“权限不足” | 检查发送者的数字 user id 是否在 `telegram_admins` |

## 真实环境验证（opt-in）

以下脚本会调用真实 provider 与 Telegram，可能产生费用和群消息，必须用 `--bot` 指定 bot：

```bash
bun run scripts/smoke-pi.ts --bot <id>
bun run scripts/e2e-agent.ts --bot <id>
bun run scripts/e2e-compaction.ts --bot <id>
```

运行前记录目标 bot、预期副作用和回滚步骤。
