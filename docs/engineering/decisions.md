# 设计决策与事故记录

仍然有效、且不看代码容易做错的结论。每条写清“做了什么、为什么”；过程记录留在 git 历史，新的长期结论直接加到这里。

## Pi 集成

- **`streamFunction` 包装是官方注入形态。** `Agent.streamFunction` 是公开可变字段；`createAgentSession()` 不接受 streamFn，只能事后包一层来注入 `cacheRetention`、timeout 和 provider watchdog。升级 Pi 必须验证这一包装仍生效（`src/agent/runtime.ts`）。
- **扩展抛异常时 Pi 会退回默认摘要器。** 所以 `tg-compaction` 的任何失败都返回 `{ cancel: true }`，绝不 throw（`handleBeforeCompact`）。
- **图片预算必须在 Pi 准备压缩之前换算。** 文字小于预算时 Pi 在触发 `session_before_compact` 之前就返回，钩子来不及；所以在 `agent_end` / `compact()` 前临时调整 `keepRecentTokens`。
- **升级 Pi 时复核的行为差异。** `COMPACTION_SUMMARY_PREFIX` 不再导出（`src/agent/extensions/cache-observer.ts` 的本地常量）；`context` handler 收不到 system message；每轮用 `sendCustomMessage(batch, { triggerTurn: true })` 启动：Pi 1.4.0 的 custom 触发与 `prompt()` 走同一个 `_prepareRun`（含压缩检查），但不校验认证、正在 streaming 时会改为 steer 并立即返回，所以 runtime 在调用前先检查 `isStreaming`。
- **脚本执行用 Pi 原生 codemode，不自建沙箱。** 自建的 `run_js`（子进程 + bubblewrap）已删除；QuickJS VM 的边界由 Pi 维护，本仓库只加宿主侧约束（脚本图片不进 session；脚本里的 `send` 不结束本轮）。需要真实命令行时走每 bot 的 rootless Docker 工作区，而不是放宽 VM。
- **2026-11-01 审计确认仍需自写、不能换成 Pi 的部分**：摘要器（Pi 模板固定英文、不收图、保留 thinking）、`provider-guard`（Pi `timeoutMs` 不是整流截止）、`session-trim`（无公开 API）、任务 RPC 帧（`RpcClient` 写死 `spawn("node")`）、`cache-observer` 的 miss 估算（Pi 的 `core/cache-stats` 未导出）。不采用：运行中换工具集 / `context_edit` / 会话内 `setModel`（改写前缀）、skills 与 prompt templates（加 system 字节）。
- **bot session 不加载项目或用户 extension**（`noExtensions`），shared `ModelRuntime` 只加载用户级已安装的 provider extension 以获得模型目录与认证。

## 正确性边界

- **发到群里的消息一律不用 Telegram Rich Message。** 部分群友的客户端没更新，看不到 Rich Message，而 Bot API 不会因此报错，没法退回。bot 发言和 `/status` 都走本地 Markdown → entities（`src/telegram/markdown.ts`）的经典 `sendMessage`。收到的 Rich Message 仍会被解析成纯文本给模型看。
- **Telegram create 是不可回滚的提交点。** 只有确定性 4xx 且尚无任何提交时才把错误还给模型；其余一律结果未知、不重发。这是重复消息与漏发之间有意的取舍。
- **概率路由 busy/cooldown 时跳过，不改投。** 改投会让概率分布依赖运行时状态，并放大调用量。
- **最近 assistant 失败时取消阈值压缩。** provider 故障期间叠加摘要请求只会把一次故障放大成多次付费失败；overflow 恢复仍走 Pi 原生路径。
- **进程只交给 systemd 托管，不自带控制器。** 自写的 start/restart 会在 systemd 之外另起一个 daemon（SIGTERM 是干净退出，systemd 不会接管），两个 poller 抢同一 token；pid 锁只剩“记录的 pid 还活着就拒绝启动”。
- **不迁移旧数据库。** 只有一个生产 deployment 且已是当前 schema；旧库直接报错，比维护迁移阶梯更简单、更不容易出错。

## 成本

- **相同轮次下最大的省钱点是“严格前缀”。** 2026-10-06 实测：同一轮内的后续调用（上一请求是严格前缀）平均只 miss 约 780 token；而新一轮开始时上一请求的最后一条（旧的 sticker 候选）消失，即使间隔不到 30 秒也平均 miss 约 13,600 token，而新增内容只有约 1,000 token。所以任何“每请求重建、只挂在末尾”的动态内容都会让每轮多付一大段未缓存输入（schema v26 修复）。
- **零单价不等于免费。** 部分 provider（Devin/SWE-2、antigravity）在 catalog 里四项单价为 0，`llm_runs.cost` 无法反映真实账单，以 provider 账户为准。
- **更大的 context window 不一定更省。** 推迟压缩会提高每轮输入；降低阈值会增加摘要与冷缓存次数。调整前后用 `llm_runs` 实测比较，不凭参数大小下结论。
- **本地 cache 估算（`≈`）只证明结构可复用**，不证明 provider 命中，也不参与费用计算。

## 生产事故

| 时间 | 现象 | 根因 | 修复 |
|---|---|---|---|
| 2026-09-16 | context 模式几乎每轮都压缩却不缩小 | 图片只在 details 里，Pi 的 chars/4 切点把它们算 0 | 压缩前按每张 1,100 token 换算保留预算 |
| 2026-09-16 | 遥测把 system prompt 算进历史 | 部分 adapter 用 `role: "developer"` 放 system | observer 把 `developer` 归入 system |
| 2026-09-16 | 429 后被 @ 的消息被标记已回复 | Pi 重试耗尽后正常 resolve turn | 失败 turn 保留义务、不写零用量行 |
| 2026-10-04 | 约 20 分钟不回复 | 图片超过字节预算，preflight 压缩连续失败 | 压缩失败时本轮不发请求、保留义务；摘要图片按预算缩放；HTTP 413 进入 Pi overflow 恢复 |
| 2026-10-06 | bot 反复说群友“泄露了它的 sticker 列表” | 候选列表拼在最后一条消息末尾被当成群友发言；摘要把 bot 的推测写成事实，后续摘要不断继承 | 候选改为〔系统附注〕独立消息（schema v25）；摘要去掉 thinking；新增 `/new` 用于重置被污染的 session |
