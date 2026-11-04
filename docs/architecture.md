# 架构

描述当前代码实际做了什么。改动边界或 invariant 时同步本文；provider 字节规则见 [cache.md](cache.md)，表结构见 [data-model.md](data-model.md)。

## 进程

```
Telegram ── poller × N ── daemon（唯一长驻进程）── SQLite
                            ingest + router + BotRuntime × N（每 bot 一个 Pi AgentSession）
```

- **daemon**（`src/daemon/index.ts`）：持有 SQLite、全部 poller 与每 bot 一个 `BotRuntime`。整个进程只创建一个 Pi `ModelRuntime`。
- 依赖：Node.js 24+；Pi 各包（含 pi-codemode、pi-schema）精确锁定 1.5.0；Telegram 直接调用 Bot API（fetch long polling），无第三方 SDK。

## 一条消息的路径

1. **Ingest**（`src/telegram/poller.ts`、`ingest.ts`）：每个 bot 一个 `getUpdates` 循环。raw update、canonical `messages` 行、不可变 `message_events` delta、`pending_telegram_dispatch` 与 offset 在**一个事务**里提交。只接受配置的群（`groupChatId = -100<peer>`）。多个 bot 收到同一条消息只保留一份 canonical；更旧的 edit 不回写。
2. **交接**：poller 先把 pending handoff 交给 routing/control 回调，回调成功才删除；失败或重启后先重放 handoff 再拉新 update。
3. **Route**（`src/agent/router.ts`）：优先级 @mention > reply > 配置名称 > 概率；每一级扫完全部 bot 才进入下一级。概率 = `HMAC(router_secret, chatId:messageId)` 落入按配置顺序累加的 `routing_p` 桶（Σ≤1）。bot 发的消息默认不触发，例外只有 `/fire`（见下节）。概率目标 busy 或在 cooldown 时直接跳过，**不改投**别的 bot。`routing_claims` 保证同一条消息对同一 bot 只启动一次。
4. **Turn**（`src/agent/runtime.ts`）：每 bot 串行状态机 `idle → flushing → idle`，在途触发只合并为一次 pending；但人类在 provider 回合进行中直接点名时，新事件立即打包成一批，用 Pi `sendCustomMessage(…, { deliverAs: "steer" })` 插进正在跑的回合（当前工具调用结束后、下一次模型调用前送达）。插入时不提交任何状态：回合结束先清空 Pi 队列里没送达的批次，再按 session 里实际落地的批次推进 cursor、结清它们带来的义务，没落地的留给下一轮正常打包。一轮 flush：
   - 按 cursor 有界读取近期 event（≤256）和直接点名的回复义务（≤64），义务优先打包；
   - 按 `media.mode` 准备媒体；
   - 打包成一条 `telegram_context_v2` custom message，用 Pi `sendCustomMessage(…, { triggerTurn: true })` 由批次本身启动 turn（Pi 照常先做阈值压缩检查）；
   - turn 结束后从 session 实际内容重建可见集合，原子写回 SQLite；图片字节压力只在下一批追加前检查。
5. **Send**（`src/agent/send.ts`）：模型唯一的公开发言通道是 `send` tool（文字 / sticker / reaction）。详见下文“发送边界”。

## Bot 触发（`/fire`）

- 状态是 `BotFire`（`src/agent/router.ts`）：按 (chat, bot) 记录的内存开关 + 剩余额度。默认关闭、不持久化，daemon 重启全部关闭。唯一写入者是人类管理员的 `/fire` 命令。
- `routeMessageDecision` 仍是 bot 消息的唯一闸门：bot 消息先按与人类完全相同的规则选出目标；目标未开 `/fire`、额度为 0、或目标就是发送者本身时结果为 `nobody`，**不改投**别的 bot。带 `edit_date` 的 bot 消息不触发。
- 额度 `FIRE_BOT_TRIGGER_BUDGET = 3`：只有 runtime 接受（`started` / `coalesced`）的 bot 触发才扣减，busy / cooldown 跳过不扣；任何人类消息经路由时把本群所有已开启 bot 补满，`/fire on` 也补满。
- bot 触发的点名只是机会，不写 `reply_obligations`。
- bot 消息只从两个入口进入同一个 `MessageRouter`（`src/agent/router.ts`）：poller 实际收到的 update；本部署 bot 的 agent `send` 成功写库后由 `sentMessageSink` 本地路由（`routeLocalSend`，route version 1）。写库失败的发送不路由；控制回复不经过该 sink，且登记在 `telegram_control_messages` 的 bot 消息一律不触发。同一条消息的 poller 回声或重放由 `routing_claims` 去重，不会二次 dispatch。
- Telegram 一般不把其他 bot 的群消息投递给 bot，`/fire` 不改变任何投递；部署外的 bot 只有在 Telegram 真的投递时才能触发。

## 后台任务

- bot 用 model-only `task` 工具（`tools.tasks`，需要工作区与顶层 `tasks` 段）把耗时工作交给工作流（`tasks.workflows`，目录里的 `.pi` 原样拷进任务目录）。`TaskManager`（`src/tasks/manager.ts`）为每个任务起一个一次性容器 `tg-task-<bot>-<id>`（`src/tasks/process.ts`）：与工作区同一镜像、同一 `/work` 卷，另挂凭证卷 `tg-pihome-<bot>:/pi-agent`，运行 `pi -a --mode rpc` 加载桥接扩展（`deploy/box/task-bridge`）。
- 任务只通过 `report(progress | need_input | done)` 与 bot 通信；daemon 读 RPC 事件流，把报告写成该 bot 的 `note` 事件。进展同一任务至少间隔 5 分钟才唤醒 bot；完成、失败、需要输入时在发起消息上重新创建回复义务并唤醒，复用补答与不重发语义。run 结束却没报 done 时取最后的 assistant 文本当结果。
- 群友的补充经 `task message` 转给任务（运行中 steer，等待输入时开始下一 run）；`task cancel` 停止；每个 bot 最多 `tasks.max_running` 个，超过 `tasks.timeout_minutes` 判失败。任务的 Pi session 存在 `/work/tasks/<id>/.pi-sessions`：daemon 停止时只停容器、不判失败；重启后先按 label 删除残留容器，running 的任务用同一 session 重新起容器并提示它从中断处继续，need_input 的任务等收到回答再启动；超时按创建时间计算。工作区不可用时才标记 interrupted 并通知发起人。有任务时每周清空顺延。

### 后台脚本（job）

- `job({ title, code, for_message? })`（codemode 与 send 都开时注册）：把一段 codemode 脚本放到回合之外运行（`src/tasks/jobs.ts`，Pi `CodemodeSandbox`，与 codemode 同一组脚本工具，但没有 send、task、job），立刻返回 `jN`。结果（输出 ≤16,000 字符）写成 `source: "job"` 的 note（`[job jN 完成 ↪ #id]` / `[job jN 失败]`），在发起消息上产生回复义务并唤醒 bot，复用任务的投递路径。每 bot 同时 ≤4 个、每个 ≤60 分钟（只防失控，不写进提示词）；daemon 停止时正在跑的 job 写 interrupted note 并产生义务，重启后 bot 会告诉发起人。job 不跨重启续跑（脚本没有可恢复的状态）。

## 任务威胁模型

- **威胁**：任务会抓取网页，网页里的 prompt injection 可以驱动任务里的 agent 执行命令、读写 `/work`、调用凭证卷里的 provider。
- **边界**：任务容器的隔离与工作区相同（uid 1000、无 capability、只读根、资源上限、无宿主机挂载）；凭证（swe-2 代理 key、ollama-cloud key）只在 `tgbox` 拥有的卷里，TinyFish key 以环境变量名传入、不出现在 argv。工作区容器 `tg-box-<bot>` 不挂凭证卷，所以 bot 自己的 `sh_exec` 读不到这些凭证。
- **残余风险**：被注入的任务可以使用、外发这些凭证（群被信任，接受）；`/work` 是 bot 与任务共用的。

## 回复义务

- 人类直接点名（@、回复、配置名称）在 provider 调用前写入 `reply_obligations`。只有 send 返回终态（已发送、部分发送或结果未知）后才结清；结果未知或部分发送**永不自动重发**。
- 健康 turn 没有公开发送、且待回复消息仍在上下文里时，由 Pi `agent_before_settle` 最多追加一次固定补答 custom message 并继续当前运行；仍沉默就保留义务等下次触发，不会无限循环。
- provider 失败的 turn 保留义务、不写零用量 `llm_runs`。
- `send` 关闭的观察 bot 不创建义务。

## 发送边界

Telegram create 不可回滚，所以：

- 发送前做完所有本地校验（`reply_to` 必须是本群真实存在的非控制消息，上下文外的旧消息也可以，编造的 id 被拒绝；sticker 必须有本 bot 的 `file_id`、reaction 只允许 Telegram 固定集合，群组限制了 reaction 时再与启动时 `getChat.available_reactions` 取交集）。带内容的 send 遇到无效 reaction 时丢弃 reaction 继续发；只点 reaction 才报错。
- 只有 Telegram 确定性的 4xx 拒绝（且之前没有任何提交）才把错误还给模型重试。超时、断线、429、5xx、非 JSON 一律算结果未知，返回固定 `no_retry` 并结束本轮。
- 提交后的本地记账（canonical 写库、可见性、广播、事件）失败只降级为 `committed`，不重发；SQLite busy 有 25/100/250 ms 有界重试。
- `files`（只有带工作区的 bot 声明）：发送前先把全部文件从工作区拷出（容器内 `realpath` 后必须仍在 `/work`），任何文件缺失、过大或类型不符都在第一次 create 之前报错；顺序为文字 → 图片（≤10 MB 的 jpg/png/webp，多张合成相册）→ 文件（≤50 MB）→ sticker，只有第一条 create 带 `reply_to`。
- 文字由本地 Markdown → Telegram entities 转换（`src/telegram/markdown.ts`）；只有 Telegram 确定性拒绝 entities 时才用同一文本无格式重发一次。
- 成功返回固定 `ok`、降级返回固定 `no_retry`，两者都 `terminate:true`，不产生 follow-up provider 调用。

## 上下文与压缩

- 每 bot 一个 Pi session，打开前先算完整 context fingerprint；fingerprint 和 session 文件都匹配才恢复，否则保留旧文件、新建 session、推进 epoch。规则见 [cache.md](cache.md)。
- Pi session 文件只增不减。恢复时 `src/agent/session-trim.ts` 把最近一次压缩保留窗口之前的内容裁掉（保留最后的 model / thinking 设置与 session id），只有 Pi 由新文件构建出的 context 与原文件逐字节相同才替换；原文件改名为 `.pre-trim-<时间>` 保留。
- `bot_cursors`（业务消费位置，只增不减）与 `bot_visible_messages`（当前 context 真正可见的完整消息）分开维护。压缩或换 session 只替换后者。
- 压缩由 Pi 原生触发（阈值 = `context_window − max(16384, context_window − compaction_threshold)`），摘要由 `tg-compaction` 用配置的 `compaction_model` 生成；失败或空摘要直接取消，不退回主模型、不退回 Pi 默认摘要器。摘要输入超出模型窗口时按窗口切块、沿 `previousSummary` 滚动合并（同一模型多次调用），再不行先丢图后截断——任何大小的上下文都能就地恢复。
- 图片在 session 里只存引用，Pi 的 chars/4 估算看不到它们；思维链签名（如 Devin 的 `sealed` signature）随回放计费同样不可见。runtime 在 Pi 准备压缩**之前**按每张图 1,100 token、每字节签名 /4 临时缩小 `keepRecentTokens`，结束后恢复。
- 主请求追加新批次前检查图片字节预算（`context_image_budget_bytes`），超限先压缩；压缩失败则本轮不发请求、保留 cursor 与义务。HTTP 413 被归一为 Pi 可识别的 overflow，由 Pi 原生 compact-and-retry 一次。
- 最近一条 assistant 是 error/aborted 时，阈值压缩被取消（避免在 provider 故障时叠加摘要请求）；overflow 恢复和手动压缩不受影响。

## 媒体

`media.mode` 决定媒体怎么到达模型。所有模式下语音、音频、非视频文件、TGS 动画贴纸都只有文字占位（Pi 只支持 image 内容块）。视频（含视频贴纸、GIF、video note）都用 `ffprobe`/`ffmpeg` 抽 1–3 帧；缺少 FFmpeg 时视频在下载前跳过，只留占位，不阻塞 daemon。

- **off（默认）**：只有文字占位。
- **hybrid**（推荐）：视觉模型（`media.vision_model`）为每个媒体生成一次文字描述，按 `file_unique_id` 持久化在 `media.vision` 并跨 bot 复用；描述作为 `media_update` delta 追加，主模型看到文字。每轮最多 `media.max_per_turn` 个、全局并发 `media.concurrency`；一轮最多等 2.5 秒，没赶上的描述在后台继续，之后以 `media_update` 进入下一轮（需要时 bot 用 view_image 直接看原图）。另注册 `view_image({message_id})`（model-only）。它用 `ensureViewImages` 准备图片（文件名由媒体身份推出，不入库），结果 content 只有该消息的渲染行，`details` 只存文件引用 `{messageId, images}`；`context` 投影时才把文件读成 image block（session 不存 base64）。被查看的消息计入可见集合（可被 `reply_to`、文件不被清理），图片计入 `context_image_budget_bytes`、压缩前的每张 1,100 token 换算和摘要输入。主模型必须支持图片输入。
- 下载严格把 `file_id` 与拥有它的那个 bot 的 Bot API 配对；回复 bot 没有 mapping 时可用其他已配置 bot 的。
- 媒体只在 vision 或 view_image 需要时下载。
- 本地文件是可再生缓存：成功压缩后，所有已配置 bot 都不再引用（不可见、无待回复、无未消费 event）的文件按 ≤256 个一批删除；媒体行、描述、short id 与 file mapping 保留。

## Sticker

- `media.file_unique_id`/`short_id` 是共享身份；`media_file_ids(bot_id, file_id)` 才代表某个 bot 能发。
- system prompt 末尾是该 bot 可发送的固定目录（`s<id>: <emoji> <描述>`）。群友发出的、目录外但本 bot 也能发的 sticker，在它首次出现的那一批消息之后以一条〔系统附注〕列出（每批 ≤8 条），之后原样保留，不写入持久化内容（见 [cache.md](cache.md)）。
- `sendSticker` 直接用本 bot 的 `file_id`，不下载重传。

## 工具

系统提示的「可用工具」只描述 bot 实际开启的工具及其用法，每个工具下附经过真实运行的示例（`src/agent/tool-examples.md`，改动后跑 `scripts/e2e-examples.ts`）（`src/agent/prompt.ts` 的 `toolCapabilityDeclaration`），并给出源代码仓库地址供 bot 阅读自己的实现。模型可见的声明按固定顺序为 `send`、`search`、`view_image`（hybrid 模式）、`task`（`tools.tasks`），再加 Pi 渲染的 `codemode`（cache 可见）。`src/agent/tools.ts` 是各工具说明与暴露方式（`TOOL_EXPOSURE`）的唯一权威。

- `send` 既能直接调用也能在 codemode 脚本里调用：直接调用成功即结束本轮；脚本里的调用不结束本轮（Pi 只认顶层调用的 terminate），所以一个脚本可以先回一句、干活、再发结果，同时不停 typing。发出内容（文字 / sticker / 文件）的 send 每轮最多 20 次（`MAX_SENDS_PER_TURN`），只防脚本死循环刷屏，不写进提示词；只点 reaction 不计数。`task`、`job` 同样可在脚本里调用；`view_image` 是 model-only，因为脚本输出会丢弃图片。
- `search(query | url [, offset])`：TinyFish；query 最多 5 条短结果；url 只接受公网 HTTP(S)（本地预检 userinfo、localhost、私网、link-local），整页（≤200k 字符）在内存缓存 15 分钟，每次返回从 `offset` 起约 4k token 的一页并给出下一页 offset，包在“不可信网页内容”边界里。日志不记录 query、URL 路径或正文。脚本里也可调用。
- `codemode`：Pi 原生（`createCodemodeExtension`，`mode: "on"`、`models: false`），见下节威胁模型。声明文本由 Pi 按可调用工具渲染，fingerprint 以 Pi 版本 + 工具列表锁定。
- `tg_messages`（`exposure: "codemode"`，只有脚本能调）：只读检索本群 canonical 历史（`src/tools/messages.ts`），按 id / 时间 / 发送者 / 回复 / 媒体类型 / 子串过滤（3 字以上走 FTS5 trigram 索引，可按 relevance 排序；更短的回退 LIKE），每次 ≤2000 行（按 id 取 ≤1000 个），带 `next_before_id`/`next_after_id` 分页；返回固定 DTO（声明为 `outputSchema`），不暴露 SQL 与表结构；排除 `telegram_control_messages` 与其他 chat。bot 收不到 Telegram 删除事件，已删除的消息仍可能被检索到。
- `tg_download` / `sh_exec` / `sh_reset`（`exposure: "codemode"`，`tools.sandbox` 开启时注册）：在 bot 的工作区容器里拷入 Telegram 附件、执行命令、清空工作区，见下节威胁模型与 [runbooks/sandbox.md](runbooks/sandbox.md)。
- 没有调用 send 的 assistant 文本只写本地 `agent_events`，session 里用固定 `[no_send]` 代替。

## codemode 威胁模型

- **威胁**：群成员或网页内容通过 prompt injection 让 bot 执行任意 JS。
- **边界**：脚本跑在 Pi 的 QuickJS（wasm）VM 里，位于独立 worker 线程；VM 的唯一出口是被注册为可调用的工具，没有 Node API、文件系统、网络、计时器。可调用工具 = 激活的 `direct` 工具（含 send、task、job）+ `codemode` 暴露的工具；send 采用 Pi 1.5 原生 `executionMode: "sequential"`，脚本发消息还受每轮 20 次的防死循环上限约束，额度在异步提交前预占，`view_image` 是 model-only。
- **宿主侧约束**（`src/agent/extensions/codemode.ts`）：脚本 `image()` 产生的图片替换为固定文本，session 里永远不存 base64；输出长度沿用 Pi 的 `max_output_tokens`（默认 10,000 token）。
- **残余风险**：wasm 引擎漏洞；VM 每次最多 256 MB，同进程最多 2 个 worker（`PI_CODEMODE_MAX_WORKERS`）。默认关闭。

## 沙箱威胁模型

- **威胁**：群成员（被信任）或网页内容通过 prompt injection 让 bot 在工作区执行任意命令。
- **边界**：每个 bot 一个常驻容器 `tg-box-<bot>`（`src/sandbox/box.ts`），由独立用户 `tgbox` 的 rootless Docker 运行；daemon 用户只在 `tgbox` 组里能访问其 socket，不在 `docker` 组。容器以 uid 1000、`--cap-drop ALL`、`no-new-privileges`、只读根文件系统、`/tmp` tmpfs、内存/CPU/pids 上限运行；唯一挂载是命名卷 `tg-work-<bot>:/work`，不挂宿主机目录，不传任何 env（只有 `HOME=/work/.home`），容器里没有凭证。默认开网（rootless slirp4netns，`--disable-host-loopback`，访问不到宿主机 loopback 上的服务）。
- **出入**：只经 docker exec 的 stdin/stdout 传字节。拷出前在容器内 `realpath`，结果必须仍在 `/work` 下且是普通文件；输出 ≤1 MiB，单条命令 ≤600 s（容器内 `timeout -s KILL` + 宿主侧 deadline）。
- **残余风险**：容器逃逸得到的是 `tgbox` 的 subuid 映射身份，读不到 daemon 用户的 `.env`；出网可以被用来访问公网服务。工作区每周一 05:00 清空，也可以 `/box reset` 或 `sh_reset`。

## Telegram 控制命令

- 只识别 offset 0 的 `bot_command` entity：`/help`、`/status`、`/fire status`、`/task [status]` 公开；`/task cancel tN`、`/model`、`/compact`、`/new`、`/set`、`/fire [on|off]`（不带参数为切换）、`/box reset` 需要 `telegram_admins` 中的人类账号（只接受数字 user id）。带 `@bot_username` 时定向到该 bot，否则作用于收到命令的 bot。
- 命令和回复的 message id 永久记录在 `telegram_control_messages`，**永不进入任何 provider context**。只有 `/set`、`/model` 配置写回串行执行。命令完成与 poller 接收解耦，持久化 claim 后继续接收下一条 update，因此 `/new` 能抢占尚未完成的 `/compact`。
- `/model`：按钮分页列出 Pi 当前已认证的全部模型；`/new`：用当前模型开新 session。两者共用同一个 session 切换：先建好新 session，再在一个事务里写 epoch、manifest、清空可见集与该 session 名下的未答 obligations，失败时旧 session 原样保留；旧 session 文件留在磁盘。
- `/new` 是唯一抢占式命令：它是卡死逃生口，先通过 Pi `abort()` 取消在途 run/retry/compaction，停止后台任务和工作区执行，等待旧 flush / 手动压缩收尾，再换 session 并重置工作区；切换中的 `/model` 不抢占。只清除 reset 开始时 high-water 以内的旧义务，并推进 cursor；reset 窗口内到达的直接点名照常持久化义务，由新 session 处理。
- `/set` 弹出按钮菜单（插话概率、冷却的固定预设，当前值打勾）；回调只接受预设值，校验后写穿 `telegram.config.ts`、更新内存中的同一 `BotConfig`，并原地刷新菜单。
- `/status` 由确定性代码生成纯文本，用 Pi 原生 session/context 统计和 SQLite 保留期账目，不计算复杂构成占比。

## 进程管理与配置

- 配置只有 `telegram.config.ts`（受信本机代码，`defineConfig()` 提供类型）+ `.env`（`key: value`，只放项目自己的 secret：bot token、`tiny_fish_api_key`、可选 `router_secret`）+ Pi auth store（模型凭据）。配置类型与结构校验共用 TypeBox schema，由 Pi schema 执行严格校验（不进行类型强制转换）；未知字段直接报错。跨字段、文件存在性和凭据是否配置仍由业务代码检查。
- 进程由 systemd user unit 托管（见 [runbook](runbooks/daemon.md)），仓库不自带 start/stop 控制器；`npm run start` 只是前台运行入口。daemon 启动最早一步用 `openSync(wx)` 独占 pid 文件，记录的 pid 仍存活就拒绝启动，绝不让两个 daemon 轮询同一 token。
- 一个工作目录只对应一个群：`data/`、DB、session、pid 都由工作目录决定。多群必须用隔离的 clone。
