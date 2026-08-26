# 统一 usage/status telemetry 口径

> 本文是 Pi `/tg status` 与 Telegram `/status` 的 usage 字段、计算公式和展示一致性的唯一权威来源。日志诊断见 `docs/engineering/debugging-guide.md`；provider cache 协议见 `docs/cache.md`。

## 目的与范围

两个详细界面 MUST 从同一份 SQLite `llm_runs`、daemon runtime snapshot 和同一组派生函数得到数值。界面可以因空间不同采用换行或富文本，但不能改变字段含义、统计范围或公式。普通 Pi footer 显示当前 operator session；attached feed 通过官方 `ctx.ui.setFooter` 换成同构的 Telegram footer，隐藏无关的 operator usage 行。detach 后恢复 Pi 默认 footer。

本文同时定义 provider usage 聚合与详细 runtime 状态的合并投影；Telegram runtime state、routing/cooldown 与最近 compact outcome 仍由 control/runtime 层拥有，不能反向藏进 usage 聚合。

## 唯一状态读模型

daemon 的 runtime snapshot 是 provider/model、**实际生效 reasoning effort**、context window、epoch、runtime state、routing/cooldown 与 compact outcome 的权威来源；SQLite `BotStats` 是 latest/lifetime usage 的权威来源。两者只能在共享 `BotStatusView` builder 中合并一次，再由共享字段投影生成详细状态。

- Pi `/tg status` 与 Telegram `/status` 的 plain/rich 版本 MUST 迭代同一组有序字段，不得各自维护字段清单。新增、删除或重命名详细字段只能改共享投影一次。
- daemon snapshot 通过 additive IPC 随 stats baseline 发送；`/tg status` 每次建立短连接读取新 snapshot，不能复用可能过期的 feed runtime state。
- reasoning 展示的是 Pi session 的 effective value。requested/supported/effective 只在配置校验与 debug 中同时出现；运行中的状态不得把 requested value 伪装成 effective value。

## 权威数据与两种时间范围

`llm_runs` 每行是一条成功返回 usage 的 provider response。保留期由配置控制，默认 90 天；文案中的“累计”或“lifetime”只表示当前 SQLite 保留行，不表示永久历史。

- **最近请求（latest）**：该 bot 最新一条 `compaction = 0` 的主对话 response。它提供该请求的epoch、miss/read/write、output、reasoning、latency 与单次费用。compaction 的辅助模型调用不能冒充当前主对话请求。
- **当前上下文（current）**：daemon runtime实时调用Pi `session.getContextUsage()`。compact后、下一次主请求前Pi会返回unknown，此时显示`— / window`；不得回退到旧epoch的latest run。分段也只有在latest run与当前epoch一致时显示。
- **保留期累计（lifetime）**：该 bot 当前保留的全部 `llm_runs`，包括主对话与 compaction provider response，也包括切换 provider/model 前的历史行。它提供 runs、起始时间、prompt/output/cache/reasoning、费用与平均 latency。

每行 `cost` 在 response 到达时由 Pi 按该行实际 `provider/model` 的当时 catalog 费率计算并固化。累计费用只做 `SUM(cost)`：切换模型后，新 run 使用新模型费率，DeepSeek 等旧 run 保留原费用；catalog 或价格以后变化也不得用当前费率回算历史。订阅型 provider 若只提供等价按量估价，界面显示的是估算成本，不伪装成实际账单。

新增 response 必须同时更新 SQLite 与 live IPC totals；snapshot/push 通过 `llm_runs.id` 去重。compaction usage 参与累计，但不替换 latest 主对话请求。

`cache_read`、`cache_write` 与 `cache_miss` 永远保留 provider/Pi 返回的原始值。若 provider 没有暴露 cache usage，主对话 run 可另存 nullable `cache_read_estimated`：它只表示两次相邻 raw chat payload 的严格前缀可复用量，不回写或伪装成 provider 原始 usage。

## 字段与公式

| 展示 | 符号 | 权威值 / 公式 | 说明 |
| --- | --- | --- | --- |
| Prompt miss | `↑` | 有估算时 `context_tokens - cache_read_estimated - cache_write`，否则 `cache_miss` | provider 原值或本地结构估算；估算显示 `≈` |
| Output | `↓` | `output_tokens` | provider output；不计入当前 prompt context |
| Cache read | `R` | `COALESCE(cache_read_estimated, cache_read)` | provider cache read；本地结构估算显示 `≈` |
| Cache write | `W` | `cache_write` | 本次写入 provider cache、但未命中的 prompt tokens |
| Cache hit | `CH` | `R / (↑ + R + W) × 100%` | 显示一位小数；只有 `R > 0` 或 `W > 0` 时有 cache 样本，否则显示 `—` |
| Prompt total | `prompt` | `↑ + R + W` | lifetime 中等于 `SUM(context_tokens)` |
| 当前上下文 | `context` | runtime `session.getContextUsage() / model.contextWindow` | compact后暂时unknown；不是latest或lifetime prompt总和 |
| Reasoning | `reasoning` | `reasoning_tokens` | latest 取单行；lifetime 求和 |
| Latency | `latency` / `avg` | `latency_ms` / `SUM(latency_ms) ÷ COUNT(latency_ms)` | 缺失样本显示 `—` |
| Token speed | `tok/s` | 主对话 `SUM(output_tokens) ÷ SUM(latency_ms)` | compaction output不参与 |
| Thinking | `think` | 主对话thinking可见段的wall time平均；无thinking为0 | 不保存thinking正文 |
| Send | `send` | `send` tool从执行到settle的wall time平均 | 包含Telegram create与本地commit |
| Cost | `$` | `cost` | latest 取单行；lifetime 跨 provider/model 求和 |

`context_tokens` 是一次provider请求的prompt tokens，即 `↑ + R + W`；`output_tokens` 单列。主对话有效window = min(Pi catalog `contextWindow`, 顶层 `context_window` 配置，默认 65,536)。payload observer按provider请求中的system、tools、compaction summary、其他messages估算相对占比，再归一到provider返回的`context_tokens`；同epoch的实时session usage增加量归入messages，free为window减四段。跨epoch或实时usage未知时不展示旧分段。Telegram先按provider顺序单独显示红/紫/棕/蓝/绿方块条，再在下面逐行显示图例；每个方块代表四舍五入后的1,024 tokens。Pi用`S/T/C/M/F`文字简写。

本地 fallback 仅在以下条件全部成立时启用：当前 provider 原始 `cache_read = 0` 且 `cache_write = 0`、cache retention 不是 `none`；上一条主对话 run 与当前 run 的 bot/provider/api/model/epoch/session/cache retention 相同；两次 raw payload 的 system 与 tools HMAC 相同，上一条完整 message HMAC 列表是当前列表的逐项严格前缀；且当前 `context_tokens` 不小于上一条。此时 `cache_read_estimated = previous.context_tokens`。首次请求、任一旧 message 被改写、模型或 session/epoch 切换、compaction、无缓存策略以及 provider 已报告 read/write 时都不估算。旧库 migration 对保留行使用完全相同的相邻双 payload 规则回填。

`≈` 表示“按 raw payload 结构推导的理论可复用前缀”，不是 provider 实际命中或账单证明。费用仍使用 response 到达时固化的原始 provider usage/catalog 估价，绝不按本地估算重算。这样既能在 Ollama-compatible API 不返回 cache token 细项时显示趋势，也不会污染原始取证数据。

若没有 latest 主对话请求，当前上下文显示 `— / <window>`；若模型目录也没有有效 `contextWindow`，window 与百分比均显示 `—`。上下文上限 MUST 来自 daemon runtime snapshot 中已解析模型的 `contextWindow`（Pi catalog 值被顶层 `context_window` 配置钳制后的生效值），界面不自行查 catalog，也不维护第二份常量。

## 两个界面的共同字段

| 字段 | Pi `/tg status` | Telegram `/status` |
| --- | --- | --- |
| `↑ / ↓ / R / W / CH / $` lifetime | 完整数值 | 完整数值 |
| 当前 context / window / percent | runtime实时值 | 定向bot富消息小节 |
| provider/model/effective reasoning | 标题/明细 | 每 bot 富消息小节 |
| latest usage/latency/cost | 是 | 是 |
| lifetime runs/since/prompt/reasoning/avg | 是 | 是 |
| runtime state/routing/compact | 是 | 是 |

`/tg status` 与 Telegram `/status` 只是同一明细投影的两种外层渲染；二者的字段 key、顺序和数值必须来自同一个共享投影。Telegram每次只展示实际接收或`@bot_username`定向的单个bot，避免把不同epoch/model的状态并排混淆。

attached feed 的 footer 与 Pi 原生 `FooterComponent` 保持相同信息顺序：第一行是 cwd、git branch 与 session name；第二行左侧按原生顺序显示 lifetime `↑ / ↓ / R / W / CH / $` 和 latest 主对话的 `context%/window (auto)`，右侧按原生宽度规则显示 `(provider) model • reasoning`；其他临时 extension status 仅在存在时追加。compose 状态与 scope/连接状态放在 editor 上方的同一行 feed header，不占 footer 行。all-bots scope 只聚合当前配置 bot，并用最新主对话 run 所属 bot 的 context/model/reasoning。精确整数和完整 runtime 明细仍由 `/tg status` 提供。Pi 没有公开接口把远端 usage 注入原生 `FooterComponent`，因此 extension 只复刻该公开版本的布局，不伪造 `AgentSession`。detach、断线、restart/config 切换与 session shutdown 必须恢复默认 footer。

## 格式与边界

- Telegram `/status`、Pi `/tg status` 与 attached footer 的费用使用同一 formatter：至少 4 位、至多 6 位小数，费用整数部分使用英文逗号千位分隔；百分比固定一位小数。详细status同时展示平均tok/s、send与think耗时及上下文分段。
- Pi `/tg status` 与 Telegram `/status` 的详细整数统一使用英文逗号千位分隔。
- Telegram 富消息仍受 3500 字上限；只能按完整 bot 小节省略，不能在 Markdown 中间截断。
- 格式化和查看 telemetry 不调用 provider，不改变 session、context epoch 或 cache-visible payload。

## 验证与更新触发条件

测试 MUST 守卫：latest 排除 compaction、lifetime 包含 compaction、模型切换前后的 immutable per-run cost 跨 provider/model 累加、live compaction totals 不替换 latest、`CH` 分母包含 `W`、无 cache 样本显示 `—`、严格双 payload 前缀才产生本地 cache estimate、原始 cache/cost 不被估算改写、估算值在三个界面均显示 `≈`、当前 context 使用runtime session而非latest/lifetime、compact后unknown不回退旧epoch、Telegram status只显示目标bot且方块图例分行、三个界面共享费用精度、attached footer 保持 Pi 的信息顺序与 model 右对齐、compose guidance 留在单行 feed header，以及两个详细状态投影拥有完全相同的字段 key/顺序。

修改 `llm_runs` 字段、IPC `UsageRun` / `BotStats`、`/tg status` 或 Telegram `/status` 时必须同步本文。该模块的 Cache impact 为 **NONE**：它只读取既有 telemetry 并生成 UI/control side-channel。
