# 在 Pi 中聊天和观察

## 打开 feed

daemon 长期运行；Pi 可以随时打开或关闭：

```bash
bun run pi
```

首次 `/tg config` ready 后会自动 attach 全局 feed。以后可手工选择：

```text
/tg attach             # 群消息 + 所有 bot 的 LOCAL 事件
/tg attach friend      # 群消息 + friend 的 LOCAL/usage
/tg more               # 加载一页更早历史
/tg detach             # 断开 live socket，保留已显示 transcript
```

Telegram feed 是一个 TUI-only Pi custom entry。滚动、resize、选择、主题和图片布局由 Pi 原生组件负责；editor 上方的一行统一显示 feed scope、连接与 compose 状态，attached 期间则用 Pi 官方 footer API 显示路径和 Telegram usage/model，隐藏 operator usage 行。消息不会因为展示而进入当前 Pi agent 的 provider context。

在 `/tg ` 后使用 Tab 或原生选择菜单。bot 参数由当前已验证配置动态补全。

## 直接发送

`attach` 后 Pi editor 默认直接发 Telegram：单 bot filter 直接使用该 bot；全局 feed 若有多个 bot，每次提交都会打开 Pi 原生选择框；只有一个 bot 时不弹框。

```text
/tg attach friend       # 直接以 friend 发送
/tg attach              # 多 bot 时每条消息选择身份
/tg compose friend      # 可选：固定为 friend，连续发送不再选择
/tg compose off         # 暂时把 editor 交还 Pi
/tg compose             # 恢复当前 feed scope
```

feed header 会在 `attached` 后显示 `send as ...` 或 `choose bot on send`，选择与发送时原位更新。取消选择会恢复逐字节相同的原文且不发送。compose 只拦截 interactive editor；RPC 或 extension 输入仍交给 Pi。附件不会被偷偷降级成只发 caption。

明确失败会恢复 editor 原文。如果 ACK 丢失或连接在发送中断开，结果是 unknown：

1. compose 自动关闭；
2. 插件不自动重试；
3. 先检查 Telegram 群；
4. 只有确认消息不存在时才再次发送。

这条边界防止“远端已成功、本地确认失败”导致重复消息。

## 状态

```text
/tg status             # 全局 Telegram telemetry
/tg status friend      # lifetime + latest 明细
```

Pi `/tg status` 与 Telegram `/status` 共用[统一 telemetry 口径](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/telemetry.md)：lifetime 来自 SQLite `llm_runs` 保留期并包含 compact 调用，详细状态的 current context 直接取 daemon 中对应 Pi session 的实时 `used/window/percent`，不是最近 run 或历史 prompt 总和。attached footer 保持原有 latest-run 口径和 Pi 原生的路径与 usage/model 信息顺序；compose guidance 留在 feed header，`/tg detach`后恢复Pi默认footer。

## 本地事件、stream 与媒体

- assistant thinking/text/tool partial 会在同一 Pi native card 原位更新，结束后由持久 LOCAL/Telegram event 接替；partial 不写 SQLite。
- bot 没有调用 `send` 时的 local assistant text 只在 feed 可见，不会发群。
- vision模式（默认）下，`vision.enabled`开启后，辅助视觉模型为照片、sticker和视频生成文字描述，只在真实bot run需要时生成；视频抽最多3张固定代表帧，并在一次vision调用中综合理解；描述按媒体持久化并跨bot共享，以`[图片: 描述]`进入主模型上下文，UI本身不会额外触发provider。
- context模式（opt-in）下，主模型直接看到上下文里的图片，没有辅助视觉模型和文字描述——历史 vision 时代持久化的描述同样绝不注入上下文：照片、静态sticker作为图片进入上下文，视频（含视频sticker、GIF动图、video note）抽取1-3张代表帧；每次模型调用最多附`media.max_images_per_turn`张图，超出上限或上下文预算的媒体降级为文字占位。
- 两种模式下语音/音频/非视频文件/TGS动态贴纸模型都看不到内容，只有文字占位——这是当前模型API的硬限制。
- 媒体属于共享群消息：全局与任一单bot feed都会显示对应媒体（vision模式的描述显示在对应图片正下方）；单bot filter只限制LOCAL事件与usage。
- 用户和bot发出的static photo/sticker共用本地展示准备链路；video、animation、video note、video document与video sticker以媒体placeholder显示，vision模式下可获得视觉描述，context模式下其代表帧只进入模型上下文。inline image是否可见仍取决于Pi terminal capability，文字、media label和视觉描述保持可读fallback。

## 网页搜索与链接读取

为当前bot启用`tools.search`并配置TinyFish key后，agent可按需调用同一个工具：用query取得最多5条短结果，或读取一条public HTTP(S)链接。群里的链接不会被自动抓取；只有回答需要页面正文时才显式调用。

网页正文先受8,000字符本地护栏约束，再受2,048 provider tokens上限约束，并带有固定“不可信网页内容”边界。页面里的命令不会成为agent指令；登录态、userinfo、localhost、private/link-local地址会在请求前拒绝。事件和日志只保留hostname、字符数和固定结果类别，不保留URL path/query/fragment或正文。

## Pi 内 daemon 命令

```text
/tg start
/tg restart
/tg stop
/tg status-daemon
```

`/tg restart` 会关闭 compose 和旧 IPC，受控替换整个 deployment。明确 ready 后恢复已有 feed；失败时保留 transcript 并给出诊断。

下一步：[日常运维](operations.md)。
