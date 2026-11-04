# 数据模型

Telegram archive 使用 SQLite（WAL），默认 `data/agent.db`，schema 在 `src/db/schema.sql`，启动时幂等执行。每个 bot 的会话、执行队列、任务与用量由 Pi Durable 独立保存在 `data/pi/<botId>.sqlite`。本项目不复制 Pi 的内部表结构或执行状态。

升级保留现有 archive 和不可变事件。旧库中的 `bot_cursors`、`bot_visible_messages`、`bot_session_manifest`、`reply_obligations`、`tasks`、`agent_events`、`llm_runs` 原样保留，停止读写；新库不再创建这些表。`openDb` 只检查仍在使用的 Telegram archive 字段，不要求旧运行态表存在。早于 `messages.reply_snapshot` 的 archive 仍需单独迁移。

`messages` 是最新读模型；进入 Pi 的新输入来自不可变的 `message_events`。已进入 Pi 的历史正文不因后来的 edit、元数据补齐或图片描述而改写。

## Telegram 来源

| 表 | 主键 | 用途 |
|---|---|---|
| `raw_updates` | `(bot_id, update_id)` | 完整 update JSON，去重与诊断；仍被 pending dispatch 引用的不删 |
| `pending_telegram_dispatch` | `bot_id` | 每个 poller 至多一条未交付的 routing/control handoff，与 ingest、offset 同事务写入；回调成功后删除 |
| `messages` | `(chat_id, message_id)` | canonical 最新投影：发送者、reply/quote/forward、text/caption/entities、Rich Message（source ≤256 KiB，`text` 是确定性纯文本投影）、`reply_snapshot`、media JSON |
| `message_revisions` | `(chat_id, message_id, edit_date)` | 被替换的旧版本，key 用旧版本自己的时间 |
| `message_events` | `ingest_seq`（自增），`event_key` 唯一 | 不可变事件流：`message`、`edit`、`metadata`、`media_update` 与指定 bot 的 `note`；`message_id` 是关联消息或 0 |
| `telegram_control_messages` | `(chat_id, message_id)` | 控制命令与回复的永久排除名单，不受保留期影响 |
| `messages_fts` | `rowid`（= `messages.rowid`） | FTS5 trigram 外部内容索引（text、caption），由 trigger 同步；支持 `tg_messages` 的 3 字以上子串查询与 relevance 排序 |

- 只更新更大的 `edit_date`；多个 poller 乱序送达的旧 edit 不会回退 canonical。
- 第二个 bot 的副本只能补齐空缺的 `reply_to_sender_id` / `reply_snapshot`，并追加 metadata event。
- message、edit、metadata 由 trigger 在 canonical 写入事务中追加；media_update 使用单条 `INSERT … SELECT`，可加入 ingest 事务，也可独立提交。event key 保证同一内容幂等。
- `idx_messages_media_identity` 是 `CAST(json_extract(media, '$.file_unique_id') AS TEXT)` 的表达式索引，引用媒体身份的查询使用相同表达式。
- 事件 payload 与 trigger body 保持原有 grammar；trigger 用 `CREATE TRIGGER IF NOT EXISTS`，本次迁移不替换它们。

## 交付状态与 Pi 状态

| 所有者 | 数据 | 用途 |
|---|---|---|
| archive | `routing_claims(chat_id, message_id, bot_id, route_version)` | 同一消息的 routing 幂等证据 |
| archive | `bot_state(bot_id, key)` | Telegram poll offset、bot user id / username |
| archive | `daemon_state(key)` | router secret、每个工作区上次每周清空时间等 daemon 状态 |
| Pi Durable | `telegram.state` Doc | `admittedSeq`、`epoch`、配置 fingerprint、待回复身份与已序列化原文、任务回复游标 |
| Pi Durable | 原生 conversation、task、usage | 历史、排队、执行、恢复、压缩与累计用量 |

`admittedSeq` 表示输入已由 Pi 持久接收，不表示模型已经处理。待回复原文随 Pi Doc 持久化，因此它不依赖 archive 保留窗口；是否已经请求补答，直接看 Pi 历史中已持久化的恢复消息。只有当前配置的 bot 参与 archive 清理水位计算；删除 bot 不需要扫描或删除旧 cursor 表。Pi 文件只通过原生 API 读写，离线 `npm run debug` 只读取 archive 的 offset、待交付行、routing claims 和结构化日志；运行态通过 `/status` 查询。

## 媒体

- `media`：`file_unique_id` 是共享身份；`short_id` 由 rowid 分配；`vision` 保存共享的 hybrid 描述 JSON；`local_path` 只存 `data/media` 下的文件名。
- `media_file_ids(bot_id, file_id, file_unique_id)` 保存各 bot 的发送/下载能力。
- `aliases(chat_id, user_id) → u<N>` 为没有 username 的发送者分配稳定别名，使用 rowid。
- Pi 持久化实际使用的图片内容；本地源文件是可重新下载的缓存，七天没有新消息引用后可回收。无需维护跨 session 的图片路径引用表。

## 保留期

`raw_updates` 默认保留 30 天，`message_events` 默认保留 365 天。每个事务每张表最多删除 1,024 行；每日维护分批清理到截止点，在批次间让出事件循环，避免高流量积压永久超过保留期。事件必须早于时间截止点、`ingest_seq` 不大于所有已配置 bot 的最小 `admittedSeq`，且没有 pending dispatch 引用；raw update 同样不能被 pending dispatch 引用。清理在同一事务内完成。

canonical 消息、revision、media 行不按时间删除。旧运行态表不再清理；Pi 会话数据由 Pi 自己管理，不能拿 archive 的保留期去删 Pi 内部表。媒体缓存每批最多回收 256 个源文件，见 [architecture.md](architecture.md#媒体)。`data/daemon.log` 不是业务数据，见 [debugging-guide.md](engineering/debugging-guide.md)。
