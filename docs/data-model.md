# 数据模型

> 描述当前 schema 真正表达的内容。schema 变化时同步更新。

存储：SQLite（WAL），默认单文件 `data/agent.db`。`messages` 是最新读模型；`message_events` 是 provider-facing 的不可变消费源。

## Telegram source 与读模型

### raw_updates

- `(bot_id, update_id)` 主键，保存完整 Telegram update JSON，用于去重、诊断和 replay。
- retention 默认 30 天；poller offset 只有 durable transaction 成功后才推进。

### telegram_control_messages

- `(chat_id, message_id)` 主键，永久保存 control command/reply 的排除身份，与 telemetry 保留期独立。
- 启动迁移一次性从历史 `agent_events` 的 control claim/reply 回填现存身份，并记录 `control_identity_migrated`；后续读写只有本表。此前已被 retention 删除的身份无法凭空恢复。

### messages

- `(chat_id, message_id)` 主键；多个 bot 看到同一群消息只保留一条 canonical 最新投影。
- 保存 sender、reply/quote/forward、text/caption/entities、bounded Rich Message source、edit time 与 media identity。
- `reply_to_sender_id` 是 Telegram 嵌入父消息 sender 的有界 snapshot；缺失时 router 可查询 canonical parent。
- Rich Message source 上限 256 KiB；`text` 是确定性、最多 32,768 code points 的 plain projection。IPC/Pi/provider 不接收 raw source。

- `idx_messages_media_identity` 对非空 media 的 `CAST(json_extract(media, '$.file_unique_id') AS TEXT)` 建部分表达式索引；media lifecycle 使用完全相同的 TEXT 表达式按身份查找，避免每个文件重扫消息历史。

### message_revisions

- `(chat_id, message_id, edit_date)` 主键，保存被替换版本的 text/caption/entities/rich source。
- revision key 使用被替换版本自己的时间：原始版本用 `date`，后续版本用当时的 `edit_date`。

### message_events

- `ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT` 是全局单调位置；`event_key` 唯一保证 replay 幂等。
- `(chat_id, ingest_seq)` 索引是 agent 增量读取主路径；另有 message/时间索引用于 obligation 与 retention。
- kind 为 `message | edit | metadata | media_update`。payload 是该事件发生时的 bounded snapshot；旧 event 不因 canonical row、vision 或 edit 改写。
- message insert、edit 和 reply metadata enrichment 由事务内 trigger 追加；vision 模式下非空 vision completion 追加独立 `media_update`，context 模式不追加媒体 event——图片以 image 内容块随所属 message event 一起进入 provider context。schema v16 migration 是纯 additive（只增列），不删除或改写任何历史 event。
- 旧库 migration 从 canonical `messages` backfill baseline event，并把已知 bot cursor 初始化到 backfill high-water，避免把历史当 fresh context 重放。

## 每 bot context 与 routing 状态

### bot_cursors

- `(bot_id, chat_id) → consumed_seq`，表示业务消费到的 `message_events` high-water。
- cursor 只单调前进；compaction、visibility replacement 与 epoch 轮换不得回退它。

### bot_visible_messages

- `(bot_id, chat_id, message_id)` 主键，并记录 `context_epoch`。
- 只表示完整消息内容当前真实存在于 Pi context；delta 或被预算跳过的 event 不会伪造 full-message visibility。
- 成功 send 返回的本 bot message id 可加入 visibility。成功 compaction 按 structured retained details 替换整组；新 session 清空旧 epoch visibility。

### bot_session_manifest

- 每 bot 保存 `session_id`、`session_file`、完整 `context_fingerprint` 与创建时间。
- runtime 在 restore 前计算 fingerprint；只有 fingerprint 相同且文件存在才 resume。mismatch 保留旧 session 文件并原子指向新 session。

### reply_obligations

- `(bot_id, chat_id, message_id)` 主键，只保存必须交给目标 bot 的 direct human address identity（explicit @mention / reply / 配置名称点名），不保存正文。
- canonical ingest/enrichment 与 reply obligation 在同一 transaction 提交；explicit/name obligation 由 runtime trigger 在消息尚未可见时幂等创建（INSERT OR IGNORE）。
- runtime 每次有界读取最多 64 条；只有 session 中的结构化 context commit marker 证明 delivery 后才删除。crash/restart reconcile 幂等。

### routing_claims

- `(chat_id, message_id, bot_id, route_version)` 主键，记录 reason、status 和 timestamps。
- insert/enrichment/replay 都通过 durable claim 防止同一 bot 重复启动。pending/nonaccepted claim 可重取；accepted started/coalesced 是永久抑制证据。

### bot_state / daemon_state

- `bot_state` 保存 per-bot epoch、Telegram update offset 与 bot identity（`bot_user_id` / `bot_username`）；legacy `exposed_ids` migration 后删除，不再承担 context 状态。routing/cooldown 的运行时调整不写 DB——`/set` 直接写穿 `telegram.config.ts`（见 `docs/architecture.md` 配置节）。
- `daemon_state` 保存 deployment-wide router secret、schema/cache version 等 singleton metadata。
- bot id 均为 `TEXT`，配置定义实际 bot 集合，代码不假设 A/B。

## 媒体、agent 与 telemetry

### media / media_file_ids

- `media.file_unique_id` 是共享身份；`media_file_ids(bot_id,file_id,file_unique_id)` 是 bot-specific 可发送能力。
- short id 由 rowid 单调分配；不能用 `COUNT+1`。
- `vision`（JSON `{model,kind,text,at}`）保存 vision 模式的文字描述，`context_files`（JSON `[{name,mime}]`）保存 context 模式派生图片引用；两者都按 identity 持久化并跨 bot 复用，同一 identity 只识别/准备一次。Sticker 的 `mime` 规范化为 `image/webp`、`application/x-tgsticker` 或 `video/webm`，供 catalog 标注格式；可发送性仍以 bot-specific mapping 为准。≤1 MiB static display image与≤20 MiB video source先写0600临时文件再同目录rename；bytes与绝对path不进SQLite，`local_path`只保存当前`data/media`内的cache-relative basename。daemon启动按basename迁移旧绝对值，缺失或不支持的目标清空；video path与`context_files`派生图片只供本地抽帧/投影读盘，不进入IPC。
- `local_path` 与 `context_files` 都是可再生cache指针，不是媒体事实。任一当前配置bot的visible message、pending reply obligation或未消费非`media_update` event构成活跃引用；成功compaction提交visibility后最多清理256个无引用identity：source与派生图片一起unlink，两列同时置空，其他失败保留以便重试；启动backfill也只恢复仍有活跃引用的static display缺口。回收不删除media row、vision结果、short id、format、file mapping、canonical history或session；重新需要时可下载source且不重付已有vision结果，或重新准备派生图片。

### agent_events

- append-only 本地行为流：assistant/tool/vision/usage/compaction/error/send/control/context commit 等；context 模式媒体准备失败记 error（`stage=context_media`），不阻断打包，消息仍以纯文本占位进上下文。
- unpublished assistant prose 可以留在本地审计，但 provider session 仅保留 `[no_send]`。
- 一次agent run的原始assistant/tool/send事件用payload内的`activity_id`关联；settle时另追加一条有界`agent_activity`作为TUI单卡投影。原始行仍是debug authority，timeline只隐藏带`activity_id`的新式原始行，不重写旧历史。
- error/send/vision telemetry 使用固定 category 与 bounded fields，不保存 token、正文、prompt、response、完整 URL、path 或 stack。

### llm_runs

- 每次 provider response 记录 usage/cost/latency/epoch、thinking/send耗时，以及 provider/api、session id hash、cache retention、system/tools/messages/full payload HMAC 与首次 divergence 位置。`system/tools/compacted_history/message_tokens`保存按payload形状归一到实际provider总token的分段估算；`cache_read/cache_write/cache_miss` 保留 provider 原值。
- 同时记录 trigger message、public send count、vision calls（vision 模式）、本轮附加进上下文的图片数 `images_attached`（context 模式）、tool follow-up rounds、input event 数、保守 token estimate 与 rows scanned。schema v16 migration 只新增 `images_attached` 列（additive），旧 `vision_calls` 列保留。
- status 的 lifetime totals 聚合**当前保留行**（含 compaction）；current context 只取最新 `compaction = 0` 主对话 run，不累计 occupancy。字段和公式以 `docs/telemetry.md` 为准。

## 其他表

- `aliases`：`(chat_id,user_id) → u<N>`，为无 username sender 提供稳定别名。
- Telegram control 的排除身份存于 `telegram_control_messages`；`agent_events` 只保留可过期的行为审计。

## Retention 与安全删除

daemon 启动时执行一次、之后每 24 小时执行 maintenance，并做 passive WAL checkpoint/optimize。默认：

- `agent_events` 与 `llm_runs`：90 天；
- `raw_updates`：30 天；
- `message_events`：365 天。

旧 `message_events` 只有在 `ingest_seq <=` 该 chat 所有已知 bot cursor 的最小值，且没有 reply obligation 引用该 message 时才删除。canonical `messages`/revisions/media/session 文件不由这条定时 retention 清理；可再生的`media.local_path`与`context_files`派生文件另由成功compaction后的引用回收处理。

## ID / dedupe 边界

- update：`(bot_id, update_id)`；raw/canonical/event/obligation 在同一 transaction 内提交，失败整体回滚。
- canonical message：`(chat_id, message_id)`；second-bot duplicate 只允许幂等 enrichment。
- provider event：唯一 `event_key` + 单调 `ingest_seq`；edit 与 vision 模式 media completion 追加 delta。
- bot 自发消息：Telegram send result 立即 normalize/insert，随后 poller 副本按 canonical/event key 去重。

LLM 序列化 grammar 与 fingerprint 边界见 `docs/cache.md`。

## 非SQLite本地日志

`data/daemon.log`不是业务表，也不是恢复authority。它是schema v1 JSONL side channel，固定8 MiB后轮转并保留`.1`–`.3`，文件0600；debug报告最多读当前文件尾64 KiB。字段、隐私和关联契约见`docs/engineering/debugging-guide.md`。SQLite retention与log rotation彼此独立。
