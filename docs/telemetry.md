# 用量与状态口径

Telegram `/status` 的字段含义、公式和数据来源。

## 数据来源

| 来源 | 拥有什么 |
|---|---|
| SQLite `llm_runs`（`src/db/usage.ts` 的 `loadBotStats`） | 每次成功 provider 响应的 usage、费用、延迟；保留期内累计（默认 90 天） |
| SQLite `tasks` 用量列 | 后台任务主会话累计的 token 与费用，不进入 bot 的聊天统计，不按遥测保留期清理；`task status` 与 `/task` 显示它 |
| daemon runtime snapshot（`BotRuntime.controlSnapshot()`） | 当前 provider/model、**实际生效**的 reasoning、context window、epoch、运行状态、路由参数、最近压缩结果、Pi session 的实时 context 用量 |

两者只在 `src/observability/status.ts` 的 `buildBotStatusView` 里合并一次；详细字段由 `botStatusFields` 生成。新增或改字段只改这一处。

## 三种时间范围

- **最近请求**：该 bot 最新一条 `compaction = 0` 的主对话响应。摘要调用不冒充最近请求。
- **当前上下文**：runtime 实时读取 Pi `session.getContextUsage()`。压缩后到下一次主请求前 Pi 返回未知，显示 `— / window`，不回退到旧 epoch 的数值。
- **保留期累计**：当前保留的全部 `llm_runs`，包括摘要调用和切换模型前的记录。“累计 / lifetime”只表示 SQLite 保留窗口。

每行 `cost` 在响应到达时按当时实际 provider/model 的 Pi 费率算好并固化；累计只做求和，不按当前价格回算。订阅型 provider 的单价可能是 0 或等价估算，不等于实际账单。

## 字段与公式

| 展示 | 符号 | 公式 |
|---|---|---|
| Prompt miss | `↑` | 有估算时 `context_tokens − cache_read_estimated − cache_write`，否则 `cache_miss` |
| Output | `↓` | `output_tokens` |
| Cache read | `R` | `COALESCE(cache_read_estimated, cache_read)` |
| Cache write | `W` | `cache_write` |
| 命中率 | `CH` | `R / (↑ + R + W)`；`R` 与 `W` 都为 0 时显示 `—` |
| Prompt | `prompt` | `↑ + R + W` = `SUM(context_tokens)` |
| 速度 | `tok/s` | 主对话 `SUM(output_tokens) / SUM(latency_ms)` |
| Thinking / Send | `think` / `send` | 主对话 thinking 可见段耗时、send 从执行到结束的耗时，取平均 |
| 费用 | `$` | `cost` 求和 |

- 有效 context window = min(Pi catalog `contextWindow`, 配置 `context_window`)，取自 runtime snapshot，界面不自行查 catalog。
- 上下文构成（system / tool / 摘要 / messages / free）来自 payload observer 的形状估算，再按比例归一到 provider 返回的 prompt 总数；跨 epoch 或当前用量未知时不显示。百分比用最大余数法取一位小数，五项严格相加为 100.0%。provider 没实现 Pi 的 `onPayload` 钩子时只有总量。
- `≈` 表示本地结构估算（见 [cache.md](cache.md#遥测)），不是 provider 实际命中。
- 费用 4–6 位小数，整数千位分隔；时间按本地时区 `YYYY-MM-DD HH:MM:SS`（生产为 Asia/Singapore）。

查看遥测不调用 provider，不改变 session 或 provider payload。
