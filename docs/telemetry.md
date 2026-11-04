# 用量与状态口径

Telegram `/status` 是确定性的纯文本，由 `src/observability/status.ts` 直接渲染，不调用 provider。

## 数据来源与范围

| 展示 | 来源 | 范围 |
|---|---|---|
| 当前上下文 | Pi `session.getContextUsage()` | 当前 session；压缩后 Pi 暂无用量时显示 `—` |
| 当前会话 token 与费用 | Pi `session.getSessionStats()` | Pi 当前 session 的原生统计；`/new`、`/model` 后重新开始 |
| 保留期累计 | SQLite `llm_runs`、`loadBotStats()` | 当前保留的主对话与摘要请求，默认 90 天，包含切换模型前的记录 |
| 后台任务 | SQLite `tasks` | 任务主会话累计 token 与费用，在 `/task` 单独展示，不并入聊天统计 |
| 运行状态与配置 | `BotRuntime.controlSnapshot()` | 实际模型、reasoning、epoch、路由概率、冷却、进程本次运行中最近的压缩结果 |

`llm_runs` 保存响应携带的原始非零 usage 和费用，包括失败响应已经报告的用量。摘要每次调用（包括分块与失败尝试）的非零 usage 同时通过 Pi `SessionManager.appendUsage()` 独立记账，compaction entry 不重复计费。费用按响应中的 Pi `usage.cost.total` 固化，查询时只求和，不按当前模型价格回算；provider 目录中的零单价或订阅估算不等于实际账单。

## 字段与公式

| 字段 | 口径 |
|---|---|
| 当前会话 `↑ / ↓ / R / W` | Pi 原生 `tokens.input / output / cacheRead / cacheWrite` |
| 保留期 prompt | `SUM(context_tokens)`，每行等于原始 `input + cacheRead + cacheWrite` |
| 保留期 output | `SUM(output_tokens)` |
| 保留期 cache read | `SUM(COALESCE(cache_read_estimated, cache_read))` |
| 保留期 cache write | `SUM(cache_write)` |
| 缓存比例 | 保留期 cache read / prompt；没有 prompt 时显示 `—` |
| 费用 | 原始 `cost` 求和，显示 4–6 位小数 |

`≈` 表示有请求使用了本地严格前缀估算，只证明结构可复用，不证明 provider 命中。原始 `cache_read`、`cache_write` 和费用不被估算改写。估算条件见 [cache.md](cache.md#遥测)。

有效 context window 为 min(Pi catalog window, 配置 `context_window`)。不再显示上下文构成占比、平均 thinking/send 耗时或 tok/s；这些本地推断不参与控制流。SQLite schema 保持不变，旧诊断列继续保留历史值，新请求不再填充它们。

遥测写入失败只产生结构化告警，不能让已经发到 Telegram 的消息变成可重试失败。
