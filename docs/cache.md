# Cache 工程

本文是 provider context、cache identity 与 compaction 的当前权威说明。

## Invariants

1. 稳定 prefix 的首字节始终来自共享群聊协议，之后才是 persona；固定顺序的 tool name、description 与 parameter schema 属于同一 cache cohort。
2. Telegram 消息正文只能以新的结构化 session entry 追加，不得改写；recent sticker candidates是唯一例外，它不属于正文，投影时会从旧entry移除并只放在当前最后一批消息后。context 模式下媒体的图片块随消息事件一同首次写入，此后同样不可变。
3. `messages` 是 UI/canonical 最新读模型；provider 只消费不可变 `message_events`。edit、metadata enrichment 与 vision 模式的 vision completion（`media_update`）都追加 delta；context 模式的媒体没有事后 delta——图片在事件首次打包时就位或永远缺席。
4. 已消费位置与当前可见性分离：`bot_cursors.consumed_seq` 只单调前进，`bot_visible_messages` 可在成功 compaction 或 session 轮换时替换。
5. 只有完整 context fingerprint 相同且 manifest 指向的 session 文件存在时才恢复 session。cache-visible 身份改变必须在 restore 前创建新 session/context epoch。
6. UI、IPC、日志、operator command 与本地媒体准备不得改变 provider payload。
7. provider 输入和工具输出必须有界；不能把 raw update、Rich Message JSON 或无界历史塞入 context。sticker catalog 以 ≤`STICKER_CATALOG_MAX` 条 `s<id>: <emoji> <描述>` 行固定进 prefix；最近上下文候选最多 8 条，只能追加在本轮动态 suffix 最后。

## CACHE_SCHEMA_VERSION

当前：**17**。

v17 收敛 sticker 的模型可见文本并关闭 context 模式的描述注入。消息行 sticker 占位删掉 ` set:<集合名>` 元数据（serializer v4：有描述 `[sticker 😺: 描述]`，无描述 `[sticker 😺]`，emoji 也缺时 `[sticker]`；图片块或描述已紧随其后，集合名是纯噪音）。sticker 目录块与近期上下文候选统一为 `s<id>: <emoji> <描述>` 行：目录头部精简为 `# Sticker 目录`（发送规则由 send 工具 description 承载），候选头部改为 `可发 sticker（近期上下文）：`，描述沿用持久化 vision 文本（`media.vision` JSON 的 `text`，空白压缩、≤60 字符），缺失时逐级降级为 `s<id>: <emoji>`、`s<id>`；set 名与 format 不再出现在任何模型可见文本；send 工具 sticker 参数描述里的候选块引用同步为新名（tools golden 随 v17 更新）。catalog snapshot hash 纳入描述文本，描述落地即开新 epoch。context 模式不再产生任何 `media_update` 事件：live 路径本就只在 vision 模式运行，旧 vision 缓存的 ingest 回放与 bot 自发 sticker 的持久化路径改为按模式 gate；已持久化的历史事件字节不变，vision 模式行为完全不变。升级会为每个 bot 创建新 epoch，旧 session 文件保留。

v16 引入双媒体模式（`media.mode: "vision"` 默认 / `"context"` opt-in）：共享协议的媒体占位符一行改为同时覆盖两种形态（vision 模式占位符内联持久化文字描述 / context 模式占位符之后紧跟该媒体的实际图片），context fingerprint 新增 `mediaMode`——切换模式即开启新 context epoch，旧 session 不跨模式 resume。上下文扩展 details 升级 v4 新增 `blocks`（text|image 交错，供 context 模式投影 image 内容块；vision 模式 resolver 不接线，投影保持纯字符串）。vision 模式的 provider grammar 不变：message segment 仍 pin `resolveVision:false`，描述仍以 `media_update` delta 追加，event serializer hash 不变。图片只随新 event 追加进 suffix，不改写已有 prefix。升级会为每个 bot 创建新 epoch，旧 session 文件保留。

v15 在共享协议末尾增加「可用工具」声明（search / run_js / send 三个工具及被问能力时的如实回答规则），修复模型对自身工具能力不自知、被问"能不能搜索/查资料/看网页"时误答的问题。trade-off：声明是双 bot 共享 prefix 的一部分，若某 bot 关闭工具开关（如 `tools.search: false`），需同步评估此声明是否仍成立——它假设三个工具都可用，与 per-bot 开关配置存在潜在不一致，会破坏共享 prefix 假设。升级会为每个 bot 创建新 epoch，旧 session 文件保留。

v14 修复引用历史消息的可见性：可见集 walker 不再信任 compaction entry 携带的 `visibleMessageIds`（那是同一 walker 算出的累积并集，clear 永远清不干净），只从 compaction 边界后的活跃窗口内 custom_message 并集恢复可见集；引用渲染对纯媒体父消息输出媒体占位（`[图片]`/`[sticker 😺]`/`[video]` 等，事件日志路径 `resolveVision:false` 不触发 vision 表 live lookup），父消息缺失时追加 `(原消息不可见)` 标记。升级会为每个 bot 创建新 epoch，旧 session 文件保留。

v13 把最近 sticker 候选从每个历史 Telegram entry 的永久正文拆为结构化字段；context 投影只在最后一个 Telegram batch 后追加一次候选，因此历史形态从 `msg1+candidates, msg2+candidates, msg3+candidates` 变为 `msg1, msg2, msg3+candidates`。这会让相邻请求从上一轮候选位置分叉，但把候选总量从随turn线性增长降为恒定最多8条；对当前缺少provider cache usage的deployment，选择显著更小的64K输入。主模型有效窗口同时固定为64K，Pi估算32K时触发compaction，压缩后按 `compaction_keep_recent` token 预算保留近期原文。升级会为每个 bot 创建新 epoch，旧 session 文件保留。

v12 修正 custom Telegram message 的 compaction 输入：严格按 Pi 官方流程先调用 `convertToLlm()`，再把 provider messages 交给 `serializeConversation()`。旧实现用 cast 绕过类型并直接序列化 `AgentMessage[]`，可能让 Telegram context 在摘要输入中消失。升级会为每个 bot 创建新 epoch，旧 session 文件保留。

v11 给固定 catalog 与最近上下文 sticker 候选增加 `static` / `animated` / `video` 格式，并明确 `send.sticker` 支持三种格式。格式来自 Telegram `is_animated` / `is_video`，以 MIME metadata 持久化；catalog fingerprint 包含它。升级会为每个 bot 创建新 epoch，旧 session 文件保留。

v10 恢复一个更窄的动态 sticker 能力：从当前 bot generation 真正可见的消息中选最近 8 个不同的用户 sticker，只保留该 bot 有 `file_id` mapping、因而可发送的 identity，并把 short_id、emoji 与有界描述追加到本轮 `telegram_context_v2` provider text 的最末尾。它不扫描全库做语义 top-K，也不改写任何已持久 entry；候选块若超出本轮 suffix budget 就整体省略。`send.sticker` 的 tool description 同步接受固定目录或最新候选块中的 short_id。

v9 合并以下有意的 provider-visible 变化：固定 sticker catalog 以 identity-only 形式（set + emoji + short_id，不含 vision 文本）固化进 system prompt、删除每轮 top-K 检索 suffix 与 catalog vision 回填，shared protocol 去掉双 bot 硬编码假设，send/search/run_js description 打磨。fingerprint 的 catalog snapshot 同步改为只 hash identity 字段，异步 vision 回填不再令前缀失效。

v8 合并以下有意的 provider-visible 变化：共享 protocol 置于 persona 前、`telegram_context_v2` 结构化消息、immutable edit/metadata/media delta、动态 sticker top-K，以及 unpublished assistant prose 的 `[no_send]` 持久化策略。

cache-visible protocol 包括：

- shared protocol 与 persona 的内容及顺序；
- tool name、description、parameter schema 与顺序；
- Telegram serializer、最近上下文 sticker 候选 grammar 与 custom-message details 版本；
- compaction prompt、details 与所选 compaction model；
- extension 顺序和 assistant persistence policy；
- provider/api/model/reasoning/cache retention；
- Pi 版本及当前 bot 的 sticker catalog identity snapshot。

`CACHE_SCHEMA_VERSION` 是 fingerprint 中的强制失效字段，不是恢复 session 后再补记的一项 telemetry。任何上述内容变化都必须先 bump version、更新本文件与 golden；runtime 在打开旧 session **之前**计算 fingerprint，不匹配时保留旧文件、创建新 session 并推进 epoch。

## Schema history

每次 bump 的一句话理由（追溯细节见 git 历史）：

- v1：初始 cache grammar——日期分隔 / `#id` / `@username` / `↪` 引用 / 媒体占位的确定性消息序列化，persona + 共享 protocol 固定结构。
- v2：sticker 目录块首次进入 system prompt。
- v3：sticker 候选按 bot 可发送性隔离，prefix 移除当前 bot 不可发送的目录项。
- v4：tool/persona/system 稳定 prefix 修订——send 成功 ACK 固定为 `ok`、persona 去除与 protocol 重复的 send 教程、toolsHash 覆盖 description。
- v5：send tool description 切换为 Rich Markdown 发送。
- v6：search 工具 schema 增加 `url` 字段与说明（page fetch）。
- v7：send 改为确定性 Markdown → text/entities 转换，message 参数增加 4096 code points 约束。
- v8：共享 protocol 前置到 persona 之前、`telegram_context_v2` 结构化消息、immutable edit/metadata/media delta、动态 sticker top-K 候选、`[no_send]` 持久化策略。
- v9：固定 sticker catalog 以 identity-only 形式固化进 system prompt，删除每轮 top-K suffix 与 catalog vision 回填，protocol 去双 bot 硬编码，tool description 打磨（详见上文）。
- v10：恢复当前可见上下文中最近 8 个、该 bot 可发送的用户 sticker，作为本轮消息后的最终动态 suffix；更新 send tool description。
- v11：固定 catalog、最近候选与 send tool description 显式标注 static / animated / video sticker。
- v12：compaction 先用 Pi `convertToLlm` 投影 custom Telegram messages，再序列化 summary 输入。
- v13：recent sticker candidates只投影在最后一个Telegram batch；主模型有效窗口固定64K并在Pi估算32K时压缩到摘要+最后turn。
- v14：引用渲染对纯媒体父消息输出媒体占位、父消息缺失追加 `(原消息不可见)`；可见集 walker 不再从 compaction entry 的 `visibleMessageIds` 重灌（详见上文）。
- v15：共享协议末尾增加可用工具声明（search / run_js / send 及被问能力时的如实回答规则），修复模型能力自知缺失；trade-off 见上文（per-bot 工具开关与共享 prefix 假设的潜在不一致）。
- v16：双媒体模式——共享协议占位符行同时覆盖 vision 描述与 context 内联图片，fingerprint 新增 `mediaMode`，details v4 新增 `blocks`；vision 模式 grammar 不变（详见上文）。
- v17：sticker 占位删 ` set:` 元数据（serializer v4）；目录/候选统一 `s<id>: <emoji> <描述>` 行，set 名与 format 退出模型可见文本，描述纳入 catalog fingerprint；context 模式不再产生 `media_update`（详见上文）。

## Provider payload 结构

```text
system: SHARED_PROTOCOL + separator + persona [+ separator + sticker catalog（s<id>: <emoji> <描述> 行）]
messages: structured Telegram projections + assistant/tool/summary entries; recent-context sticker candidates only follow the last Telegram projection
tools: [{ name, description, parameters }] in fixed order
```

- context 模式下 Telegram projection 内部是 text|image 交错内容块：每个事件一段文本，媒体事件的图片块紧跟其文本段；vision 模式或无图片的 entry 投影为纯字符串，与历史字节一致（details v4 `blocks`）。
- `src/agent/prompt.ts` 拥有 shared protocol/persona 组装。
- `src/agent/tools.ts` 是 provider-facing 工具参数、调用、错误和终止语义的唯一权威；persona 不复制工具参数表。
- `src/agent/extensions/context.ts` 从 `telegram_context_v2.details.providerText/blocks/stickerCandidates` 投影 provider 内容；旧 entry 只投影消息正文，候选只跟在当前最后一个 Telegram entry 后。恢复 cursor/visible ids 只读 structured details，绝不解析渲染文本。
- `send` 成功后 provider 只看到有界 ACK 与 sent message ids；本地发送详情继续写 SQLite/event。
- 未通过 `send` 发布的 assistant prose 写入本地 `agent_events`，session 中用固定 `[no_send]` 代替；thinking/tool protocol entry 保留。

## Telegram 消息 grammar（serializer v2）

```text
--- 2026-08-07 ---
[17:31:42] #18452 Alice (@alice · tag:admin): 文本
[17:31:55] #18453 Bob (u17) ↪ #18452: 文本
[17:31:56] #18454 Bob (u17) ↪ #18455 @alice [图片]: 看这个
[17:31:57] #18456 Bob (u17) ↪ #999999 (原消息不可见): 这个看不到
[message_edit #18453] 修改后的文本
[message_metadata #18453] ↪ #18452
[media_update #18453] [图片: 新的视觉描述]
```

`media_update` 行只出现在 vision 模式（描述持久化后追加的 delta）；context 模式没有独立 delta 事件，媒体事件首次追加时占位符文本段之后即紧跟该媒体的 image 内容块（准备好时）。

- message event 保留原有日期、时间、sender、reply、quote、forward 与媒体占位符语义。
- 引用父消息不在可见集时渲染短引用：文字父消息引 `@who "snippet"`（≤40 字）；纯媒体父消息引媒体占位（`[图片]`/`[sticker 😺]`/`[video]` 等，事件日志路径 `resolveVision:false` 不触发 vision 表 live lookup，fresh-batch 路径可渲染已持久化描述）；父消息缺失（含 external_reply 跨群引用）追加 `(原消息不可见)`。父消息在可见集时保持裸 `↪ #id`。
- message/event bytes 一旦写入 session 就不重算；后续变化使用 `edit`、`metadata`、`media_update`（vision 模式）delta。
- `telegram_context_v2.details` 同时保存 `consumedSeq`、本 entry 的 event refs、`visibleMessageIds`、固定消息 projection 与独立 sticker candidates。
- session 写入成功或启动 reconcile 能从 structured details 证明写入后，SQLite cursor 才前进。provider 失败不会靠文本猜测状态。

## 有界 suffix 与 sticker catalog

- runtime 每轮最多索引读取 256 条近期 event，并额外读取最多 64 条 direct-address obligation event；不扫描整张 `messages` 表。
- direct-address obligation 优先打包；普通 event 从最新端选择后恢复时间顺序。默认 suffix 上限 12,000 tokens，单 event 上限 4,096 tokens，并为输出、reasoning 与 tool follow-up 预留空间。
- 普通溢出 event 可以被 cursor 消费但不标 visible；direct-address obligation 只有在结构化 commit marker 证明交付后才删除。
- sticker catalog 在启动时同步进 DB 后以 `s<id>: <emoji> <描述>` 行（描述为持久化 vision 文本，缺失时逐级降级为 `s<id>: <emoji>`、`s<id>`；按 set 名 + rowid 排序，set 名本身不渲染）固化在 system prompt 尾部；prefix 由配置 + DB catalog 唯一决定，重启间稳定。catalog identity 或描述变化通过 fingerprint snapshot 开新 epoch。
- runtime 另从 `bot_visible_messages` 与本轮新打包消息的并集取最近 8 个不同的用户 sticker；只保留当前 bot 有 mapping 的项。候选独立存储，provider projection会从所有旧 Telegram entry 移除候选，只在当前最后一批消息后追加一次；预算不足时不追加。
- page fetch 先受 8,000 字符本地护栏约束，再受 2,048 provider tokens 上限约束；query 与工具失败输出同样有界。

## 媒体模式与 provider boundary

`media.mode` 选择媒体到达模型的方式：`"vision"`（默认）由辅助视觉模型把媒体描述成文字，`"context"`（opt-in）把图片作为 image 内容块直接交给主模型。两种模式下 voice、audio、非视频 document 与 TGS 动态贴纸都只有文本占位——Pi 0.84.1 只支持 image 内容块，这是硬限制；视频都靠 `ffmpeg`/`ffprobe` 抽帧，缺失时视频在 Telegram 下载前即降级/跳过，不占主对话 token、不阻塞 daemon ready，CLI/operator log/debug 提示安装用途，群内上下文不增加提示文字。

### Vision（默认模式）

Vision 默认关闭；只有显式 `vision.enabled: true` 才会执行。`auxiliary_visual_model` 只选择任务模型，不隐式开启功能。

- foreground 每轮最多 `vision.foreground_media_limit`（默认 2）个 media、deployment 并发 `vision.concurrency`（默认 2）。图片在provider边界占slot；视频在Telegram下载前预留同一个全局slot，并一直持有到本地抽帧和单次vision请求结束，避免多bot并行放大FFmpeg负载。scheduler只有一个FIFO并发门，不维护重启即丢失的小时/每日计数。
- persistent media identity cache（`media.vision`）在 bots 间复用。新的非空结果只追加 `media_update` event，不改写旧 message entry；描述经 additive IPC `vision_update` 与 snapshot/history 的 `mediaDesc` 到达 TUI，都是 provider 外 side channel。
- Telegram下载严格配对bot-specific `file_id`与对应Bot API；回复bot缺mapping时可复用其他已配置接收bot的source。这是provider外的确定性本地准备，不改变消息grammar或主对话每turn token。
- video、animation、video note、video MIME document与video sticker按时长取1–3帧；位置固定为中点、三分点或20%/50%/80%，再在一次独立vision请求中提交全部帧。结果仍只追加既有`media_update` grammar；persistent/cross-bot hit不增加调用。
- `ffmpeg`/`ffprobe`缺失在Telegram下载前成为provider外no-op：无vision调用、无动态provider payload、无主对话token，也不写terminal vision cache；static image vision 不受影响。
- photo/sticker display cache、`media_ready` 与 TUI card 都是 provider 外 side channel。
- compaction 单独使用配置的廉价模型与 `cacheRetention: "none"`；vision/compaction 不继承主模型的 reasoning 默认。

### Context（opt-in）

没有视觉模型调用；主模型直接接收上下文图片。主模型必须支持 image input，否则 daemon 在任何 Telegram 调用前 fail fast（`image_input_unsupported`）。

- 进入上下文的媒体：photo 与静态 sticker（webp/gif 先转 png，再过 Pi `resizeImage` 字节/尺寸双上限）；video、animation、video note、video MIME document 与 video sticker 按时长抽 1–3 帧（中点、三分点或 20%/50%/80%），每帧一个 image block。
- 准备在 flush 打包前执行：只有 Telegram 下载与本地转码，零 LLM 调用。每轮最多 `media.max_images_per_turn`（默认 4）个媒体身份，下载/抽帧并发 `media.download_concurrency`（默认 2）。失败只记 `error` event（`stage=context_media`），消息仍以纯文本占位进入上下文。
- 派生图片以 hash basename 写入 `data/media`（`<sha256(fileUniqueId#ctx)>.png|jpg`、视频逐帧 `<sha256(fileUniqueId#frameN)>.jpg`），DB `media.context_files` 记录 `[{name, mime}]`；同一 media identity 跨 bot 只准备一次并持久化复用。
- 每张上下文图片按固定 1,100 token 计入 suffix 预算（`CONTEXT_IMAGE_TOKEN_ESTIMATE`）；超预算或超上限的媒体降级为纯文本占位，被 force-cap 保留的 mandatory event 永远纯文本。图片只随新 event 追加，不存在事后回填，因此 prefix 永不失效。
- Telegram下载严格配对bot-specific `file_id`与对应Bot API；回复bot缺mapping时可复用其他已配置接收bot的source。这是provider外的确定性本地准备，不改变消息grammar。

## Compaction 与 context epoch

- 主模型传给Pi的有效context window为配置的 `context_window`（缺省 65,536，会钳制 Pi catalog 值）；compaction 触发公式为 `contextTokens > contextWindow - reserveTokens`，其中 `reserveTokens = max(16,384, context_window - compaction_threshold)`，所以 threshold 最高生效值为 `context_window - 16,384`（config 校验拒绝超过它的值，避免 requested/effective 静默分叉）。缺省/示例为 65,536/32,768（提前触发，缓冲 Pi 对 CJK token 与上下文图片的估算偏差）；生产可随窗口上调，如 131,072/114,688。`tg-compaction` 用状态导向 prompt 生成不超过800字的摘要，并保留最近 `compaction_keep_recent` token 原文（注意单位是 token 不是 turn：缺省 1 token 连一条消息都装不下，压缩后实际只剩摘要；生产推荐 20,000，约 1-2 个完整 turn 原文）。更早原文不再进入provider，只有摘要仍可见。
- summary 输入使用 Pi 的 `serializeConversation(convertToLlm(messages))`，因此 Telegram custom message 与 Pi 原生消息遵循同一 provider projection。
- 空摘要、provider failure 或 abort 会 cancel；cursor、visible refs 与 epoch 均不伪造变化。
- 成功结果的 structured details 保存当前 `consumedSeq` 与 retained `visibleMessageIds`。runtime 用这些 details 替换 visibility、推进 epoch；`consumedSeq` 永不回退。
- visibility与epoch提交后，provider外observer按所有当前配置bot的visible refs、未消费event与reply obligation，对本地媒体cache做最多256项回收。它清可再生文件、`local_path`与 `context_files` 派生图片，失败不改变compaction结果；startup backfill复用同一引用边界，避免重新下载已回收历史。
- 媒体回收不修改session、summary、message/event serialization或provider payload，因此不改变cache schema，也不增加LLM call/token；派生图片可按 `context_files` 记录随时重建。
- 手工 `/compact` 复用同一边界，不向模型注入 operator 指令。

## Payload 诊断与 telemetry

`tg-cache-observer` 在 `before_provider_request` 对 canonical payload 计算 deployment-local HMAC：system、tools、每条 message 与完整 payload 分段记录 hash，并记录相对上次请求的首个 divergence segment/index/byte offset。SQLite 不保存 plaintext payload、prompt、secret 或 HMAC key。

每次 provider response 还记录 provider/api/model/session hash/cache retention、epoch、context/input/cache read/cache write/output/reasoning/latency/cost、trigger、public send、vision calls（vision 模式）/附带图片数 `images_attached`（context 模式）/tool rounds，以及 input event/token estimate/rows scanned。保留期默认 90 天，因此 UI 的 lifetime 表示**当前 SQLite 保留窗口**，不是永久累计。

若 provider/Pi 返回的 cache read/write 都为 0，telemetry 可对同 cohort 的相邻两次 raw chat payload 做本地严格前缀估算：system/tools 必须相同，前一次完整 message hash 列表必须逐项等于后一次前缀，且 bot/provider/api/model/epoch/session/cache retention 均不变。估算单独写入 `cache_read_estimated`，原始 usage/cost 不改写，UI 用 `≈` 标出；它证明理论可复用结构，不证明 provider 实际命中。该 observer-side 计算不改变 provider payload、cache identity 或 `CACHE_SCHEMA_VERSION`，也不增加 LLM call/token；完整口径见 `docs/telemetry.md`。

2026-08-07 的 50-run DeepSeek 数据按当前统一公式 `R / (↑ + R + W)`（该样本 `W=0`）测得 90.0% cache hit。该数字仅是历史 deployment 样本，不代表当前 schema 版本、其他模型或未来负载；完整字段口径见 `docs/telemetry.md`。

## Golden

`test/cache.test.ts` 当前锁定：

| 项目 | 值 |
| --- | --- |
| schema | `17` |
| zh system | `b2f0432b9b7b` |
| en system | `231c26fbb95b` |
| legacy message serializer | `68a17d6e5c05` |
| immutable event serializer | `4a57de738bf9` |
| tools | `c28a3db01190` |
| compaction prompt | `045a5241fdd7` |
| extension order | `e04f7032d531` |
| context protocol | `2e1c7762b239` |
| sticker catalog block | exact-string lock（`s<id>: <emoji> <描述>` 行，set/format 不渲染） |
| recent-context sticker suffix | exact-string lock（最近、去重、user-only、bot-sendable、与目录同一行语法携带持久化描述、最终尾部） |
| quote reference | exact-string lock（媒体占位 / 事件日志路径 `resolveVision:false` 不带描述 / 缺失标记 / 可见裸引用） |

测试必须 pin `TZ=Asia/Singapore`；`bun test` 自身强制 UTC。若 hash 有意变化，先解释 cache impact，再更新 version 与 golden；不要只改 expected value。
