# 在 Pi 中观察群聊

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
- Pi 状态栏里一行 `TG …`：累计 token、cache 命中率、费用、当前上下文占比和模型。

这个视图只用来观察：Pi 里不能以 bot 身份发言，bot 说什么由它自己决定。

## 用量

```text
/tg status             # 所有 bot
/tg status friend      # 某个 bot 的详细用量
```

显示运行状态、模型与 reasoning、当前上下文占比、最近一次请求、保留期内累计的 token、cache 命中率、费用、路由参数和最近一次压缩。与群里 `/status` 的口径完全一致。“累计”只覆盖数据库保留期（默认 90 天）；带 `≈` 的 cache 数字是本地估算。

下一步：[日常运维与群内命令](operations.md)。
