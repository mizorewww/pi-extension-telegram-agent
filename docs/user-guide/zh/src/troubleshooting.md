# 故障排查

先从症状选择安全的下一步；不要删除data、pid或socket来“试一下”。完整进程恢复规则见[daemon runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/daemon.md)。

## `bun run pi` 无法启动

运行：

```bash
bun install --frozen-lockfile
bun run pi --version
```

预期版本是项目锁定的 Pi 0.84.1。若安装失败，保留错误输出并修复registry/network；不要改成未锁定的全局 Pi 来掩盖问题。

## `/tg config` 不在菜单中

确认你从仓库根运行 `bun run pi`，并且 package discovery 加载了 `.pi/extensions/tg-extension.ts`。`config` 是静态命令，不依赖已有 config；若完全缺失，优先排查Pi/package加载，而不是手工创建空配置文件。

## 向导拒绝配置

- 字段错误：按notification列出的字段修复；值不会回显。
- 已有文件：选择validate/editor，或明确确认backup-replace；取消不会改字节。
- Pi model preflight：退出向导，用 Pi `/login`、`/model` 修复后重试；deployment 文件尚未写入。

## 配置有效但 daemon 未 ready

```text
/tg status-daemon
/tg restart
```

再检查 `data/daemon.log`。常见原因是Telegram token错误、网络不可达、Pi login/default model已变化、model不在Pi catalog、`media.mode: "context"`下主模型不支持图片输入（`image_input_unsupported`，用Pi `/model`换一个支持的模型或回到默认vision模式）或bot未加入目标群。有效配置会保留；不需要重新粘贴token。

## `daemon starting` 很久

配置了sticker sets时首次Telegram catalog拉取可能较慢。vision模式的描述生成只有`vision.enabled`显式开启后才工作，不属于默认启动路径。运行`bun run status`并观察脱敏日志。如果child仍alive，controller不会把60秒等待上限误报成ready；只有socket真实可连接才算ready。

修改model、persona、cache policy、tools等cache-visible字段后，日志出现`session ready (new)`是预期行为。context fingerprint会阻止用新identity恢复旧session；旧文件仍保留用于恢复或审计。

## Telegram 401 或没有群消息

- 401：轮换或修正对应bot token，确认`token_env`指向正确key，再restart。
- 普通群消息不可见：在BotFather关闭该bot group privacy，确认bot已加入正确supergroup。
- bot不能发言：检查Telegram群权限；不需要为了普通读取授予多余管理员权限。

## Telegram 409 / duplicate poller

同一个token正在被另一进程长轮询。运行`bun run restart`；controller会验证并回收当前deployment的真实daemon与孤儿。不要盲目`kill` pid file中的数字，也不要并发start。

## Pi feed 或 compose 断开

- `no connected Telegram feed`：先`/tg attach [bot]`，等snapshot连接完成。
- `unknown bot id`：使用`/tg `补全，或检查配置id。
- compose unknown outcome：先查群，不自动重试；确认缺失后再发。
- `/tg detach`或关闭Pi不会停止daemon；重新`/tg attach`即可。

## 图片没有内联显示

用户或bot新发的static photo/sticker会先显示media label，再由daemon后台下载并在同一Pi卡片原位出现；它不依赖routing或任何模型调用。animated/video媒体保留文字placeholder。daemon启动时会把旧绝对cache path按文件名迁到当前`data/media`，不存在的记录先清空，再只回填仍被当前上下文、未消费event或待回复义务引用的最新100条static display缺口。

成功compaction后，所有当前配置bot都不再引用的本地媒体cache会按有界批次自动删除；旧Pi卡片因此只剩label是预期行为，不代表消息、vision描述或媒体派生文件记录、Telegram file mapping丢失。restart不会为了历史展示把这些文件无条件下载回来。

若新媒体持续只有label，先在脱敏日志中查`media_cache_ready/skip/error`的固定category与queue数字，再检查文件是否超过1 MiB、是否为支持的静态图片格式、terminal图像能力和当前项目Pi版本。Pi根据当前capability选择Kitty/iTerm2/native fallback；不要手写terminal escape或绕过Pi组件。稳定复现时只记录terminal、tmux状态、媒体种类、固定outcome和“是否有本地path”，不要附带token、绝对path或私人图片本体。

## 视频没有视觉描述或代表帧

先运行`bun run debug`。`video_transcoder_unavailable`表示主机缺少`ffmpeg`或`ffprobe`；`start`/`restart`/`status`也会说明它只用于视频抽帧并给出安装建议。两种媒体模式的视频抽帧都需要FFmpeg。这个告警不阻塞daemon，不会发到群里：vision模式下视频在Telegram下载和provider调用前跳过、不占provider token；context模式下视频（含视频sticker与GIF动图）只以文字占位进入上下文。聊天、图片处理和三种sticker发送保持正常。安装同一FFmpeg发行包后restart即可，之前的失败不会永久缓存。`video_probe_failed`或`video_frame_extraction_failed`表示文件无法由本机工具读取；检查是否超过20 MiB和格式支持。日志不会包含文件path、stderr或视频内容。

## 搜索或网页读取失败

- 确认对应bot的`tools.search`为true，`.env`中存在`tinyfish_key_env`选中的key，然后受控restart。
- `invalid_url`表示目标不是允许的public HTTP(S) URL，或包含userinfo/local/private/link-local地址；不要通过关闭校验来访问内网。
- `*_timeout`、`*_http_*`、`*_response_too_large`和`fetch_*`是固定类别。它们只影响当前turn；不会后台重试或换URL。
- 排查时只记录固定category与hostname。不要粘贴API key、signed URL的path/query/fragment或网页正文。

## 仍无法恢复

收集以下非敏感信息：

- `bun run status` 输出；
- `bun run pi --version`；
- `data/daemon.log`中手工复核过的脱敏末尾；
- 失败命令、bot id、配置是新写还是替换已有文件；
- 是否使用tmux、Kitty/Ghostty/iTerm2。

不要提交 `.env`、真实persona、完整群消息、token、API key或未脱敏绝对路径。
