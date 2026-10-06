# 在 Pi 中聊天和观察

## 打开群聊视图

daemon 一直在后台运行，Pi 可以随时打开和关闭：

```bash
bun run pi
```

```text
/tg attach             # 群消息 + 所有 bot 的本地事件
/tg attach friend      # 群消息 + 只看 friend 的本地事件与用量
/tg more               # 加载一页更早的历史
/tg detach             # 断开实时更新，已显示的内容保留
```

输入 `/tg ` 后按 Tab 可以补全子命令和 bot。群聊视图只在本机显示，不会进入你当前 Pi 会话的模型上下文。

视图里你能看到：

- 群消息（图片和 sticker 在支持图片的终端里直接显示）；
- 每个 bot 的思考、工具调用和发送结果（标记为本地事件，群里看不到）；
- bot 没有调用 send 时写下的文字——这些只在本机可见，不会发到群里；
- 底部 footer 显示 Telegram 的累计用量、当前上下文占比和模型。

## 以 bot 身份发言

attach 之后，Pi 输入框默认直接发到 Telegram：

```text
/tg attach friend       # 直接以 friend 发言
/tg attach              # 多个 bot 时，每次发送前选择身份
/tg compose friend      # 固定以 friend 连续发言
/tg compose off         # 暂时把输入框交还给 Pi
/tg compose             # 恢复按当前视图选择身份
```

输入框上方会显示 `send as ...` 或 `choose bot on send`。只支持纯文本，带附件时会拒绝并保留原文。

如果发送中途断线或没有收到确认，结果是**未知**：输入框里的原文会恢复、compose 自动关闭、不会自动重试。请先去群里看消息是否已经发出，确认没有再发，以免重复。

## 用量

```text
/tg status             # 所有 bot
/tg status friend      # 某个 bot 的详细用量
```

显示运行状态、模型与 reasoning、当前上下文占比、最近一次请求、保留期内累计的 token、cache 命中率、费用、路由参数和最近一次压缩。与群里 `/status` 的口径完全一致。“累计”只覆盖数据库保留期（默认 90 天）；带 `≈` 的 cache 数字是本地估算。

## 在 Pi 里管理 daemon

```text
/tg start
/tg restart             # 重启所有 bot，就绪后自动重连当前视图
/tg stop
/tg status-daemon
/tg config              # 配置向导
```

下一步：[日常运维与群内命令](operations.md)。
