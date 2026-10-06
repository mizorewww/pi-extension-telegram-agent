# 数据模型

SQLite（WAL），默认 `data/agent.db`，schema 在 `src/db/schema.sql`，启动时幂等执行。早于当前 schema 的库不迁移，`openDb` 直接报错（移走旧库重新开始）。改 schema 必须同步本文。

`messages` 是最新读模型（UI 用）；provider 只消费不可变的 `message_events`。

## Telegram 来源

| 表 | 主键 | 用途 |
|---|---|---|
| `raw_updates` | `(bot_id, update_id)` | 完整 update JSON，去重与诊断；默认保留 30 天，仍被 pending dispatch 引用的不删 |
| `pending_telegram_dispatch` | `bot_id` | 每个 poller 至多一条未交付的 routing/control handoff，与 ingest、offset 同事务写入；回调成功后删除 |
| `messages` | `(chat_id, message_id)` | canonical 最新投影：发送者、reply/quote/forward、text/caption/entities、Rich Message（source ≤256 KiB，`text` 是确定性纯文本投影）、`reply_snapshot`、media JSON |
| `message_revisions` | `(chat_id, message_id, edit_date)` | 被替换的旧版本，key 用旧版本自己的时间 |
| `message_events` | `ingest_seq`（自增），`event_key` 唯一 | 不可变事件流：`message`、`edit`、`metadata`、`media_update`；由 trigger 在同一事务追加 |
| `telegram_control_messages` | `(chat_id, message_id)` | 控制命令与回复的永久排除名单，不受遥测保留期影响 |

- 只更新更大的 `edit_date`；多个 poller 乱序送达的旧 edit 不会回退 canonical。
- 第二个 bot 的副本只能补齐空缺的 `reply_to_sender_id` / `reply_snapshot`，并追加一条 metadata event。
- `idx_messages_media_identity` 是 `CAST(json_extract(media, '$.file_unique_id') AS TEXT)` 的表达式索引，media lifecycle 必须使用完全相同的表达式。
- trigger 用 `CREATE TRIGGER IF NOT EXISTS`；改 trigger body 需要新库或手工 DROP。

## 每 bot 状态

| 表 | 主键 | 用途 |
|---|---|---|
| `bot_cursors` | `(bot_id, chat_id)` | 已消费到的 `ingest_seq`，只增不减 |
| `bot_visible_messages` | `(bot_id, chat_id, message_id)` + `context_epoch` | 当前 context 真正包含完整内容的消息；压缩或换 session 时整组替换 |
| `bot_session_manifest` | `bot_id` | 当前 session id、文件路径、完整 fingerprint |
| `reply_obligations` | `(bot_id, chat_id, message_id)` | 直接点名后待回复的消息身份（不存正文） |
| `routing_claims` | `(chat_id, message_id, bot_id, route_version)` | 防止同一消息对同一 bot 重复启动 |
| `bot_state` | `(bot_id, key)` | epoch、Telegram offset、bot user id / username |
| `daemon_state` | `key` | router secret、当前 cache schema 等单例 |

- 新配置的 bot 没有 cursor 时，默认从 `message_events_backfill_max_seq`（若存在）开始，不重放更早历史。
- daemon 启动删除已不在配置中的 bot 的 cursor 与回复义务，否则它们会永久卡住 `message_events` 的保留期清理。

## 媒体、事件与遥测

- `media`：`file_unique_id` 是共享身份；`short_id` 由 rowid 分配（不能用 COUNT+1）；`vision`（vision 模式描述 JSON）与 `context_files`（context 模式派生图片 `[{name, mime}]`）按身份持久化、跨 bot 复用；`local_path` 只存 `data/media` 下的文件名。
- `media_file_ids(bot_id, file_id, file_unique_id)`：bot 专属的可发送/可下载能力。
- `aliases(chat_id, user_id) → u<N>`：无 username 发送者的稳定别名（rowid 分配）。
- `agent_events`：只追加的本地行为流（assistant 文本、thinking、tool、send、错误、压缩、控制审计……）。一次 agent run 的原始事件带 `activity_id`，结束时另追加一条 `agent_activity` 作为 TUI 卡片。不存 token、prompt、完整 URL 或路径。
- `llm_runs`：每次成功 provider 响应一行：usage、费用、延迟、thinking/send 耗时、provider/api/model、session hash、payload HMAC 与首个分叉位置、上下文构成估算、trigger、公开发送数、图片数等。口径见 [telemetry.md](telemetry.md)。

## 保留期

启动时和之后每 24 小时执行：`agent_events` 与 `llm_runs` 90 天，`raw_updates` 30 天，`message_events` 365 天。旧 `message_events` 只有在所有已配置 bot 的 cursor 都已越过、且没有回复义务或 pending dispatch 引用时才删除。canonical 消息、revision、media 行与 session 文件不按时间清理；本地媒体文件由成功压缩后的引用回收处理（见 [architecture.md](architecture.md#媒体)）。

`data/daemon.log` 不是业务数据，见 [debugging-guide.md](engineering/debugging-guide.md)。
