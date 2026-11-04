# 用量与状态口径

`/status` 是确定性的纯文本，不调用 provider。Pi Durable 是用量的唯一账本；业务库不再写入 `llm_runs`，也不估算 cache 命中。

| 展示 | 来源 | 范围 |
|---|---|---|
| 当前上下文 | Pi `estimateContextTokens(view.messages)` | 当前 root context 的估算；包含图片估算，不等于 provider 实际计费 |
| Pi 累计 token / 费用 | `Harness.usage()` | 本 bot 的整个 Harness，包含 child 和历史；`/new` 不清空累计值 |
| 后台任务 | child 的 `UsageDoc` | 该 child 的原生累计，同样已包含在 Harness 汇总中，不能再次相加 |
| 运行状态与配置 | `BotRuntime.controlSnapshot()` | 当前模型、reasoning、epoch、规划窗口、路由与进程本次最近的手动压缩结果 |

prompt = input + cacheRead + cacheWrite；缓存比例 = cacheRead / prompt。没有 provider cache 计量时显示原始零值，不以结构可复用量冒充命中。费用为 Pi 返回的原始 cost.total 累计，不按最新模型价格回算；目录的零价格/订阅估算不代表实际账单。

原生摘要的计量归属和持久化由 Pi 负责。旧业务库的 `llm_runs` 仅保留供历史核查，不混进新账本。日志只提供身份与结果分类，业务正确性和发送去重不能依赖日志。
