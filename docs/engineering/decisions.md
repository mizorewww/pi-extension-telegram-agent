# 设计决策与事故记录

仍然有效、且不看代码容易做错的结论。每条写清“做了什么、为什么”；过程记录留在 git 历史，新的长期结论直接加到这里。

## Pi 集成

- **Pi Durable 1.5.0 拥有会话和执行状态。** 本仓库只把 Telegram 事件送入 conversation，保存群聊 cursor、待公开回复等业务状态。会话持久化、排队、steer、重试、压缩、子任务、后台脚本和工具执行都用 Pi 原生实现，不保留旧 AgentSession 扩展链或第二套任务生命周期。
- **模型目录与认证仍走 Pi。** shared `ModelRuntime` 用 Pi resource loader 加载用户级已安装的 provider extension；不加载项目扩展、skills、prompt templates 或 context files。Telegram 人设和固定工具集由本仓库显式配置，不能被工作目录偷偷改变。
- **只保留 Pi 尚未覆盖的 provider 边界。** 1.5.0 的 `timeoutMs` 传给 provider，不保证整个响应流结束；`lazyStream` 也不会抢占不配合取消的迭代器。`guardModels` 用 Chord 截止等待，同时覆盖 generation 和原生 compaction；HTTP 413 归一为 Pi 识别的 `request_too_large`。重试完全交给 Pi，不在包装层重发。
- **摘要采用 Pi 原生结构化模板和当前会话模型。** 不再维护独立摘要模型、中文模板或递归分块摘要器。原生摘要排除 system、图片和 thinking，保留可见文本及工具调用；每条工具结果最多保留 2,000 字符。因此媒体事实要经 hybrid 描述进入文本，不能指望压缩器重新观察原图。
- **原生压缩采用固定预留和有效规划窗口。** reserve 固定为 16,384；向 Pi 提供的 context window 是模型目录、配置窗口、`compaction_threshold + 16,384` 三者的最小值，保留原有阈值语义。原生摘要最多生成 13,107 token，并受模型自身输出上限约束；主回复的输出上限不改。1.5.0 不会把过大的摘要输入自动分块，输入批次仍须有界。关闭提前后台压缩，避免主请求之外的推测性付费调用。2026-11-02 曾有 272 次摘要失败、上下文涨到 314K token 的事故；更换摘要实现不等于消除了输入过大的风险。
- **加密思维签名仍是本地估算的盲区。** Devin `sealed` signature 曾实测约 39K token/请求；Pi 的保留区切点只计 thinking 文本，不计签名。阈值估算可利用最近一次真实 usage，但不能据此声称 `keepRecentTokens` 已覆盖签名成本。成本判断以 provider usage 和账单为准。
- **图片直接使用 Pi 原生 ImageContent。** session 持有图片字节，删除文件引用投影和派生图片缓存。hybrid 按媒体缓存一次描述，需要细节时再看原图；缩图上限仍由接入层限制，防止一次图片工具调用生成过大的 provider payload。codemode 的 `image()` 给模型看，公开发图仍须 `send`。
- **工作区是 rootless Docker，执行协议交给 pi-env。** `RemoteExecutionEnv` 经容器内 `pi-env` 提供原生 read/write/edit/bash。pi-env 本身不是安全沙箱：只读根目录、资源限制、无宿主凭据、只挂载 `/work` 仍是本仓库部署责任；文件公开发送仍检查真实路径、禁止符号链接逃逸并限制大小。
- **公开发送和补答是 Telegram 策略。** 只有 `send` 对群可见。最终 send 单独执行时通过 Pi 原生 terminate 结束本轮；codemode 内嵌 send 可继续工作。健康结束而仍欠直接点名的公开回复时，仅补一次提示；发送结果未知时绝不补发。
- **`/new` 必须等旧工作真正停止。** 先取消并等待 Pi run、压缩与后台任务，再重置 conversation 和工作区；不能只竞速一个超时后切 session，让旧宿主工具继续写入新状态。
- **配置只有一条热写回链路。** Pi schema 校验结构，编辑器类型从同一 schema 推导；保留跨字段与部署约束。Jiti `evalModule` 每次执行最新配置源码，依赖仍走原生加载；`/set`、`/model` 验证临时副本并原子写回。
- **sticker 附注是不可变的请求投影。** 每批候选只保存在 entry metadata，通过原生 `beforeRequest` 插到该批消息后面；之后的请求保留同一位置和字节。附注不写进持久化 user content，原生 compaction 因而不会把它当成群友原话。
- **提示词只补群聊语义。** Pi 原生 tool schema 解释参数，本仓库保留人设、消息 grammar、公开发送规则和源码地址；示例文档不再整份装入每个 system prompt。工具顺序和这些字节仍属于 cache 协议，统一随 `CACHE_SCHEMA_VERSION` 更新。

## 正确性边界

- **发到群里的消息一律不用 Telegram Rich Message。** 部分群友的客户端没更新，看不到 Rich Message，而 Bot API 不会因此报错，没法退回。bot 发言走本地 Markdown → entities（`src/telegram/markdown.ts`），`/status` 走纯文本，均使用经典 `sendMessage`。收到的 Rich Message 仍会被解析成纯文本给模型看。
- **Telegram create 是不可回滚的提交点。** 只有确定性 4xx 且尚无任何提交时才把错误还给模型；其余一律结果未知、不重发。这是重复消息与漏发之间有意的取舍。
- **概率路由 busy/cooldown 时跳过，不改投。** 改投会让概率分布依赖运行时状态，并放大调用量。
- **最近 assistant 失败时取消阈值压缩。** provider 故障期间叠加摘要请求只会把一次故障放大成多次付费失败；overflow 恢复仍走 Pi 原生路径。
- **进程只交给 systemd 托管，不自带控制器。** 自写的 start/restart 会在 systemd 之外另起一个 daemon（SIGTERM 是干净退出，systemd 不会接管），两个 poller 抢同一 token；pid 锁只剩“记录的 pid 还活着就拒绝启动”。
- **不迁移旧数据库。** 只有一个生产 deployment 且已是当前 schema；旧库直接报错，比维护迁移阶梯更简单、更不容易出错。

## 成本

- **相同轮次下最大的省钱点是“严格前缀”。** 2026-10-06 实测：同一轮内的后续调用（上一请求是严格前缀）平均只 miss 约 780 token；而新一轮开始时上一请求的最后一条（旧的 sticker 候选）消失，即使间隔不到 30 秒也平均 miss 约 13,600 token，而新增内容只有约 1,000 token。所以任何“每请求重建、只挂在末尾”的动态内容都会让每轮多付一大段未缓存输入（schema v26 修复）。
- **零单价不等于免费。** 部分 provider（Devin/SWE-2、antigravity）在 catalog 里四项单价为 0，Pi 记录的 cost 无法反映真实账单，以 provider 账户为准。
- **更大的 context window 不一定更省。** 推迟压缩会提高每轮输入；降低阈值会增加摘要与冷缓存次数。调整前后用 Pi usage 与 provider 账单实测比较，不凭参数大小下结论。
- **严格前缀只证明请求结构可复用。** 实际命中看 provider 返回的 cacheRead/cacheWrite，不能用本地相似度替代命中率或费用。

## 生产事故

下表记录事故发生时的修复；当前机制以以上决策和代码为准。

| 时间 | 现象 | 根因 | 修复 |
|---|---|---|---|
| 2026-09-16 | context 模式几乎每轮都压缩却不缩小 | 图片只在 details 里，Pi 的 chars/4 切点把它们算 0 | 压缩前按每张 1,100 token 换算保留预算 |
| 2026-09-16 | 遥测把 system prompt 算进历史 | 部分 adapter 用 `role: "developer"` 放 system | observer 把 `developer` 归入 system |
| 2026-09-16 | 429 后被 @ 的消息被标记已回复 | Pi 重试耗尽后正常 resolve turn | 失败 turn 保留义务、不写零用量行 |
| 2026-10-04 | 约 20 分钟不回复 | 图片超过字节预算，preflight 压缩连续失败 | 压缩失败时本轮不发请求、保留义务；摘要图片按预算缩放；HTTP 413 进入 Pi overflow 恢复 |
| 2026-10-06 | bot 反复说群友“泄露了它的 sticker 列表” | 候选列表拼在最后一条消息末尾被当成群友发言；摘要把 bot 的推测写成事实，后续摘要不断继承 | 候选改为〔系统附注〕独立消息（schema v25）；摘要去掉 thinking；新增 `/new` 用于重置被污染的 session |
