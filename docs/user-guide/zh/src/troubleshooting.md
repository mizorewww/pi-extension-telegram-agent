# 故障排查

先跑一次只读诊断，结合最近请求、回复义务和日志定位问题：

```bash
bun run debug -- --since 30m
```

不要为了“试一下”删除 `data/` 或 pid 文件。

## 启动时报配置错误

配置错误会列出有问题的字段和原因（token 等值不会回显）。按提示改 `telegram.config.ts` 或 `.env` 后重启；模型未就绪时用 Pi `/login`、`/model` 修好。

## 配置有效但 bot 没上线

```bash
systemctl --user status telegram-agent
```

再看日志（systemd 下是 `data/daemon.log`）。常见原因：token 错误、网络不通、bot 不在群里、所选模型不在 Pi 目录里，或在 `media.mode` 为 `"hybrid"` 时选了不支持图片的模型（`image_input_unsupported`）。

## 群里 @ 了 bot 但没反应

- 确认 BotFather 里已关闭 group privacy，bot 在正确的群里且能发言。
- 跑 `bun run debug`：`context.pending_reply_obligations > 0` 表示还有待答消息（bot 会在下次触发或重启时补上）；对比 `claims` 与 `runs`，并看日志里的 `flush_failed` / `provider_attempt_failed`。
- 401：token 被撤销，修正 `.env` 后重启。
- 409：同一个 token 被另一个进程使用。确认只有一个 daemon 在运行（不要在 systemd 之外再 `bun run start` 一份，也不要在另一台机器上用同一 token 启动）。

## bot 一直说跟话题无关的话

bot 的上下文可能被某个误解带偏了（摘要会把它延续下去）。管理员在群里发 `/new` 开启新会话即可；它只会看到之后的消息。

## 视频没被理解

启动日志报 `video_transcoder_unavailable` 表示缺少 `ffmpeg`/`ffprobe`。安装后重启即可，其它功能不受影响。超过 20 MiB 的视频不会处理。

## 搜索或读网页失败

- 确认该 bot 的 `tools.search` 为 `true`，`.env` 里有 TinyFish key，然后重启。
- `invalid_url` 表示目标不是公网 HTTP(S) 地址（例如 localhost、内网 IP、带用户名密码的链接），这是有意的安全限制。

## 工作区命令失败

- 启动时就报错：检查 `tools.sandbox` 是否同时开了 `tools.codemode`，以及顶层有没有 `sandbox` 段。
- 运行中失败：在主机上执行 `DOCKER_HOST=unix:///run/tgbox/docker.sock docker info`，确认 rootless Docker 在运行、daemon 用户在 `tgbox` 组里；镜像名要与 `sandbox.image` 一致。步骤见 [sandbox runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/sandbox.md)。
- 工作区里的东西乱了：管理员发 `/box reset`，下次使用时自动重建。

## 后台任务没有结果

- 启动时就报错：`tools.tasks` 需要 `tools.sandbox` 和顶层 `tasks` 段，`tasks.workflows` 的每个目录里都要有 `.pi`。
- 任务很快失败：多半是任务容器里的 Pi 没有模型凭证，按 [sandbox runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/sandbox.md#任务凭证卷) 准备凭证卷。
- 一直没有结果：超过 `tasks.timeout_minutes` 会判为失败并通知发起人；在主机上用 `docker ps --filter label=tg-task`（带上面的 `DOCKER_HOST`）查看正在运行的任务。daemon 重启会中断进行中的任务。

## 求助时提供什么

`systemctl --user status telegram-agent` 的输出、`pi --version`、检查过的日志末尾、出问题的命令和 bot id、使用的终端。不要提交 `.env`、persona、聊天内容、token 或 API key。
