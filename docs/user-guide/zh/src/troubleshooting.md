# 故障排查

先跑一次只读诊断，它会指出问题卡在哪一步：

```bash
bun run debug -- --since 30m
```

不要为了“试一下”删除 `data/`、pid 或 socket 文件。

## `bun run pi` 启动不了

```bash
bun install --frozen-lockfile
pi --version
```

找不到 `pi` 就先安装 Pi 并确认它在 PATH 中；本项目不会替你安装 Pi。

## 菜单里没有 `/tg config`

确认是在仓库根目录运行的 `bun run pi`。`/tg config` 不依赖已有配置，没有它通常是扩展没被加载。

## 向导拒绝配置

- 字段错误：按提示修改对应字段（token 等值不会回显）。
- 模型未就绪：退出向导，用 Pi `/login`、`/model` 修好后重试，此时还没有写入任何文件。

## 配置有效但 bot 没上线

```text
/tg status-daemon
/tg restart
```

再看 `data/daemon.log`。常见原因：token 错误、网络不通、bot 不在群里、所选模型不在 Pi 目录里，或在 `media.mode: "context"` 下选了不支持图片的模型（`image_input_unsupported`）。

## 群里 @ 了 bot 但没反应

- 确认 BotFather 里已关闭 group privacy，bot 在正确的群里且能发言。
- 跑 `bun run debug`：`pending_reply_obligation` 表示还欠着这条回复（bot 会在下次触发或重启时补上）；`route_without_run` 表示路由了但没发起请求，看日志里的 `flush_failed` / `provider_attempt_failed`。
- 401：token 被撤销，修正 `.env` 后重启。
- 409：同一个 token 被另一个进程使用。确认只有一个 daemon 在运行（不要同时用 systemd 和 `bun run start`，也不要在另一台机器上用同一 token 启动）。

## bot 一直说跟话题无关的话

bot 的上下文可能被某个误解带偏了（摘要会把它延续下去）。管理员在群里发 `/new` 开启新会话即可；它只会看到之后的消息。

## 图片没有显示

- 图片显示取决于终端是否支持图片（Kitty、Ghostty、iTerm2、WezTerm 等）；不支持时只显示 `[photo]` 等标签。
- 新图片先显示标签，下载完成后原位出现。超过 1 MiB 的图片不在终端显示。
- 上下文被压缩后，不再被任何 bot 需要的本地图片会被清理，旧卡片只剩标签是正常的；消息和图片描述都还在。

## 视频没被理解

`bun run debug` 报 `video_transcoder_unavailable` 表示缺少 `ffmpeg`/`ffprobe`。安装后重启即可，其它功能不受影响。超过 20 MiB 的视频不会处理。

## 搜索或读网页失败

- 确认该 bot 的 `tools.search` 为 `true`，`.env` 里有 TinyFish key，然后重启。
- `invalid_url` 表示目标不是公网 HTTP(S) 地址（例如 localhost、内网 IP、带用户名密码的链接），这是有意的安全限制。

## 发送结果未知

Pi 里手动发送提示结果未知时，消息可能已经发出。先去群里确认，没有再重发。

## 求助时提供什么

`bun run status` 的输出、`pi --version`、检查过的日志末尾、出问题的命令和 bot id、使用的终端。不要提交 `.env`、persona、聊天内容、token 或 API key。
