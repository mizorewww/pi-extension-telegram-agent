# 架构

描述当前代码实际做了什么。改动边界或 invariant 时同步本文；provider 字节规则见 [cache.md](cache.md)，表结构见 [data-model.md](data-model.md)。

## 进程

```
Telegram ── poller × N ──┐
                         daemon（唯一长驻进程）── SQLite
                         │  ingest + router + BotRuntime × N（每 bot 一个 Pi AgentSession）
                         └─ IPC（Unix socket JSONL）── Pi 交互进程（.pi/extensions/tg-extension.ts）
```

- **daemon**（`src/daemon/index.ts`）：持有 SQLite、全部 poller、每 bot 一个 `BotRuntime` 和 IPC server。整个进程只创建一个 Pi `ModelRuntime`。
- **Pi extension**：观察和控制界面，不是第二个 daemon。关闭 Pi 或 `/tg detach` 不影响 bot。
- 依赖：Bun；Pi 四包精确锁定 1.0.4；Telegram 直接调用 Bot API（fetch long polling），无第三方 SDK。`bun run pi` 启动 PATH 中本机安装的 Pi CLI。

## 一条消息的路径

1. **Ingest**（`src/telegram/poller.ts`、`ingest.ts`）：每个 bot 一个 `getUpdates` 循环。raw update、canonical `messages` 行、不可变 `message_events` delta、`pending_telegram_dispatch` 与 offset 在**一个事务**里提交。只接受配置的群（`groupChatId = -100<peer>`）。多个 bot 收到同一条消息只保留一份 canonical；更旧的 edit 不回写。
2. **交接**：poller 先把 pending handoff 交给 routing/control 回调，回调成功才删除；失败或重启后先重放 handoff 再拉新 update。
3. **Route**（`src/agent/router.ts`）：优先级 @mention > reply > 配置名称 > 概率；每一级扫完全部 bot 才进入下一级。概率 = `HMAC(router_secret, chatId:messageId)` 落入按配置顺序累加的 `routing_p` 桶（Σ≤1）。bot 发的消息不触发。概率目标 busy 或在 cooldown 时直接跳过，**不改投**别的 bot。`routing_claims` 保证同一条消息对同一 bot 只启动一次。
4. **Turn**（`src/agent/runtime.ts`）：每 bot 串行状态机 `idle → flushing → idle`，在途触发只合并为一次 pending。一轮 flush：
   - 按 cursor 有界读取近期 event（≤256）和直接点名的回复义务（≤64），义务优先打包；
   - 按 `media.mode` 准备媒体；
   - 打包成一条 `telegram_context_v2` custom message，经 Pi `session.prompt()` 发出；
   - turn 结束后从 session 实际内容重建可见集合，原子写回 SQLite，再检查图片字节压力是否需要额外压缩。
5. **Send**（`src/agent/send.ts`）：模型唯一的公开发言通道是 `send` tool（文字 / sticker / reaction）。详见下文“发送边界”。

## 回复义务

- 人类直接点名（@、回复、配置名称）在 provider 调用前写入 `reply_obligations`。只有 send 返回终态（已发送、部分发送或结果未知）后才结清；结果未知或部分发送**永不自动重发**。
- 健康 turn 没有公开发送、且待回复消息仍在上下文里时，最多追加一次固定补答提示；仍沉默就保留义务等下次触发，不会无限循环。
- provider 失败的 turn 保留义务、不写零用量 `llm_runs`。
- `send` 关闭的观察 bot 不创建义务。

## 发送边界

Telegram create 不可回滚，所以：

- 发送前做完所有本地校验（`reply_to` 必须在上下文中可见、sticker 必须有本 bot 的 `file_id`、reaction 只允许 Telegram 固定集合）。带内容的 send 遇到无效 reaction 时丢弃 reaction 继续发；只点 reaction 才报错。
- 只有 Telegram 确定性的 4xx 拒绝（且之前没有任何提交）才把错误还给模型重试。超时、断线、429、5xx、非 JSON 一律算结果未知，返回固定 `no_retry` 并结束本轮。
- 提交后的本地记账（canonical 写库、可见性、广播、事件）失败只降级为 `committed`，不重发；SQLite busy 有 25/100/250 ms 有界重试。
- 文字由本地 Markdown → Telegram entities 转换（`src/telegram/markdown.ts`）；只有 Telegram 确定性拒绝 entities 时才用同一文本无格式重发一次。
- 成功返回固定 `ok`、降级返回固定 `no_retry`，两者都 `terminate:true`，不产生 follow-up provider 调用。

## 上下文与压缩

- 每 bot 一个 Pi session，打开前先算完整 context fingerprint；fingerprint 和 session 文件都匹配才恢复，否则保留旧文件、新建 session、推进 epoch。规则见 [cache.md](cache.md)。
- `bot_cursors`（业务消费位置，只增不减）与 `bot_visible_messages`（当前 context 真正可见的完整消息）分开维护。压缩或换 session 只替换后者。
- 压缩由 Pi 原生触发（阈值 = `context_window − max(16384, context_window − compaction_threshold)`），摘要由 `tg-compaction` 用配置的 `compaction_model` 生成；失败或空摘要直接取消，不退回主模型、不退回 Pi 默认摘要器。
- 图片在 session 里只存引用，Pi 的 chars/4 估算看不到它们。runtime 在 Pi 准备压缩**之前**按每张 1,100 token 临时缩小 `keepRecentTokens`，结束后恢复。
- 主请求追加新批次前检查图片字节预算（`context_image_budget_bytes`），超限先压缩；压缩失败则本轮不发请求、保留 cursor 与义务。HTTP 413 被归一为 Pi 可识别的 overflow，由 Pi 原生 compact-and-retry 一次。
- 最近一条 assistant 是 error/aborted 时，阈值压缩被取消（避免在 provider 故障时叠加摘要请求）；overflow 恢复和手动压缩不受影响。

## 媒体

`media.mode` 决定媒体怎么到达模型。两种模式下语音、音频、非视频文件、TGS 动画贴纸都只有文字占位（Pi 只支持 image 内容块）。视频（含视频贴纸、GIF、video note）都用 `ffprobe`/`ffmpeg` 抽 1–3 帧；缺少 FFmpeg 时视频在下载前跳过，只留占位，不阻塞 daemon。

- **vision（默认）**：`vision.enabled: true` 时，辅助视觉模型为每个媒体生成一次文字描述，按 `file_unique_id` 持久化在 `media.vision` 并跨 bot 复用；描述作为 `media_update` delta 追加，主模型看到文字。每轮最多 `vision.foreground_media_limit` 个、全局并发 `vision.concurrency`。
- **context（opt-in）**：不调用视觉模型，图片/抽帧直接作为 image block 交错进主模型上下文，派生文件记录在 `media.context_files`。每轮最多 `media.max_images_per_turn` 张，每张按 1,100 token 计入预算，超出降级为文字占位。主模型必须支持图片输入，否则启动失败（`image_input_unsupported`）。
- 下载严格把 `file_id` 与拥有它的那个 bot 的 Bot API 配对；回复 bot 没有 mapping 时可用其他已配置 bot 的。
- 本地文件是可再生缓存：成功压缩后，所有已配置 bot 都不再引用（不可见、无待回复、无未消费 event）的文件按 ≤256 个一批删除；媒体行、描述、short id 与 file mapping 保留。

## Sticker

- `media.file_unique_id`/`short_id` 是共享身份；`media_file_ids(bot_id, file_id)` 才代表某个 bot 能发。
- system prompt 末尾是该 bot 可发送的固定目录（`s<id>: <emoji> <描述>`）。群友发出的、目录外但本 bot 也能发的 sticker，在它首次出现的那一批消息之后以一条〔系统附注〕列出（每批 ≤8 条），之后原样保留，不写入持久化内容（见 [cache.md](cache.md)）。
- `sendSticker` 直接用本 bot 的 `file_id`，不下载重传。

## 工具

固定为 `send`、`search`、`run_js`，顺序固定（cache 可见）。`src/agent/tools.ts` 是工具说明的唯一权威；系统提示里的“可用工具”声明按 bot 实际开启的工具生成。

- `search(query | url)`：TinyFish；query 最多 5 条短结果；url 只接受公网 HTTP(S)（本地预检 userinfo、localhost、私网、link-local），正文 ≤8,000 字符再截到 ≤2,048 token，并包在“不可信网页内容”边界里。日志不记录 query、URL 路径或正文。
- `run_js`：见下节威胁模型。
- 没有调用 send 的 assistant 文本只写本地事件和 TUI，session 里用固定 `[no_send]` 代替。

## run_js 威胁模型

- **威胁**：群成员通过 prompt injection 让 bot 执行任意 JS；最坏情况是读到 daemon 同 uid 可读的 `.env` 并外发。
- **防护**：vm context 由 `Object.create(null)` 创建并禁止字符串/wasm 代码生成，context 内没有任何 host realm 对象；结果只以字符串跨界。子进程 env 只保留 PATH、独立 tmp cwd、`--smol`、同步代码 3 s vm timeout、进程 5 s SIGKILL、输出 4 KB 上限。
- **残余风险**：node:vm 不是官方安全边界，引擎 0day 可打穿 realm；`--smol` 不是硬内存上限；SIGKILL 只杀直接子进程。OS 级隔离是后续增强，不在当前威胁模型内。默认关闭。

## Telegram 控制命令

- 只识别 offset 0 的 `bot_command` entity：`/help`、`/status` 公开；`/model`、`/compact`、`/new`、`/set` 需要 `telegram_admins` 中的人类账号。带 `@bot_username` 时定向到该 bot，否则作用于收到命令的 bot。
- 命令和回复的 message id 永久记录在 `telegram_control_messages`，**永不进入任何 provider context**。变更类命令串行执行，不 abort 在途回复；bot busy 时返回“请稍后”。
- `/model`：按钮分页列出 Pi 当前已认证的全部模型；`/new`：用当前模型开新 session。两者共用同一个 session 切换：先建好新 session，再在一个事务里写 epoch、manifest、清空可见集，失败时旧 session 原样保留；旧 session 文件留在磁盘。
- `/set routing_p|cooldown_ms` 校验后写穿 `telegram.config.ts` 并更新内存中的同一 `BotConfig`。
- `/status` 由确定性代码生成 Markdown，与 bot 发言走同一条本地 Markdown → entities 的经典 `sendMessage`（不用 Rich Message，旧客户端看不到）。

## Pi 界面与 IPC

- `/tg attach [bot]` 在 Pi transcript 里挂一个 TUI-only custom entry；消息、事件、图片用 Pi 原生组件渲染，滚动、resize、Kitty 图片由 Pi 负责。feed 内容不写 Pi session，也不进入 provider context。
- `src/plugin/timeline.ts` 是无展示逻辑的 IPC client。协议：`hello`（可带 bot filter）→ snapshot；`history` 分页（复合游标 `(ts, rank, id)`，同秒不丢不重）；推送 `append`、`usage`（daemon 重新聚合好的整份 `BotStats`）、`vision_update`、`media_ready`、`agent_stream`；`send_message` → `send_result`。
- socket 权限 0600；接收缓冲 4 MB、出站队列 1 MB，超限断开；history limit 服务端夹到 [1, 500]；渲染前剥离 ANSI/OSC 等控制序列。
- 未知 bot filter 直接断开，不降级为全局视图。daemon 与 extension 同仓库一起升级，不兼容新 client 连旧 daemon。
- compose：attach 后 editor 默认发到 Telegram；ACK 丢失或断线时结果算未知，关闭 compose、恢复原文、**不自动重试**。

## 进程管理与配置

- 配置只有 `telegram.config.ts`（受信本机代码，`defineConfig()` 提供类型）+ `.env`（`key: value`，只放项目自己的 secret）+ Pi auth store（模型凭据）。校验一次收集全部错误。
- daemon 启动最早一步用 `openSync(wx)` 独占 pid 文件；存活但无法确认身份的 pid 一律视为占用，绝不让两个 daemon 轮询同一 token。身份校验：Linux 读 `/proc/<pid>/cmdline` 与 `cwd`，macOS 用 `ps` + `lsof`，支持路径含空格。
- CLI `restart` 会停掉本 deployment 的 pid owner 和孤儿进程，等 PID、pid 文件、socket 全部消失后才启动新进程；新 socket 能真实连接才算 ready。生产推荐 systemd user unit（见 [runbook](runbooks/daemon.md)）。
- 一个工作目录只对应一个群：`data/`、DB、session、pid、socket 都由工作目录决定。多群必须用隔离的 clone。
