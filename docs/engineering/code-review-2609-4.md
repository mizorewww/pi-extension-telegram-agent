# 2026-09-29 Telegram bot 审查

范围：本次部署的 Telegram bot（含模型菜单），重点检查 provider/runtime、路由与交付、媒体和压缩、工具成本、Pi 启动入口及验证脚本。生产证据仅使用用量和脱敏状态，不复制群正文或凭据。

## 已修复

| 优先级 | 问题与证据 | 结果 |
| --- | --- | --- |
| P1 | Devin 扩展 0.3.0 要求 Pi ≥0.86.0；旧 SDK 0.84.1 可以加载 SWE-2 目录，但真正执行时缺少 `collapseSystemMessages` 等导出，两个 bot 均在请求前失败 | 四个 SDK 包同步锁定 0.86.0，更新 manifest/lock，新增执行自定义 provider transcript 的离线回归 |
| P1 | 上线观察新会话时发现首请求 system 估算仅 1 token；Pi 0.86 的 `sendCustomMessage(triggerTurn)` 直接启动 agent loop，遗漏 `prompt()` 安装 system/persona 的 preflight，后续请求才补齐 | 统一使用原生 `prompt()` + `before_agent_start` 消息注入；真实 BotRuntime 回归锁定首轮与连续请求的完整前缀。每轮增加一条短触发消息，不增加模型请求 |
| P1 | 聊天失败后，Pi 原生 threshold 压缩仍调用摘要模型。改动前 24 小时只有 16 条主聊天记录，却有 810 条全零摘要尝试记录；最后一条失败摘要包含 225 张图片，估算输入 398,717 tokens | 在原生扩展边界取消失败 turn 的 threshold 压缩，覆盖下一 prompt 的 preflight；保留 overflow 恢复和显式压缩。回归使用真实 Pi AgentSession |
| P2 | 摘要失败的全零 usage 仍插入 `llm_runs`，污染调用次数和平均值 | 不写全零行；失败但报告了实际用量的请求仍计费。历史记录保留 |
| P2 | `smoke-pi.ts` 只等待 `prompt()` resolve，错误、空回答也打印成功 | 要求新的完整正确回答；失败非零退出，并补请求 deadline、关闭自动重试和后台预热 |
| P2 | `bun run pi` 强制项目 CLI 版本，且会隐式安装依赖 | 调用 PATH 中本机 Pi，跳过 Bun 注入的 `node_modules/.bin`；保留参数和退出码，不再 bootstrap |
| P2 | SWE-2 扩展不调用 `onPayload`，上下文占用全归入 messages，零值 system/tools 又被图例隐藏；原来的 FIFO 观察队列还可能把重试 payload 配给下一次 usage | 在 [pi-devin](https://github.com/mizorewww/pi-devin/commit/a61846628055a1707aef7c4c59e88121fdeb2259) 实现 Pi 原生 `onPayload`，删除 bot 端 transcript 估算兜底。bot 只采用本请求最后一次 payload 观察，支持 Pi 图片格式并完整保留五项图例；无 provider 名称分支 |

Pi 0.86.0 默认的 `cacheWarming: "streaming"` 可能在长工具任务期间产生额外请求。daemon 和 smoke 明确设置为 `off`，避免升级改变调用数量。SDK provider transcript 迁移及首轮 preflight 修复最终使用 cache schema 23；新增短触发消息 golden，项目 system/tools/群消息序列化 golden hash 不变，旧 session 保留。

## 尚未修改的风险

1. **P1：单次 turn 的总调用数和输出量没有上限。** [runtime](../../src/agent/runtime.ts) 的 watchdog 只限制每一次 provider 请求；`providerCallsInRun` 只用于统计。`search` / `run_js` 可以触发后续模型请求，模型连续选择工具时整个 turn 可以长时间保持 busy 并持续收费。SWE-2 的本机 catalog `maxTokens` 为 128,000，主聊天没有显式的更小输出上限，但 suffix 打包只预留 4,096 输出 tokens。建议优先用 Pi 原生 turn/stream hook 设置总调用、总时长和输出预算，再验证截断与明确回复的恢复语义。本次未引入新的预算配置或改变工具行为。

2. **P2：shutdown 仍记录异常原文。** [daemon shutdown](../../src/daemon/index.ts) 的 `runtime_stop_failed` 把 `result.reason.message` 作为字符串交给 logger。通用 redactor 只能覆盖已知 token/URL/path 格式，不能保证 provider 异常中的任意正文或新格式 secret 被删除。应只保留 `bot_id` 和固定 `dispose_failed` category。

3. **P2：真实群 e2e 不能证明公开发送成功。** [e2e-agent.ts](../../scripts/e2e-agent.ts) 在 `ranOnce=true`、`settled=false` 时仍退出 0；查询的 run/send 仅按 bot 与数量差判断，并未绑定测试 trigger。生产 daemon 同时运行时，其他 turn 可以满足条件。本次按用户要求采用真实流量观察，没有执行该脚本。

4. **P2：debug 的模型能力目录与 daemon 不一致。** [debug-report.ts](../../scripts/debug-report.ts) 用裸 `ModelRuntime.create()`，daemon 则加载用户级 provider 扩展。`devin/swe-2` 来自扩展，因此 debug 的 reasoning 列表可能缺项，仍显示目录读取成功。修复需要兼顾该命令“零网络”的约束，不能直接加载会自行联网的扩展来替换。

## 成本设计

- **最直接的调用放大来自路由配置。** 本机两个 bot 的 `routing_p` 为 0.66 和 0.34，总和 1；空闲时普通人类消息均会选中一个 bot，只有 busy/cooldown 才跳过，冷却仅 2 秒。若希望减少主动插话成本，可降低总概率或延长 cooldown；点名/reply 仍按明确寻址处理。本次保留聊天频率。
- **大上下文需要实际 cache 证据。** 按用户追加要求将窗口从 131,072 调至 256K（配置 262,144，SWE-2 catalog 钳制后生效 262,000），压缩阈值从 114,688 调至 245,616，保留原文 20,000。更长历史会提高每轮输入，推迟摘要。改动前样本中 A 的 14 次主请求平均输入 74,762 tokens，B 的 2 次平均 84,607。A 上游报告的 cache read 占输入约 47.3%；B 报告为 0，但不能区分没有命中与上游没有提供统计。降低阈值可减少长期输入，却增加摘要与冷缓存次数，不应只凭参数大小宣称更便宜。
- **图片数量会随未压缩历史累积。** 每轮最多 4 图不等于整个上下文最多 4 图；相同历史图片会参与后续主请求和摘要。图片预算、压缩失败与上下文窗口应一起观察。context 模式不增加独立 vision 请求，vision 模式则有跨 bot 的持久描述缓存，属于合理取舍。
- **零价格元数据不代表免费。** 原 antigravity 模型和当前 Devin/SWE-2 的本机 catalog 四项单价均为 0，无法用 `llm_runs.cost` 推算真实账单。SWE-2 最初的新 session 请求 `cache_read=0`，随后 26 次请求中上游累计报告 142,558 cached tokens / 182,838 prompt tokens，约 78%；这是小样本的 token 占比，不是费用减免比例。应以 provider 账户用量为准，不编造美元节省额。
- **已经有价值的节省机制应保留。** 确定性 HMAC 路由、跨 bot 媒体准备/vision 复用、有界 suffix 和搜索输出、动态 sticker 候选只投影到最后一批、`send` 返回 `terminate:true`、明确回复最多一次 repair，均避免不必要的工作。修正了 README 将 cache 命中描述成“不重复计费”的误导措辞。

## 过度防御判断

确实可删的是交互 Pi 启动器的自动安装与版本强制，已删除。payload 观察也从带任意长度上限的 FIFO 简化为当前请求的最后一次观察。没有证据支持大规模移除其余防护：Telegram create 的 unknown/no-retry、SQLite handoff/幂等、完整 stream deadline、run_js 子进程与 VM 边界、图片能力和 reasoning 预检都有真实失败路径。删除这些会放大重复发送、挂起或费用风险。

## 验证与上线

- Pi 0.86.0 下 `bun test`：196 pass、0 fail；类型、lint 与文档校验通过。`/status` 追加回归覆盖无 payload hook、同请求多次 hook、图片和摘要分项、零值图例。mdBook 使用仓库 CI 固定的 0.5.4 及 SHA-256 校验。
- 额外验证 launcher 跳过项目 bin、转发含空格参数和退出码、缺少本机 Pi 时明确失败。本机 `bun run pi --version` 为 0.85.1；无模型请求的 RPC 检查确认 `/tg` 已加载。本机 CLI 升级由用户管理；若在该 CLI 中调用当前 Devin 扩展，同样需要满足其 ≥0.86.0 要求。
- 两个 bot 的主模型和摘要均为 `devin/swe-2:medium`，context 图片模式保留。通过既有 `bun run restart` 上线，daemon ready。上线观察只消费正常群流量，不注入测试消息。
- 07:01 UTC 部署 SWE-2 后到下一次重启前，A 完成 16 次请求、8 次公开发送，B 完成 10 次请求、8 次公开发送；未见 provider 错误或重试，最长记录延迟约 7 秒。`/status` 与 256K 改动已再次通过既有 restart 上线，IPC 确认两者有效窗口均为 262,000。窗口属于 context identity，调整后启用新 epoch，旧 session 文件保留。短窗口不能证明长时间稳定或完整压缩链路稳定。
- 07:24 UTC 上线最终 schema 23 版本；截至 07:27 UTC，当前 epoch 的 A 已完成 2 次请求、2 次公开发送，B 完成 1 次请求、1 次公开发送，另有一次成功 reaction。A/B 记录平均延迟约 6.2/4.5 秒，未见错误或重试。两个 bot 的首轮均有完整 system/tools 分项，IPC 使用 `/status` 的共享渲染确认五项图例恢复。没有运行付费脚本、注入测试消息或强制压缩；长时间与高占用压缩稳定性仍待后续正常流量验证。
- 07:47 UTC 将本机 Pi package 从 npm 安装切换到用户维护的 `pi-devin` checkout（已推送 `a618466`），重启后 daemon ready，现有 epoch/session 保留。provider 原生 payload hook 的 58 项测试通过、3 项 Windows 专用测试跳过，类型检查通过；覆盖观察、异步替换、原地修改，以及 hook 失败/取消时不发出认证或模型请求。bot 只保留通用 Pi 图片识别和当前请求观测，没有 Devin/SWE-2 名称分支或 transcript 估算兜底。重启后初次观察暂无新的群请求，不把旧 usage 当作新 hook 的实测证据。

本机 `telegram.config.ts` 原本即为 ignored 配置，不包含在 tracked diff 中。
