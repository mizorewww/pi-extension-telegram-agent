# 架构

> 描述当前代码真正做了什么。架构变化时同步更新。

## Process model

```
                         Telegram
                    /       |       \
               Poller 1  Poller 2  Poller N
                    \       |       /
                     daemon（单进程、长驻）
                     /      |       \
            ingestion   AgentSession×N   SQLite
             + router                       │
                     \      |              /
                      IPC（Unix socket JSONL）
                                  │
                    Pi interactive process（短生命周期）
                    ├─ Telegram transcript custom entry
                    └─ Telegram feed status widget
```

- **daemon**：唯一长驻进程。`composeDeployment()`按配置为每个 bot 建立identity state与runtime map，`composePollers()`建立同数量poller；router、Telegram control与IPC消费同一组动态id/name/user-id map。daemon同时持有 SQLite 与 IPC server。
- **Pi 插件**：没有独立 TUI 进程——chat UI 就是 Pi 插件本身：`.pi/extensions/tg-extension.ts`（Pi extension，拥有组件树与命令）+ `src/plugin/timeline.ts`（无展示逻辑的 IPC client）。项目 package 被 Pi 自动发现；通过 IPC 拉历史、订阅实时事件。关闭 Pi 或 `/tg detach` 不影响 daemon。

## 运行时与依赖

- 运行时：**Bun**（Pi SDK × Bun 兼容性已经 smoke 验证）
- Pi：registry `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-agent-core`、`pi-tui` 精确锁定为 v0.84.1；`scripts/pi-launcher.ts` 在 project-local CLI 缺失时执行 `bun install --frozen-lockfile`，随后始终以 Bun 启动 lockfile 对应版本。运行与构建不读取 sibling `../pi`。
- Telegram：raw Bot API（fetch long polling），无第三方 SDK

## Telegram ingestion

- 每个 bot token 一个 getUpdates long-polling 循环（offset 持久化在 SQLite）
- 每条 update：raw update→canonical message/revision→immutable `message_events` delta→`pending_telegram_dispatch`→offset 在一个 SQLite transaction 提交；任一步失败整体回滚。poller 先交付持久化 handoff，routing/control 回调成功后才删除；失败与重启优先恢复该 handoff，之后才继续拉取。每 bot 最多一条 pending，raw retention 不删除其来源。canonical以(chat_id,message_id)去重，更旧或同时间的 edit 不回写 canonical；second-bot副本可只补齐null `reply_to_sender_id`并追加metadata delta。`external_reply`（跨群引用）不入 canonical——父消息不在本群 `messages` 表，模型侧引用渲染为 `(原消息不可见)`。`rich_message` 也走同一 normalize：canonical列只保存≤256 KiB source（超限为有界JSON诊断），`text`保存确定性plain projection；projector上限为16层、500 blocks、4096 nodes、32768 code points，未知metadata不泄露URL/file id。revision保留旧source/projection，provider只读取不可变event projection。
- Telegram create 是不可回滚的 commit boundary。Bot API 返回 Message 后先按 25/100/250 ms 有界重试 canonical SQLite/event insert，再更新 context visibility、broadcast、agent event 与 typing cleanup；这些后置副作用任一失败都只能返回 terminal `committed/no_retry`并写脱敏`send_degraded`，绝不把整次tool call抛回模型。timeout、断线、非JSON、429/5xx等无法证明未创建的结果直接terminal `unknown/no_retry`；message已提交后sticker失败则是`partial/no_retry`。poller echo继续以canonical/event key完成本地幂等恢复。
- agent `send.message` 先由Pi TUI公开的`Marked` lexer和本地有界renderer转换为classic `sendMessage {text,entities?}`；普通paragraph没有style entity，显式Markdown才产生格式。只有Telegram明确以确定性400拒绝entity/format且确认未创建消息时，才对同一生成text做一次无entities fallback。operator manual compose仍保持literal plain text，两条路径复用`src/telegram/send.ts`的send→canonical persistence primitive；incoming RichMessage normalize/raw persistence/projection继续保留。

## Routing

- deterministic：`u = HMAC(router_secret, chatId + ":" + messageId)` → 按配置数组顺序累积 `routing_p` 阈值：`u < p[0]` → bots[0]；`p[0] ≤ u < p[0]+p[1]` → bots[1]；…否则 nobody（Σp ≤ 1 启动期校验）
- 优先级：明确 @mention > reply target > 名字关键词 > 概率 routing；每级扫描全部 bot 后才进入下一级，mention 支持 text 与 caption
- Bot 消息不进 trigger（`routeMessageDecision` 内部单一权威判断）
- router 返回target + reason + chat/message id；reply先认canonical `reply_to_sender_id` snapshot、再查父行。只有 `probability` 走runtime availability gate；bucket先按原HMAC决定，目标busy/cooldown时直接skip，绝不改投其他bot。
- 每 bot 的 probability run 完成后用 monotonic deadline 冷却 `sampling_cooldown_ms`（默认 2000 ms）；deadline 不设 timer、不补抽，之后只有新消息才重新采样。不同 bot 仍可并发。
- mention/reply/name 是 explicit path：配置 `name` 在 text/caption 中字面命中（例如“小雨”命中“我叫小雨”）即使 `routing_p=0` 也成立；busy 时继续 pending coalesce，cooldown 中也可立即启动；shutdown 不等待 cooldown。
- Telegram control 只开放 `routing_p` 与 `cooldown_ms` 两个可变项：`/set` 经 `updateBotConfigField` 写穿 `telegram.config.ts`（配置文件是唯一权威，新值重启后仍生效），并同步更新内存中的同一 `BotConfig` 对象，router/runtime 下一次决策立即读取新值。任何 routing set 都先按全部配置 bot 原子校验 Σp≤1；校验失败不落盘、不改内存。
- Telegram control service只接受offset 0的`bot_command` entity；命令固定为 `/help`、`/status`（human public read）与 `/compact`、`/set`（admin mutation），带 `@bot_username` 后缀时定向到对应 bot。未知命令、未知后缀不接管，参数严格按固定arity/type解析。daemon在normal route前同步分流，所有mutation共用一个串行队列；manual compact先占runtime control lock，只在idle时无instructions调用Pi `session.compact()`，期间explicit coalesce、probability fast-skip，绝不abort在途回复。`/status` 只展示实际接收/后缀定向的单个bot，并从其Pi session读取实时context usage；compact后Pi明确返回unknown，直到下一次主请求，绝不把旧epoch usage配给新epoch。状态由确定性代码同时生成有界的InputRichMessage Markdown与独立plain projection；正常只调用一次`sendRichMessage`，仅在Telegram以400/404明确证明方法/格式未创建消息时单次plain fallback。其余回复保持plain；所有回复都由suffix目标或实际接收bot走Telegram create→canonical DB→IPC broadcast，并用`reply_parameters`引用原命令。timeout/断线/429/5xx/非JSON等unknown outcome与local failure只脱敏记录、不远端重试。`telegram_control_messages` 独立保存永久 identity，不受 telemetry retention 影响，跨restart/epoch排除这些message id；compact替换visibility也不会送入provider。每bot启动并行best-effort `setMyCommands`（help/status/compact/set 菜单），失败不阻塞polling。
- route acceptance先取得`routing_claims` durable claim；insert/enrichment/replay只会让同一bot启动一次。pending/nonaccepted可重取，accepted started/coalesced永久抑制重复；probability bucket和explicit优先级本身不变。
- human direct address（explicit @mention / reply / 配置名称点名）在provider前已持久化per-bot obligation；所有类型统一由 runtime trigger 按最终路由目标在消息尚未可见时幂等创建；poller 的 durable handoff 保护触发前的恢复窗口。flush最多索引读取256条近期event与64条obligation event，先打包全部可容纳的pending direct-address消息，再从最新普通event向前选择并恢复Telegram顺序。普通overflow可以推进cursor但不标visible；pending direct-address消息不因普通预算被删除，并按后续flush继续交付。只有结构化custom message与commit marker持久化后才清obligation；失败/stop保留，startup从session details幂等reconcile。
- accepted trigger 同步 acquire per-bot Telegram `typing` lease：当前目标是 supergroup，只调用 `sendChatAction`，不调用 private-only message/rich draft。单个递归 timer每4秒续约且最多一个in-flight；release同时abort在途action，避免短回复已发送后迟到的action重新点亮5秒状态。沉默/异常/abort/flush settle/shutdown由finally兜底，coalesced pending在下一轮flush重新acquire。side channel失败按streak脱敏告警，不写DB/IPC/provider context，也不改变cursor、visibility、routing、cooldown或send结果。

## Agent

- 每 bot 一个 `createAgentSession()`，各自拥有SessionManager和DefaultResourceLoader；整个daemon只创建一个Pi `ModelRuntime`。shared runtime通过Pi原生`createAgentSessionServices()`加载用户级已安装provider extension的catalog/auth/cost registration，但以untrusted project scope排除项目extension；bot session仍只加载本项目固定hidden extensions与tools。各session绑定解析后的provider/model/reasoning/cache retention。shared runtime在pid lock后、任何Telegram调用前刷新被选中的extension provider并预检全部聊天、compaction与启用的vision模型；`media.mode: "context"`时每个聊天模型的catalog `input`还必须包含image——上下文媒体以image内容块直接交给主模型，不支持会把所有媒体静默降级为文本占位——否则按`image_input_unsupported` fail fast（默认vision模式无此要求）。live refresh失败可继续使用插件baked/persisted catalog，但模型缺失、认证缺失或不支持reasoning仍fail fast。Pi SDK会静默clamp不支持的档位，本项目禁止这种requested/effective分叉；认证完全由Pi auth store提供。
- runtime在打开session前计算完整context fingerprint（Pi/provider/api/model/reasoning/cache retention/schema/shared protocol/persona/serializer/compaction/catalog snapshot/extensions/tools）。manifest fingerprint与session文件都匹配才resume；否则保留旧文件、创建新session、推进epoch并清当前visibility。
- 固定hidden extension顺序为`tg-context → tg-compaction → tg-cache-observer → tg-assistant-persistence`。shared protocol是system prompt首段，persona随后，sticker catalog block（`s<id>: <emoji> <描述>` 行）在末尾。主模型有效context window = min(Pi catalog `contextWindow`, 顶层 `context_window`，默认 65,536)；compaction 触发点 = window − max(16,384, window − compaction_threshold)，threshold 超过 context_window − 16,384 会被配置校验拒绝；压缩后保留最近 `compaction_keep_recent` token 原文（单位是 token：缺省 1 token 实际不保留完整 turn、只剩摘要；生产推荐 20,000）。
- 触发/flush 是 BotRuntime 串行状态机：`idle → flushing → idle`。在途trigger只合并为`pendingTrigger`；shutdown最多等待30秒。每轮从`message_events`按cursor做有界索引读取，随后按`media.mode`分流媒体准备（见「媒体模式」）：vision模式对有描述缺口的媒体做有界lazy vision（新描述以`media_update` event追加入队，同轮按新high-water重扫一次使本批立即看到描述）；context模式经`ensureBatchContextMedia`为本批有图媒体准备派生图片（只下载+转码，零LLM调用）。再用保守token估算打包成`telegram_context_v2` custom message（details version 4，`blocks`保存text|image交错；context模式每张图片固定计1,100 token）。Pi 的`sendCustomMessage(triggerTurn)`会在promise返回前执行完整provider/tool turn，因此本批完整打包的message id先获得turn-local内存可见性，使同轮`send.reply_to`可通过preflight；session提交失败则从structured entries恢复。只有session持久化成功或startup reconcile证明entry存在后才推进durable cursor/visibility。
- 群消息、edit、metadata与media completion（vision模式）使用固定紧凑grammar追加；写入session的message entry字节永不重算——vision描述以`[media_update #id] [图片: 描述]` delta追加，context模式准备好的图片作为image内容块交错在所属消息位置。recent sticker候选独立存进structured details，provider只在最后一个Telegram batch后投影一次。恢复和compaction只读structured details，不从文本正则反推identity。成功compaction只替换visibility与epoch，业务cursor永不回退；visibility commit之后同步运行一次最多256项的本地媒体回收observer，observer失败不会回滚compaction。
- tools 固定为 `send`、`search`、`run_js`，禁用 coding agent 默认文件工具。`src/agent/tools.ts` 是 provider-facing 用法唯一权威；persona/protocol 不复制参数。`src/agent/send.ts` 拥有 send preflight、远端提交与全部后置副作用边界；耗时/observer 失败不能覆盖 terminal 结果。`send(message?,sticker?,reply_to?)` 是唯一公开通道，`message` 为自然Markdown；本地仅映射bold/italic/strike/code/public link/heading/list/blockquote/simple table等固定子集，不启用HTML/MarkdownV2 parser或远程图片。完整成功返回固定 `ok`，远端 committed/partial/unknown 的退化路径返回固定 `no_retry`，两者都用 `terminate:true` 阻止 follow-up provider call，sent ids 只留本地 details/event。
- `search(query?|url?)`复用同一TinyFish tool且强制二选一：query只发送现行`query`并在本地保留≤5条短结果；url只允许≤2048字符的public HTTP(S)，本机不做DNS/GET，提交一个URL到Fetch API。fetch固定一页、≤1 MiB、≤8,000字符/50秒，进入provider前再截到≤2,048 tokens并套untrusted boundary；事件不记录query、URL path/query/fragment、正文或key。群消息不会触发eager fetch。
- local assistant text（未调send）→ agent_events + TUI；session里只保留固定`[no_send]`，不把未发布prose带入后续provider context。

- provider watchdog 只负责单次请求从创建 stream 到消费结束的 deadline 与取消；聊天使用 Pi session retry，摘要使用 Pi `retryAssistantCall`，共用 `provider_retries`，adapter retry 设为 0。摘要只请求配置的 compaction model，传递 compaction signal，停止时 abortCompaction，不另切主模型。

## run_js sandbox 威胁模型

- **威胁**：run_js 输入来自 LLM，LLM 上下文来自群消息 → 群成员可经 prompt injection 让 bot 执行攻击者构造的 JS。最坏情况是读到 daemon 同 uid 可读的 `.env`（全部 bot token / API key）并联网外发。
- **防到什么**：vm context 由 `Object.create(null)` 创建且 `codeGeneration: { strings: false, wasm: false }`，context 内**不存在任何 host realm 对象/函数**——`console.log.constructor` / `this.constructor.constructor` / `Function` / `eval` 全部拿不到 host `Function`，逃逸链在第一步就断。console/日志在 context 内部 bootstrap；结果只在 context 内 `JSON.stringify` 后以字符串跨界（primitive 跨界安全）。child 进程 env 被 scrub（仅 PATH，无 secret）、隔离 tmp cwd、`--smol` 限内存、同步代码 vm timeout 3s、进程级 5s SIGKILL 兜底、输出 4KB 上限。
- **残余风险（明确承认）**：
  1. node:vm 官方声明不是安全边界；若引擎层 0day/未知向量打穿 realm 隔离，child 仍以 daemon uid 运行，可读 `.env`、可联网。缓解：child env 不含 secret（secret 只存在于 daemon 进程内存与磁盘 `.env`），但这不防「直接读磁盘文件」。
  2. `--smol` 是内存使用倾向而非硬 rlimit；内存硬上限依赖 5s SIGKILL 兜底。
  3. SIGKILL 只杀直接 child；若 vm 被打穿后 spawn 孙进程，孙进程脱离超时范围。
  4. vm timeout 只约束同步代码；异步 microtask 膨胀由 SIGKILL 兜底（实测 Bun 下约 vm timeout 即被打断）。
- **为什么可接受**：纵深防御（realm 隔离 + codegen 禁用 + env scrub + 资源限制 + 超时）使攻击需要未知引擎漏洞而非已知技术；单人项目、威胁源限于群成员 prompt injection。OS 级隔离（低权用户 / seatbelt / seccomp）列为后续增强，非当前威胁模型的必要项。

## SQLite

- 见 docs/data-model.md。WAL 模式，直接 SQL

## Observability 与 debug

- `src/observability/log.ts`是daemon生产日志唯一入口：schema v1 JSONL、flat bounded fields、secret/content-shaped key与credential/URL/path二次脱敏；sink失败永不改变业务结果。controller在spawn前把`daemon.log`按8 MiB轮转，保留3代并统一0600。
- 日志覆盖daemon/ingest/routing/runtime/provider/tool/send/IPC/media边界，但不承担业务authority。SQLite routing claims、cursor/obligation、agent events与llm runs仍是durable evidence；日志用既有bot/message/run/epoch identity关联，不保存正文、prompt/response/thinking、tool args、完整URL/path或stack。
- `bun run debug`通过不暴露credential的deployment loader、本机Pi模型目录、readonly SQLite/Pi session与最后64 KiB JSONL生成有界业务报告；模型目录解析不发网络请求，只输出requested/effective/supported reasoning与固定category。报告默认重建无正文的完整pre-adapter provider结构；显式单bot开关才把完整system与active messages写到stdout。机械finding还区分unsupported reasoning、cursor backlog、pending reply、route无run、model silence、tool preflight failure与send degraded。完整调查流程和新功能门禁见`docs/engineering/debugging-guide.md`。

## Pi 原生 Telegram transcript

- package 入口是 `.pi/extensions/tg-extension.ts`；`package.json` 的 `pi.extensions` 使项目可被 Pi 自动发现，规范启动命令是 `bun run pi`。
- `/tg attach [bot-id]` 通过 `registerEntryRenderer` + `appendEntry` 在 Pi 自己的 transcript 中挂载一个 **TUI-only custom entry**。一次 attach 只写一个锚点；Telegram snapshot、实时消息和历史页只存在于该 entry 的内存组件树，不逐条写 Pi session，也不进入 provider context。
- 消息、LOCAL 事件、日期与媒体由 Pi 的 `Container`、`Box`、`Text`、`Image`、`Spacer` 和 theme 组合。Pi fullscreen host 拥有滚动、resize、选择、editor、宽度处理及 Kitty image placement/cropping；项目不持有 viewport、终端尺寸、键盘处理或 ANSI 主题代码。
- `src/plugin/timeline.ts` 是无展示逻辑的 IPC client，只负责连接、snapshot/live/history、复合游标、去重、stats 合并、有界媒体读取与 ephemeral stream frame 转发。
- public extension API 没有 transcript scroll-top 事件，因此更早历史由 `/tg more` 显式加载；`/tg detach` 只断开 live socket，已显示内容保留。session restore 的旧锚点以 detached 状态呈现，不自动重连。
- attach 通过官方 `ctx.ui.setWidget` 在 editor 上方显示一行 feed scope、连接与 compose 状态，并从 factory 取得真实 host `TUI.requestRender()`；attached期间用官方`ctx.ui.setFooter`按Pi原生顺序显示路径与Telegram usage/model，其他extension status仅在存在时追加，隐藏无关的operator usage行。Pi没有把远端usage注入原生`FooterComponent`的公开接口，所以插件复刻布局但不伪造或读取Pi session；detach后恢复默认footer。
- `/tg` 只注册一个 Pi slash command；声明式递归 command tree 是 syntax/help/dispatch/completion 的共同来源。`getArgumentCompletions` 返回 replace-entire-argument value，动态节点只从启动期已验证 config 缓存 bot `id/name`，不读 DB、网络或 secret。
- IPC：Unix socket JSONL，daemon 为 server；协议 = hello（可带 bot filter）/ history 分页拉取 / event 订阅 / usage 增量推送 / additive `send_message`→`send_result` / additive `agent_stream` / identity-only `vision_update`与owner-local `media_ready`。stats baseline 同时携带每bot的runtime snapshot，使`/tg status`使用daemon已经解析的effective model/reasoning/context window，而不是在插件进程重建第二份真相。daemon 与 Pi extension 同仓库原子升级：stats/usage 字段是必填契约，不支持新 client 连旧 daemon 的滚动重启窗口；旧 client 忽略新 daemon 的未知字段仍允许（additive 演进只向新字段方向开放）。
- **manual send（daemon contract）**：extension 只提交 request id、bot id 与纯文本；daemon 校验身份/空文本/4096 字符上限，在有界 256-entry request cache 中合并并发重复，再调用 Telegram。API 成功后先写 canonical DB、再 broadcast、最后 ACK；ACK 丢失不触发 daemon retry。相同 id 不同内容返回 conflict；API/DB 边界给出 explicit failure/unknown outcome，token 不出 daemon。
- **原生 editor compose**：成功`/tg attach [bot-id]`自动建立scope compose。filtered scope或全局唯一bot直接得到身份；全局多bot在每次interactive提交时调用Pi公开`ctx.ui.select`，取消恢复原文并保持`handled`。`/tg compose <bot-id>`是sticky override，`compose off`让editor回到Pi，bare `compose`恢复scope。editor上方的单行feed header在`attached`后以独立强调色持续显示`send as ...`或`choose bot on send`，选择/发送中的状态原位更新；compose不再占用footer行。extension不替换editor/select，只拦截interactive `input`且不写Pi session/provider context；RPC/extension source继续交给Pi。选择/发送期间拒绝第二次提交；明确失败恢复原文，ACK超时/断线恢复原文并关闭compose、提示先查群且不自动重试。附件不降级。generation使attach replacement、detach、restart/config、daemon断线与session shutdown后的迟到选择/ACK不能关闭或使用新scope。
- **传输层**：FrameDecoder 持单个 streaming TextDecoder（多字节字符跨 chunk 不腐蚀）；接收缓冲 4MB 上限，超限断开；socket.write <0 即踢连接，出站队列 1MB 上限，超限断开（TUI 挂起时 daemon 内存有界）
- **分页**：merged timeline 统一排序键 (ts, rank, id)（rank 0=agent 事件，1=群消息），history 用复合游标，同秒多条消息不丢不重。
- **本机暴露面**：socket 文件 chmod 600；history limit 服务端夹取 [1,500]
- **终端注入防护**：渲染前 strip ANSI/OSC/DCS 转义与控制字符（保留 \n/\t），群消息无法清屏/改色/写剪贴板（OSC 52）
- **竞态去重**：snapshot 与 broadcast 重复条目按 (chatId,messageId)/(evtId) 去重；翻页补日期分隔线
- **attach 过滤**：`/tg attach <bot-id>` 以单 bot 视角观察——daemon 端对 snapshot / history / broadcast / usage 过滤 agent_events（群消息始终全量）；不指定时为全局视角。listener在有效hello建立global或单bot scope前保持静默；extension先按本地配置校验id，daemon在hello边界独立校验，stale/未知filter必须断开listener，绝不静默降级为全局视角。
- **统一 usage/status telemetry**：Pi `/tg status` 与 Telegram `/status` 共用 `docs/telemetry.md` 的状态读模型、字段和公式。每个response按其实际provider/model当时费率固化cost，SQLite retention totals跨模型只求和、不按当前catalog回算。SQLite 保留期 totals、最新主对话 run 与 daemon runtime snapshot只在一个共享字段投影中合并；Pi plain与Telegram plain/rich只负责外层渲染。compaction usage参与totals但不替换latest。全局只聚合当前配置bots并取最新主对话run的model。snapshot附全历史基线（`lastId`防live双计），每条主对话或compaction usage都经additive IPC推送。attached feed把同一数据投影成Pi同构的路径与usage/model footer并共享费用formatter，compose状态留在feed header，不混入operator usage；detach/断线/restart/config/shutdown时清理并恢复Pi默认footer。
- **Pi 原生 assistant activity**：runtime在session policy改写未发布正文前取得原始assistant content blocks，并以一次`agent_start → agent_settled`为一个有界activity（最多64 sections/512 KiB）。live `agent_stream`保留thinking/text顺序，feed用Pi公开的`AssistantMessageComponent`显示完整普通输出、Markdown与真实thinking，用`ToolExecutionComponent`显示pending/success/error工具调用；formatted/plain send和最终outcome依发生顺序留在同一张临时卡。settle后只持久化一条`agent_activity`展示投影并移除stream；带同一`activity_id`的原始`agent_events`仍是SQLite/debug authority但不在timeline重复建卡，旧的无id事件继续显示。feed最多保留32张临时卡，end/abort/disconnect原位移除，迟到ended id被有界tombstone忽略；extension从`setWidget` factory保留真实 host `TUI.requestRender()`，Pi宿主继续拥有合帧与刷新。
- **卡片信息层级**：Telegram消息卡主标题固定为display name + `@username`（存在时），右侧只放message id、own bot id、时间与edited状态；bot/local activity同样把身份和状态分列。用户名颜色由稳定identity hash从Pi当前theme的语义/语法色中选择，不写死RGB，背景与正文仍使用Pi原生message tokens。相同身份跨卡同色，不为颜色引入持久状态或provider bytes。
- **媒体内联**：终端能力只读 Pi `getCapabilities()`。PNG 直接交给 Pi `Image`；Pi 判定为 Kitty protocol 时，JPEG/WebP/GIF 先用 coding-agent 公开的 `convertToPng()` 异步归一化，完成后只重建引用同一文件的原生卡片并请求 host render。sticker 使用 Pi `Image` 的 24×12 cell 上限，photo 等其他图片保留 56×16；比例、窄宽度 clamp、resize、crop 与 fallback 仍全部由 Pi 负责。转换按 path + size + mtime revision 合并 in-flight，结果/失败共用最多 32 项、32 MiB 的 LRU（单项 8 MiB，pending 32）；detach/restart/shutdown 会移除旧 feed callback。iTerm2/无图像能力继续走 Pi 自身 Image/fallback，TGS/WebM不作为inline image并保留文字占位。IPC 只传≤1 MiB static display path与`mediaDesc`（vision模式持久化描述）；video source与上下文派生图片绝不进入IPC。base64与绝对路径不进入日志、DB或session，SQLite只保存cache-relative basename。
- **media readiness**：poller先提交raw/canonical/offset，daemon再broadcast placeholder并把 user/bot 的 static photo/sticker identity交给同一个后台queue；animated/video sticker与普通video不由display queue下载，其source只在真实消费它的管线中lazy拉取——vision模式在真实vision turn中，context模式在flush打包前的上下文媒体准备阶段（见「媒体模式」）。live queue按identity去重、最多2 active/128 pending；startup只从仍有活跃引用的缺口中按最新`media.rowid`排100条static display backfill，compaction已回收的无引用历史不会在restart时复活。display cache与两种媒体准备管线共享同一Telegram download in-flight；下载source必须保持`media_file_ids.bot_id/file_id`与同一个bot的Bot API配对，优先回复bot自己的mapping，不存在时使用任一已配置且拥有mapping的接收bot，绝不能把一个bot的`file_id`交给另一个bot。≤1 MiB static display image和≤20 MiB video source都以hash basename写同目录0600临时文件后rename，SQLite成功后才保存basename；只有static image广播`media_ready`。timeline用256项/10分钟乱序cache合并display path，shutdown先stop/abort queue再关DB，失败只留label fallback与脱敏聚合。
- **media lifecycle**：当前配置bot的任一visible message、pending reply obligation或尚未消费的非`media_update` event都会保留其本地文件。引用检查通过 canonical media identity 的 TEXT 表达式索引定位消息，不逐文件扫描历史。成功compaction提交新visibility后，daemon按同一deployment-wide判定删除最多256个无引用cache identity：先把DB basename约束到当前`data/media`，source与`media.context_files`列出的派生上下文图片一起unlink，`local_path`与`context_files`同时置空；其他失败保留path供后续compaction重试。canonical message/event、media identity/format/short id/vision结果、bot-specific file mapping与Pi session均不删除，所以未来重新需要时可下载source且不重付已有vision结果，或重新准备派生图片。

## 媒体模式

`media.mode` 选择媒体如何到达模型：`"vision"`（默认，历史行为）由辅助视觉模型把媒体描述成文字；`"context"`（opt-in）把图片作为image内容块直接交给主模型。两种模式的共同边界：voice、audio、非视频document与TGS动态贴纸永远只有文本占位——Pi 0.84.1只支持image内容块，没有audio/file block，这是硬限制；TGS只保证可发送，不进入下载或渲染。视频（`video`、`animation`、`video_note`、video MIME document与video sticker）在两种模式下都用`ffprobe`读时长、`ffmpeg`抽1–3帧（1帧50%，2帧33%/67%，3帧20%/50%/80%；时长<1s取1帧、<3s取2帧），输出≤1280×1280 JPEG，绝不整段交给模型。

daemon启动只读检查`ffmpeg`与`ffprobe`；缺失任一工具且当前模式需要抽帧（`vision.enabled`或context模式）时，startup log记一条non-blocking advisory（category `video_transcoder_unavailable`，`blocking=false`），`start`/`restart`/`status`给operator用途与安装建议，`bun run debug`输出带固定impact/action的同名finding；不阻塞ready，不影响photo/sticker链路或三种sticker发送，也不向群内用户发故障消息。安装并restart后自动重试；probe/抽帧失败不记录stderr/path。

### Vision（默认模式）

- 默认关闭；只有显式`vision.enabled: true`才启用；`auxiliary_visual_model`只选择任务模型，不隐式开启功能。图片落库即可显示，UI不触发vision。该配置段只在vision模式生效。
- 识别结果按 media identity 持久化在`media.vision`，所有配置 bot 共享（vision cache）。
- photo、static sticker、video与video sticker使用各自prompt语义。视频帧全部进入**一次**`completeSimple()`；JPEG/PNG原样作为Pi `ImageContent`发送，静态WebP/GIF先走Pi公开`convertToPng()`。provider请求固定256 output tokens、90秒timeout、retry 0，临时目录随后删除。
- `vision.enabled`时，daemon在任何Telegram调用前把视觉选择与所有聊天模型一起交给唯一Pi `ModelRuntime`做catalog/auth预检；视觉默认/示例为严格的`provider/model:effort`引用`openai-codex/gpt-5.6-luna:low`，不接受旧拼写别名。模型缺失、未认证或不支持image input均按固定category终止启动，项目不读取credential。
- 缺`ffmpeg`/`ffprobe`时，视频链路在Telegram下载和provider调用之前立即返回`video_transcoder_unavailable`，不持久化terminal vision cache；static image vision不受影响。
- production vision event只含kind、frames、providerCalled、source/converted bytes bucket、latency、input/output/reasoning token、cost与outcome；不含media identity/path/prompt/response。deployment scheduler是默认并发2的单FIFO门，每轮foreground最多`vision.foreground_media_limit`（默认2）。图片只在provider调用时占scheduler；视频在下载前占用同一个deployment-wide slot，直到抽帧与单次provider调用结束，因此所有bot合计最多同时运行`vision.concurrency`条视频流水线。direct reply媒体优先；失败或unsupported使用确定性fallback。
- foreground vision的runtime可以与最先收到Telegram update的bot不同；本地媒体层必须复用正确接收bot的下载能力，只有所有已配置bot都没有该media mapping时才返回`file_id_unavailable`。这不增加provider call、retry或等待第二个poller。
- 新的非空描述持久化后追加唯一`media_update` event；已经写入session的message entry不重算、不重写。固定 sticker catalog 不做 vision 回填，但已持久化的描述会渲染进 catalog 行并参与 fingerprint（描述落地即开新 epoch）。
- 新的非空描述成功写入 DB 后，`ensureVision` 只发布一次 `(fileUniqueId,text)`；cache hit、unsupported、空结果与失败不发布。background catalog 与 lazy batch 共用同一 in-flight promise，因此 UI transport 不增加 vision provider call。
- `MsgItem.fileUniqueId` 与 additive `vision_update` 经 daemon IPC 广播给所有 live transcript；单bot filter只过滤LOCAL/usage，不过滤共享群消息及其视觉描述。旧 client 可忽略新字段/帧。snapshot/history 仍从同一 `media.vision` 读取，provider serialization 不变。
- timeline 以 256-entry / 10-minute map 有界缓存乱序 update；message/live/history 到达时按 `fileUniqueId` 合并。已显示消息收到新描述时，feed 更新所有匹配 item 并用 Pi component tree 原位 rebuild，不追加 session entry；重复 update 幂等。
- media card 在图片或 fallback 正下方用 Pi theme `Text` 显示 `Vision · <text>`，snapshot 与 live 文案一致；显示前继续走 `sanitize()`，ANSI/OSC 不进入终端控制流。

### Context（opt-in）

- 不做任何视觉模型调用；主模型直接收到交错在消息位置的image内容块。媒体准备只做下载+转码，零LLM调用，不生成文字描述。历史已持久化的 vision 描述同样绝不注入：本模式不产生任何 `media_update` 事件（live 路径只在 vision 模式运行；旧 vision 缓存的 ingest 回放与 bot 自发 sticker 的持久化路径按模式 gate），媒体只以图片块到达模型。
- 范围：photo与静态sticker（WebP/GIF先走Pi公开`convertToPng()`转PNG，再经`resizeImage`；resize失败保留转换/原图）；视频类按本节开头的共享规则抽帧。
- 时机与预算：flush打包前`ensureBatchContextMedia`处理本批事件，direct-reply obligation消息优先；每轮最多`media.max_images_per_turn`（默认4，0=完全关闭）个媒体身份、`media.download_concurrency`（默认2）并发。同一identity跨bot只准备一次（`dedupeInFlight`合并in-flight，`media.context_files`命中直接复用）。准备失败记`agent_events` error（`stage=context_media`），该消息仍以纯文本占位进上下文，失败是transient，后续轮次重试。准备媒体的runtime bot可以与最先收到update的bot不同：本地媒体层复用任一拥有该media mapping的已配置bot的下载能力，不增加provider call或等待第二个poller。
- 派生文件：`data/media/`下`<sha256(fileUniqueId#ctx)>.png|jpg`，视频为`<sha256(fileUniqueId#frameN)>.jpg`（0600临时文件后rename）；DB `media.context_files`存JSON `[{name,mime}]`，与source同属media lifecycle回收（见上节）。
- token计费：每张上下文图片固定估1,100 token（`CONTEXT_IMAGE_TOKEN_ESTIMATE`，provider按tile/patch计费，用保守常量保持打包确定性）；超suffix预算或超每轮图片上限的媒体降级纯文本占位；force-cap保留的mandatory event永远纯文本。
- 上下文扩展details v4（`TELEGRAM_CONTEXT_VERSION=4`）：`blocks`保存text|image交错，相邻text合并；投影时resolver把image ref同步读成本地base64 `ImageContent`，文件已回收/缺失则丢弃该块，绝不抛进projection。resolver只在context模式接线；无图片或无resolver时投影保持历史纯字符串路径字节一致。sticker候选suffix追加到最后一个text块。
- 主模型image input是启动硬要求（仅本模式）：shared runtime预检每个聊天模型catalog `input`含image，否则按`image_input_unsupported` fail fast（见Agent节）。自定义OpenAI兼容provider通过Pi原生`~/.pi/agent/models.json`注册（声明`input: ["text","image"]`、contextWindow、maxTokens），不经过项目extension。

## Sticker 可发送性

- `media.file_unique_id` / `short_id` 是共享身份；`media_file_ids(bot_id,file_id,file_unique_id)` 才是 bot-specific 可发送能力。
- catalog block 只用当前 bot mapping 过滤后的可发送 sticker 构建；set name 不能证明可发送。固定 catalog 每行为 `s<short_id>: <emoji> <描述>`（描述为持久化 vision 文本，缺失时逐级降级为 `s<short_id>: <emoji>`、`s<short_id>`），按 set 名 + rowid 排序，set 名与 format 不进入模型可见文本；上限 `STICKER_CATALOG_MAX` 条，完整进入 stable prefix。catalog snapshot hash 覆盖 short_id + emoji + 描述文本，任一变化开新 epoch。
- runtime 不恢复旧的全库语义 top-K；它只从当前 generation 真正 visible 的消息与本轮新 visible 消息中选最近 8 个不同的用户 sticker，再按当前 bot mapping 过滤，行格式与固定 catalog 一致（`s<id>: <emoji> <描述>`）。候选块不写入持久化字节，只在 context 投影时追加到当前最后一批消息之后（每请求重建、只出现一次），预算不足整体省略；历史 sticker 的 short id 按 `s<media.rowid>` 惰性补齐。
- `sendSticker` 直接使用当前 bot mapping 的 Telegram `file_id`，同一路径支持 `.WEBP` static、`.TGS` animated 与 `.WEBM` video sticker；不下载重传，也不跨 bot 混用 file id。
- `send` tool 在任何 network call 前再次用同一 mapping 做 preflight；若已提交的 short id 缺 mapping，记录 `candidate_invariant`，不会先发文字再失败。
- catalog 启动日志给出fetched/catalog/sendable/missing_file_id；缺mapping行不进入 catalog block。short id仍可由本地send preflight解析。

## Provider context flow

- 稳定prefix：共享群聊protocol先于persona，末尾是 sticker catalog block（`s<id>: <emoji> <描述>` 行），之后是固定顺序tool name/description/parameter schema。
- 动态suffix：有界immutable event batch（context模式下图片以image块交错在消息位置，不产生 `media_update`；vision模式描述以`media_update` delta追加）、direct-address obligation与tool outputs只追加；最近上下文 sticker 候选是本轮 event projection 后的最终有界块（与目录同一行语法，携带已持久化描述；context 模式图片本身已在上下文）。
- `bot_cursors`保证业务消费单调；`bot_visible_messages`只表示当前generation真实可见的完整消息。两者不混用。
- 成功compaction替换visible refs并开启新epoch但不改cursor；完整fingerprint不匹配则在restore前建立新session/epoch。
- payload observer只持久化deployment-local HMAC和首个差异位置；不保存provider plaintext。

## 配置

- **`telegram.config.ts`**（项目根，唯一配置文件）通过`defineConfig()`提供静态字段类型与注释；它是用户明确信任的本机代码，不是sandbox。除identity/routing/model/tools外，顶层和per-bot可配置`cache_retention`、compaction model/threshold/keep、`max_suffix_tokens`、`max_message_tokens`；顶层另有`context_window`（默认65,536，范围32,768–10,000,000，钳制Pi catalog `contextWindow`）、`media`段（`mode`：`"vision"`默认 / `"context"` opt-in；context模式的`max_images_per_turn` 0–16默认4、`download_concurrency` 1–16默认2）与vision scheduler（`vision.enabled`/`foreground_media_limit`/`concurrency`，仅vision模式生效），deployment另有telemetry/raw/event retention。canonical example显式选择Luna/off/short、media mode `"vision"`、关闭search/vision并使用12k/4096上限。旧配置省略provider/model时仍读取Pi defaults以保持兼容，但reasoning默认`off`；跨provider覆盖必须显式给model。
- **`.env`**（`key: value`冒号格式，自解析）+ `.env.example`：只放项目拥有的secret（bot tokens / TinyFish / router_secret / gpg passphrase）；Pi auth store独占provider credential。旧`.env`中的provider key即使保留也不会被loader读取，配置、启动日志与运行时对象均不含其env key或值。
- **onboarding write boundary**：`src/onboarding/config-core.ts`只接受完整内存draft；先校验peer、Telegram token/env key与persona，再将`.env`、typed config与private persona写为各自同目录0600临时文件。fresh `.env`只含Telegram token；向导把已经通过catalog/auth预检的Pi provider/model固定进新config，其余字段省略，由`src/config.ts`默认值作唯一权威。旧手写配置仍可省略provider/model兼容继承Pi。create模式遇到任一现有目标即保留并拒绝；明确replace才先rename到唯一backup，再安装全部新文件。任一rename/chmod/final `loadConfig()`失败会删除新目标并恢复backup。
- **Pi 原生配置向导**：`/tg config`是command tree中的静态节点，config loader失败时仍可帮助、补全和dispatch。fresh/replace流程在第一个输入dialog前用Pi defaults + catalog/auth status做零provider-call预检，只显示脱敏`provider/model:thinking`；失败固定分类并引导Pi `/login`、`/model`，writer调用为0。`src/onboarding/config-wizard.ts`只编排Pi公开的`select/input/confirm/editor/notify`；public persona template先于Telegram secret输入读取，取消任一步不调用writer。向导只操作项目根的 `telegram.config.ts` 与 `.env`；自定义source只允许安全的validate/项目根原文edit，坏配置先修复而不旁写一个daemon不会读取的default。首次写入或已确认的原文替换通过production loader后，extension只用固定参数委托既有`bun run src/main.ts restart`控制路径；只有exit 0且输出明确`daemon ready`才建立all-bots native feed。失败保留已验证文件、清除旧连接并显示经过credential redaction的status/retry诊断。dialog值不写notification、进程参数、Pi session或provider context。
- **启动期校验**：运行时 schema 校验（id 唯一合法、token_env 在 .env 存在、persona 文件可读、routing_p ∈[0,1] 且 Σ≤1、数值有限>0）+ env 数值检查；peer id 三种形式统一归一化；校验失败收集**全部**错误一次性抛出（ConfigError 逐条点名），不静默 NaN
- **进程管理**：daemon 最早时机 `openSync(wx)` 排他pid锁，退出只删除仍属于自己的pid file。CLI controller把start/restart共用同一detached spawn与readiness：按同仓库cwd/绝对entry验证PID（Linux 读 `/proc/<pid>/cmdline` 与 `/proc/<pid>/cwd`；macOS 用 `ps` 识别精确入口、`lsof` 验证真实 cwd，支持项目路径含空格），枚举并优雅停止该deployment的pid owner与孤儿进程，等待所有PID/pid file/socket消失后才spawn；同步初始化和信号处理器就绪后才创建 socket；新socket必须真实connect且新PID身份有效才是ready。restart另有可回收control lock，foreign PID与命令文本decoy绝不signal。Pi只异步委托CLI，保留原transcript并以原filter更换IPC client；跨client snapshot按canonical identity去重，compose/pending send按unknown outcome/no-retry关闭。
- **单群deployment边界**：一个daemon只读取一个`group_peer_id`，且当前`data/`、DB、session、pid、control lock与socket均由工作目录决定。同一checkout内只换配置文件并行多群不安全且不支持；多群必须使用隔离工作目录/data资源，不能共享持久化或进程控制文件。
- context window与价格来自Pi catalog；runtime以当前context、输出/reasoning/tool reserve和配置上限确定每轮suffix预算，不维护平行model表。
