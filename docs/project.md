# 项目说明

## 是什么

一个真正“住在 Telegram 群里”的可配置 AI 群友系统：daemon 可按配置运行 1..N 个 Telegram bot，每个 bot 有独立 persona/session/routing。它们看得到群聊和彼此发言，自主决定是否插话，能发文字和 sticker、理解图片，必要时搜索/计算。

## 三个世界（严格分离）

1. **Telegram 群** —— 用户真正聊天的地方（传输层）
2. **本地持久化历史（SQLite）** —— 从运行起看到的一切的事实来源
3. **Pi / LLM** —— 只在需要思考时看到精简上下文

## 核心目标（按优先级）

1. 正确、稳定、可长期运行
2. 保持 LLM prompt prefix 稳定（provider cache reuse）
3. 减少 cache miss tokens
4. 减少无意义 LLM 调用和 provider-visible context
5. 架构和代码简单
6. 充分复用 Pi 已有能力
7. TUI 清楚实用

**核心原则：Never rewrite an existing cached prefix when appending new information can solve the same problem.**

## 项目哲学：最少机制，完整边界

这里的“极简”不是少做错误处理、测试或数据保护，而是用尽可能少的状态、接口、网络请求与 provider-visible bytes 完成可验证结果：

1. 一个职责只有一个拥有层；先复用 Telegram data plane、SQLite、Pi runtime/组件和现有 IPC，不建第二套平行实现。
2. routing、去重、权限、投影和统计能由确定性代码完成，就不发起模型调用。
3. provider 只接收当前回答需要的有界内容；完整历史留在 SQLite，UI 与运维信息走 side channel。
4. 稳定内容留在 append-only cached prefix；变化内容追加 suffix，不能因本地展示更新改写旧 provider history。
5. 昂贵工作按真实需求惰性执行并按 identity 复用；队列、并发、历史页、工具结果和错误都必须有界。
6. 新功能先问能否少一个抽象、tool、模型调用或动态字段。没有明确需求，不把单群 deployment 扩成多群、多租户、热加载或通用平台。

这些原则的用户侧成本机制见双语 cost guide；cache 与 provider byte 的技术权威仍是 `docs/cache.md`，日常方案检查见 `docs/engineering/development-guide.md`。

## 用户体验

- 新 clone 先运行 `bun install --frozen-lockfile`，再用 `bun run pi` 启动本机安装的 Pi；配置不存在时 `/tg config` 仍可用，并用 Pi 原生 dialogs 建立 typed config、private `.env` 与 persona。
- 向导只有在受控 daemon restart 明确 ready 后才自动打开 all-bots feed；credential/network 失败会保留已验证配置并给出 status/retry，不伪报连接成功。
- 启动 daemon → 配置的 bots 长期在线 → 消息落库 → Agent 按规则运行
- 用户随时在项目目录运行 `bun run pi`，用 `/tg attach [bot-id]` 在 Pi 原生 transcript 查看完整群聊、LOCAL 事件，并在与 Pi 原生同构的 attached footer 查看数据库 telemetry 保留期 usage；此时隐藏无关的 Pi operator usage 行，detach 后恢复；关闭 Pi 不影响 daemon，累计值不归零
- `/tg more` 加载更早历史，`/tg detach` 断开实时订阅，`/tg status [bot]` 按需查看 Telegram usage
- `/tg ` 使用 Pi 自带分级菜单补全子命令与当前配置中的 bot，不需要记忆 id
- daemon 运维：`start` / `restart` / `status` / `stop`；Pi中可用`/tg restart`原位恢复当前feed；详见 `docs/runbooks/daemon.md`

## 主要约束

- 模型选择是部署配置：每 bot 可选择Pi catalog中的provider/model，认证由共享Pi runtime/auth store统一提供；主对话有效context window统一限制为64K
- 当前 compaction threshold = Pi估算32K tokens；成功后按 `compaction_keep_recent` token 预算保留近期原文（缺省 1 token 实际只剩摘要，生产推荐 20,000），更早内容仅保留摘要
- Telegram 不承担历史恢复职责，SQLite 是事实来源
- Bot-to-Bot：彼此消息进共同 transcript 可被看到，但**不互相触发**（trigger 只来自满足 routing 条件的 human 消息）
- Bot 可以保持沉默：assistant local text 存 agent events + TUI 可见，不进群；provider session 只保留固定 silence marker

## 术语

- **Context Epoch**：一代 provider context；成功 compaction 或 fingerprint 失配后的新 session 都会进入下一 epoch
- **Context fingerprint**：Pi/provider/model、cache policy、protocol/persona、serializer/compaction/extensions/tools 等全部 cache-visible identity 的内容寻址摘要；restore 前必须精确匹配
- **CACHE_SCHEMA_VERSION**：fingerprint 中的强制失效字段；cache-visible protocol 任一变化时 bump，并在 restore 前建立新 session/epoch
- **Consumed cursor**：每个 bot 已处理到的 immutable event high-water，只单调前进
- **Visible refs**：当前 context generation 真正包含完整内容的 Telegram message ids；compaction/session rotation 可替换，不等同于消费状态
- **canonical message**：Telegram 群消息的本地统一表示，identity = (chat_id, message_id)
- **LOCAL**：TUI 中标记只有本地可见的 bot 内部行为（区别于 Telegram 真实发言）

## Persona 与部署隐私

- 当前 deployment 的 bot 名称、token env、persona 路径与提示词只存在 ignored 本机配置，不是公开项目契约。
- 仓库只跟踪 `personas/template.zh.md`、`personas/template.en.md` 与说明；其他 `personas/*.md` 默认忽略。
- persona 只保留人格与回应策略；send 的参数、调用和终止语义以 `src/agent/tools.ts` 为唯一权威。
- 旧 Git 历史仍可能包含已从当前 HEAD 移除的 deployment persona；未经明确授权不改写历史。

## 部署边界

- 一份 deployment 对应一个 Telegram supergroup 与 1..N bots。
- 每个 bot 的 token、persona、可选provider/model选择、routing与tools来自配置；provider认证只来自Pi。生产代码不依赖固定id或名字。
- 一个工作目录只有一个`group_peer_id`，而SQLite history/cursors/visibility/obligations、agent sessions、poller offsets/router secret、PID/control lock/Unix socket都没有第二层deployment namespace。
- 因此在同一目录并行切换配置文件可能混入跨群history/context、推进错误offset或争抢同一进程资源。配置文件不同不构成隔离。
- 第二个群必须使用独立checkout/worktree，并隔离`.env`、config/persona、Telegram bot tokens、data/DB、sessions、PID/lock/socket。当前不支持同目录多群。

## Scope

开发流程见 docs/engineering/development-guide.md（LLM 开发指南）：小 vertical slice、原子化签名 git 提交、契约变化同步文档。
