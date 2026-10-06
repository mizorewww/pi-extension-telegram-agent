# 项目说明

## 是什么

让 1..N 个各有 persona 的 AI bot 长期住在一个 Telegram 群里：它们看得到群聊和彼此的发言，自主决定是否插话，能发文字、sticker、reaction，看图和视频，必要时搜索或计算。运营者在本机 Pi 终端里观察和控制。

## 三个世界（严格分离）

1. **Telegram 群**：真正聊天的地方，只是传输层，不承担历史恢复。
2. **SQLite**：从运行起看到的一切的事实来源。
3. **Pi / LLM**：只在需要思考时看到有界的精简上下文。

## 目标（按优先级）

1. 正确、稳定、可长期运行；
2. provider prompt 前缀稳定，最大化 cache 复用；
3. 减少 cache miss token 与无意义的 LLM 调用；
4. 架构与代码简单，充分复用 Pi；
5. TUI 清楚实用。

核心原则：**追加能解决的，就绝不改写已缓存的前缀。**

## 哲学：最少机制，完整边界

“极简”是用尽量少的状态、接口、网络请求与 provider 可见字节完成可验证的结果，不是少做错误处理、测试或数据保护：

1. 一个职责只有一个拥有层；先复用 Telegram、SQLite、Pi 与现有 IPC，不建平行实现。
2. 能用确定性代码完成的（路由、去重、权限、统计），不调用模型。
3. provider 只接收本次回答需要的有界内容；完整历史留在 SQLite，UI 与运维走旁路。
4. 稳定内容留在前缀；变化内容只追加，本地展示更新不能改写 provider 历史。
5. 昂贵工作按需惰性执行、按身份复用；队列、并发、结果与错误都有上限。
6. 没有明确需求，不把单群 deployment 扩成多群、多租户、热加载或通用平台。

## 行为约束

- bot 之间看得到彼此的消息，但**不互相触发**；只有满足路由条件的人类消息能触发。
- bot 可以沉默：没调用 `send` 的输出只在本地可见。
- 被人类直接点名（@、回复、名字）必须回应；概率插话可以按 persona 沉默。
- 模型、上下文窗口与压缩阈值都是 per-deployment 配置；认证只来自 Pi。

## 术语

| 术语 | 含义 |
|---|---|
| context epoch | 一代 provider context；成功压缩、换 session（`/model`、`/new`、fingerprint 变化）都会进入下一代 |
| context fingerprint | 所有 cache 可见身份（Pi/provider/model、协议、persona、序列化、工具……）的摘要；恢复 session 前必须精确匹配 |
| `CACHE_SCHEMA_VERSION` | fingerprint 里的强制失效字段，cache 可见协议一变就 bump |
| consumed cursor | 每 bot 已处理到的不可变事件位置，只增不减 |
| visible refs | 当前 context 真正包含完整内容的消息 id；可被压缩替换，不等于消费状态 |
| canonical message | 群消息的本地统一表示，身份为 `(chat_id, message_id)` |
| 回复义务 | 直接点名后尚未回复的消息，结清前不会丢 |
| LOCAL | TUI 中只有本地可见的 bot 内部行为 |

## 部署与隐私边界

- 一份 deployment = 一个 Telegram supergroup + 1..N 个 bot。一个工作目录只对应一个群；`data/`、DB、session、pid、socket 都没有第二层命名空间，多群必须用隔离的 clone。
- 真实 bot 名、token、persona 只存在被 Git 忽略的本机文件里；仓库只跟踪 `personas/template.zh.md` 与 `template.en.md`。旧 Git 历史可能仍含已删除的 persona，未经授权不改写历史。
- persona 只写人格与回应策略；`send` 的参数与语义以 `src/agent/tools.ts` 为准。
