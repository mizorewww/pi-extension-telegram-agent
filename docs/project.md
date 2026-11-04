# 项目说明

## 三个世界（严格分离）

1. **Telegram 群**：真正聊天的地方，只是传输层，不承担历史恢复。
2. **SQLite**：从运行起看到的一切的事实来源。
3. **Pi / LLM**：只在需要思考时看到有界的精简上下文。

## 行为约束

- bot 之间看得到彼此的消息，但默认**不互相触发**；只有满足路由条件的人类消息能触发，例外是管理员对单个 bot 开启的 `/fire`（有连续次数上限，见 [architecture.md](architecture.md#bot-触发fire)）。
- bot 可以沉默：没调用 `send` 的输出只在本地可见。
- 被人类直接点名（@、回复、名字）必须回应；概率插话可以按 persona 沉默。
- 模型、上下文窗口与压缩阈值都是 per-deployment 配置；认证只来自 Pi。

## 术语

| 术语 | 含义 |
|---|---|
| context epoch | 一代 provider context；换 session（`/model`、`/new`、fingerprint 变化）进入下一代；原生 compaction 管理自己的上下文边界 |
| context fingerprint | 所有 cache 可见身份（Pi/provider/model、协议、persona、序列化、工具……）的摘要；恢复 session 前必须精确匹配 |
| `CACHE_SCHEMA_VERSION` | fingerprint 里的强制失效字段，cache 可见协议一变就 bump |
| admitted cursor | 每 bot 已原子交给 Pi 的不可变事件位置，只增不减 |
| canonical message | 群消息的本地统一表示，身份为 `(chat_id, message_id)` |
| 回复义务 | 直接点名后尚未回复的消息，结清前不会丢 |

## 部署与隐私边界

- 一份 deployment = 一个 Telegram supergroup + 1..N 个 bot。一个工作目录只对应一个群；`data/`、DB、session、pid 都没有第二层命名空间，多群必须用隔离的 clone。
- 真实 bot 名、token、persona 只存在被 Git 忽略的本机文件里；仓库只跟踪 `personas/template.zh.md` 与 `template.en.md`。旧 Git 历史可能仍含已删除的 persona，未经授权不改写历史。
- persona 只写人格与回应策略；`send` 的参数与语义以 `src/agent/tools.ts` 为准。
