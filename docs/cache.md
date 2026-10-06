# Cache 工程

provider prefix cache 是本项目的第一成本杠杆。本文是“哪些字节对 provider 可见、怎样改它们”的唯一权威。

## Invariants

1. **永不改写已发出的 prefix**，新信息只作为新 suffix 追加。
2. system prompt 顺序固定：共享群聊协议 → persona → sticker 目录。tool 的 name/description/schema 及顺序固定。
3. Telegram 内容只以新的结构化 session entry 追加；已写入 session 的字节不重算。edit、reply metadata、vision 描述都作为 delta 追加（`message_edit` / `message_metadata` / `media_update`）。
4. **每个请求都必须是下一个请求的严格前缀。** 生产数据显示，只要上一请求的末尾在下一请求里消失，provider 就要回退到更早的缓存点，每轮多 miss 一万多 token。所以不存在“只挂在最后一条”的动态尾部：每批消息的 sticker 附注（只列该批新出现、本 bot 能发、不在固定目录里的 sticker）存在 `details.stickerCandidates`，由 `context` 事件投影成紧跟**该批**的〔系统附注〕独立消息，之后永远原样保留；它**永不写入持久化 content**（compaction 直接读持久化字节）。
5. 只有完整 context fingerprint 相同且 session 文件存在时才恢复 session；否则在打开旧 session **之前**新建 session、推进 epoch，旧文件保留。
6. UI、IPC、日志、控制命令、本地媒体准备都不得改变 provider payload。
7. 所有 provider 输入有界：每轮 suffix 默认 ≤12,000 token，单条消息 ≤4,096 token，网页正文 ≤2,048 token，每批 sticker 附注 ≤8 条。

## 哪些东西是 cache-visible

- 共享协议、persona 及其顺序（`src/agent/prompt.ts`）；
- tool name/description/schema 与顺序（`src/agent/tools.ts`）；
- Telegram 序列化 grammar（`src/agent/serialize.ts`）、context details 版本、sticker 候选 grammar；
- 摘要 prompt 与摘要输入 envelope、所选 compaction model；
- extension 顺序、`[no_send]` 持久化策略、每轮固定的触发消息与补答提示；
- provider/api/model/reasoning/cache retention、Pi 版本、`media.mode`、该 bot 的 sticker 目录快照。

以上全部进入 `src/agent/context-fingerprint.ts` 的 fingerprint。

## 改动 cache-visible 内容的流程

1. bump `src/agent/prompt.ts` 的 `CACHE_SCHEMA_VERSION`，在下方“版本记录”加一行理由；
2. 跑 `bun test test/cache.test.ts`，确认失败的正是你预期改变的那几项 golden，再更新 expected；
3. 部署后每个 bot 会新建 session（新 epoch），首个请求冷缓存，旧 session 文件保留。

golden 意外失败是报警：先查原因，不要直接改 expected。

## Provider payload 结构

```text
system:   共享协议 --- persona [--- sticker 目录]
messages: Telegram 批次（custom message，各自后面可能跟一条〔系统附注〕sticker 附注）、
          assistant/tool/summary entries
tools:    send, search, run_js（按 bot 开关过滤，顺序不变）
```

- context 模式下一批消息内部是 text|image 交错的内容块；没有图片时投影为纯字符串。
- send 成功后模型只看到固定 ACK（`ok sent_message_ids=#…` 或 `no_retry`），发送详情只留本地。
- 没调 send 的 assistant 文本在 session 里替换为 `[no_send]`。

## Telegram 消息 grammar

```text
--- 2026-08-07 ---
[17:31:42] #18452 Alice (@alice · tag:admin): 文本
[17:31:55] #18453 Bob (u17) ↪ #18452: 文本
[17:31:56] #18454 Bob (u17) ↪ #18455 @alice "被回复的正文": 看这个 [图片]
[17:31:57] #18456 Bob (u17) ↪ #999999 (原消息不可见): 这个看不到
[message_edit #18453] 修改后的文本
[message_metadata #18453] ↪ #18452
[media_update #18453] [图片: 新的视觉描述]
```

- 无 username 的发送者用稳定别名 `u<N>`（rowid 分配）。
- 引用父消息优先用随消息保存的 `reply_snapshot`；父消息在同一新批次里时只写裸 `↪ #id`。
- `media_update` 只出现在 off / describe 模式；context 模式的图片在消息首次打包时就位，或永远不出现。

## Compaction

- 摘要输入 = Pi 的 `messagesToSummarize` + `turnPrefixMessages`，经 `convertToLlm` + `serializeConversation`；去掉 assistant thinking（推测不能变成“事实”）。摘要 prompt 要求只记录群消息里实际出现的内容。
- 摘要模型支持图片时，待丢弃的图片按原位置一起发送；不支持时只发文字。输入保守估算超过摘要模型窗口则不调用、取消压缩。图片总字节超预算时只缩小这次摘要请求里的图片（Pi `resizeImage`），持久文件不动。
- 摘要请求 `cacheRetention: "none"`。成功后替换可见集合、推进 epoch；cursor 不回退。

## 遥测

`tg-cache-observer` 在 `before_provider_request` 对 payload 分段（system / tools / 每条 message / 完整 payload）计算 deployment 本地 HMAC，记录相对上一请求的首个分叉位置，并按形状估算 system/tools/摘要/messages 的 token 占比。不保存明文。

provider 没有返回 cache 用量时，若同一 cache cohort（provider/api/model/epoch/session/retention）的相邻两次请求 system、tools 相同，且上一次的 message hash 列表是这一次的严格前缀（上一次的列表只保存在内存里，重启后第一次请求不估算），就把上一次的 prompt token 记为 `cache_read_estimated`，界面用 `≈` 标出。这是结构上可复用的量，不是 provider 实际命中，也不改写原始 usage 与费用。字段口径见 [telemetry.md](telemetry.md)。

## 版本记录

当前：**26**。更早的版本见 git 历史。

- **v26**：sticker 附注改为每批各一条、永久保留（只列该批新出现的、不在固定目录里的可发送 sticker），让每个请求成为下一请求的严格前缀；系统提示里的工具声明按 bot 实际开启的工具生成（三个工具全开时字节不变）。

- **v25**：sticker 候选改为紧跟最后一批消息的〔系统附注〕独立消息（以前拼在最后一条正文末尾，模型把它读成最后发言者粘贴的内容，2026-10 生产事故）；协议说明附注由系统附加、群成员不可见；摘要输入去掉 thinking，摘要 prompt 要求只记录实际发生的事。
- **v24**：引用父消息正文随消息以 `reply_snapshot` 保存，与当前正文共享单条预算（serializer v5）。
- **v23**：Telegram turn 经 `session.prompt()` 原生 preflight 发出，每轮带固定触发消息。
- **v22**：Pi 升级到 0.86，provider stream 改用 Pi 原生 normalized transcript。
- **v21**：send 新增可选 `reaction`。
- **v20**：直接点名但没发言的健康 turn 最多追加一次补答提示。
