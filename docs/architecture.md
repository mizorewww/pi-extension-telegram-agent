# 架构

当前实现把 Telegram 当作 Pi 的输入输出适配器。provider 字节规则见 [cache.md](cache.md)，业务存储见 [data-model.md](data-model.md)。

## 进程与职责

```text
Telegram → poller × N → archive SQLite → router → Pi Harness × N
                                                   ↓
                                            send → Telegram
                                                   ↓
                                    Pi ExecutionEnv → rootless Docker
```

Node.js 24+ 是唯一运行时。daemon 共享一个 Pi `ModelRuntime`，每 bot 一个 Durable `Harness` 和 root conversation，保存在 `data/pi/<bot>.sqlite`。Pi 各直接依赖精确锁定 1.5.0。

Pi 拥有会话、工具执行、持久化队列、取消、重启恢复、压缩、模型与认证、用量账本、coding tools 和 codemode。项目保留 Telegram 路由、发送政策、媒体描述缓存、搜索服务、管理员命令和容器隔离。Durable 1.5.0 是实验性 API，升级须重新验证恢复与发送边界。

## 一条消息的路径

1. `poller.ts` / `ingest.ts` 在同一个业务 SQLite 事务里提交 raw update、canonical message、不可变 `message_events`、pending handoff 与 Telegram offset。只接收配置群，多个 bot 的重复消息共享 canonical 行。
2. poller 先交接 pending handoff，回调成功后删除；失败或重启先重放，随后才拉新 update。
3. `router.ts` 按 @mention → reply → 配置名称 → 概率选目标。概率由 HMAC 决定，busy/cooldown 跳过且不改投；`routing_claims` 去重路由。显式点名进入 Pi 原生 steering queue。
4. `runtime.ts` 从 archive 有界读取近期事件，在 **Pi 同一事务**里写入带 requestId 的 input、推进 admitted cursor、登记待回复原文。requestId 去重覆盖“Pi 已接纳但 routing claim 尚未提交”的崩溃窗口。cursor 表示已交给 Pi，不推断模型是否看过。
5. Pi 执行生成与工具调用；只有 `send` 能向群公开发言。assistant 的内部文本原生保存在 Pi 中，不自动发送。

## Bot 触发（`/fire`）

`BotFire` 是每 bot 的内存开关，重启关闭。管理员开启后，bot 消息仍按相同路由选目标；目标未开启、额度耗尽或目标等于发送者时不触发、不改投。每次人类消息补满 3 次额度，只在 runtime 接纳时扣减，bot 消息不创建强制回复义务。

群内本部署 bot 的成功发送写入 archive 后经 `routeLocalSend` 进入同一路由；poller 回声由 claims 去重。控制消息永久排除。Telegram 不保证投递其他 bot 的消息，`/fire` 不改变这一限制。

## 回复与发送边界

直接点名的待答原文保存在 Pi 的 `telegram.state` 文档中，跨压缩和重启保留。send 关闭的观察 bot 不创建义务。正常生成结束仍欠回复时，`onYield` 最多为该输入追加一次持久化补答；继续沉默则等下次输入，禁止无限补答。

Telegram create 不能回滚，发送遵循以下边界：

- 首次提交前验证真实群内 reply target、bot 专属 sticker file_id、reaction 与所有附件。文件先从工作区安全拷出；任何一份失败都不先发送文字。
- 只有确定性的 Telegram 4xx 拒绝且此前无任何提交，才允许模型修正后重试。超时、断线、429、5xx、非 JSON、部分提交都是 `no_retry`。
- `send` 使用 Pi 的 unsafe tool replay。重启发现已进入执行但没有可靠回执时，登记未知结果，并阻止同一原生 run 再次发送；确定从未开始的调用可以重试。新的人类输入可以开始新的 run。
- 已提交后的本地记账失败只降级，不重发。正常完成与未知结果都结清本次实际可见的待答内容。
- 文字转换为转义 HTML，交给 Telegram `parse_mode`；仅确定性格式拒绝时降级纯文本一次。图片 ≤10 MB，文件 ≤50 MB，多图合并相册，仅第一条 create 带 reply target。

## 后台任务

`task` 创建 Pi 原生 child conversation；工作流目录的 `AGENTS.md` 提供指令。child 使用主进程的模型认证和同一个隔离工作区，不再启动 Pi CLI、RPC 桥或带凭证的任务容器。child 无 send/task/job 权限，结果通过 `report(progress | need_input | done)` 返回 root，由 root 决定群内表达。

`TaskManager` 只保存 Telegram 的标题、发起消息、报告阶段与并发/期限政策。创建 child、转发补充和工具接纳回执原子提交；Pi 负责持久化执行与取消。普通进展至少间隔五分钟，结果/问题立即作为原生 input 唤醒 root。任务 deadline 使用 Pi 持久化 sleep，重启继续计时。

`job` 直接运行 Pi `ToolTask` 的 codemode 调用，不发起模型请求。最多四个、最长一小时；工具调用按原生 replay 语义恢复，已经提交的安全工具结果不会重新执行。任务与 job 均可取消，`/new` 中止后台树并清空当前任务列表。应用状态只保留最近二十个终态任务及仍活跃的任务，原生 journal 与用量由 Pi 保留。

## 上下文与压缩

root 使用原生 input、toolResult、summary entries。启动时比较包含协议、Pi 版本、模型、人设、工具和媒体配置的 fingerprint；不同则 reset 并推进 Telegram epoch，旧记录留在 Pi 存储中。`/new` 和 `/model` 同样换代，原生 compaction 不另造 epoch。

有效规划窗口取 catalog、`context_window`、`compaction_threshold + 16,384` 的最小值。Pi 固定预留 16,384 token，保留最近原文（取 `compaction_keep_recent` 与有效阈值一半的较小值），关闭后台推测性压缩。摘要使用当前聊天模型和 reasoning effort，输出上限由原生 `min(0.8 × reserve, model.maxTokens)` 决定；不再配置独立摘要模型。

Pi 摘要去掉图片与 thinking；1.5.0 不会为加密 thinking signature 精确计费，也不会自动分块超大摘要请求。HTTP 413 归一为原生 overflow；provider 的完整调用由 Chord deadline 约束。不能保证任意超大上下文都能就地压缩，失败可用 `/new`。

## 媒体

只有 `off` 与 `hybrid`。off 保留文字占位。hybrid 为媒体生成一次描述，按 file_unique_id 缓存在 archive 并跨 bot 复用；描述作为不可变 `media_update` 追加，每轮等待最多 2.5 秒。没有赶上的描述以后续事件进入上下文。

`view_image` 按需返回 Pi 原生 image content，Pi 持久化图片字节，无自建图片引用和可见集。Photon 负责转换/缩放；视频经 ffprobe/ffmpeg 抽 1–3 帧。无 FFmpeg 时保留占位，不阻塞启动。语音、普通文件、TGS 仍为占位，可在工作区处理。

下载源文件缓存七天后有界清理；不依赖会话引用计数。Pi 已保存的 image content 不受本地缓存清理影响。

## 工具与隔离

`tools.ts` 是 Telegram 工具 schema 的来源，Pi 注册表负责模型声明与 codemode 类型渲染。无需把整份示例重复放进 system prompt。

- `search`：TinyFish 搜索/网页读取，固定 DTO、正文分页，拒绝内网/回环地址；凭据只在主进程。
- `tg_messages`：只读查询本群 archive，排除控制消息，FTS5/LIKE 检索与游标分页；不暴露任意 SQL。
- `read` / `write` / `edit` / `bash`：Pi 原生 coding tools，经 `RemoteExecutionEnv` 和 docker exec 进入工作区；主机环境不会提供给模型工具。
- `tg_download` / `sh_reset`：Telegram 附件拷入及工作区重置。bash 最长 600 秒。
- codemode：Pi QuickJS/独立 worker，256 MB、最多两个 worker；无 Node API/直接网络/文件系统。能调用的工具由 Pi 注册权限决定，模型辅助调用关闭。send 每个 run 有 20 次上限。

工作区由独立 `tgbox` 用户的 rootless Docker 运行；uid 1000、cap-drop ALL、no-new-privileges、只读根、tmpfs 与资源上限，只挂命名卷 `/work`。容器无 provider/search 凭据、无宿主目录。命令可访问公网，恶意输入仍可破坏共享工作区；rootless 隔离不是内容信任机制。安全拷出验证规范路径、普通文件、nofollow 与大小。详见 [sandbox runbook](runbooks/sandbox.md)。

## 控制命令与配置

命令仅由 offset 0 的 bot_command entity 识别。`/help`、`/status`、`/fire status`、`/task status` 公开；写入、切换、取消、压缩和重置需要数字管理员 ID。命令及 bot 控制回复永久登记并排除出 provider context。

`/set` 与 `/model` 保留配置写回、串行执行和失败回滚。`/new` 抢占原生 run/compaction/后台树并重置工作区；切换中的控制请求不能并发改 session。`/status` 使用原生用量；不重建第二份 ledger。

配置只有 `telegram.config.ts`、Pi auth/settings 和冒号格式 `.env`。TypeBox/Pi schema 严格拒绝未知字段。一个工作目录只服务一个群；pid lock 防止重复 daemon，systemd 管理生命周期，见 [daemon runbook](runbooks/daemon.md)。
