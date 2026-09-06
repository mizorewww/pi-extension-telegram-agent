# 2026-09-06 设计与架构审查

本文保留 2026-09-06 修复前的审查证据；“发现”中的行号、复现结果与建议描述当时版本。用户随后授权整改，R1–R10 和 macOS 进程识别已在工作区修复，当前行为见下表及规范性文档。

## 结论

单进程 daemon、每 bot 一个 Pi session、共享 SQLite、独立 TUI 的总体划分适合当前单群部署。immutable message events、业务 cursor 与 provider visibility 分离、Telegram create 的不可回滚边界也有明确设计依据。没有发现需要重写系统或引入微服务、通用 repository、通用事件总线的理由。

主要问题是局部实现跨越了已有责任边界：遥测可以覆盖发送结果；媒体回收有第二入口；路由恢复与 ingest 脱节；自定义重试与 Pi 重试并存；压缩后的 visibility 又被旧 batch 回填。机制本身不少，但仍缺少端到端守卫。

优先级：P1 应优先修复，涉及不可逆发送结果、持久化恢复或已失效的预算控制；P2 是有明确触发条件的正确性问题。以下分别标明动态复现与静态证据，不把潜在后果写成已经发生的线上事故。

## 整改结果

| 问题 | 落地结果 |
| --- | --- |
| R1 / R6 | send 边界收敛至 `src/agent/send.ts`，遥测失败不覆盖 terminal；manual send 复用 unknown-outcome 分类，避免诱导重复发送。 |
| R2 | 使用真实 Pi SessionEntry；删除 runtime 第二条文件回收路径，图片压力仅调整本次原生 compaction 保留窗口。 |
| R3 | ingest、offset 与每 bot 一条 pending dispatch 原子提交；回调成功才确认，失败和重启先恢复；retention 保护 raw 来源及待交付消息事件。采用有限交接记录，没有通用队列框架。 |
| R4 / R5 | 全局 mention 优先且支持 caption；所有 obligation 由最终路由目标统一创建；edit 时间单调更新。 |
| R7 | turn 完成后按真实 active entries 原子提交 visibility，再做后置压缩；兼容 Pi turn 内压缩。 |
| R8 / R9 | Pi 接管唯一 retry 预算，adapter retry 关闭；watchdog 覆盖整个 stream，摘要响应取消，不再偷偷 fallback 到主模型，extension 异常明确 cancel 而非触发 Pi 默认摘要。另补齐摘要遗漏的 split-turn 前缀。 |
| R10 | 独立永久 control identity 表，一次性迁移仍存在的历史记录；telemetry 可正常过期。 |
| macOS | `ps` 精确入口与 `lsof` cwd 校验，含空格目录的临时假 daemon 验证通过；Linux 保留 /proc 路径。 |

移除了错误结构猜测、无意义的内部 optional fallback、固定副作用数组截断和重复重试机制。保留真实远端提交、IPC partial write、sandbox 与资源预算防护。没有引入 repository、通用事件总线或额外配置来源。

cache schema 升级至 18：摘要输入语义改变，下次启动创建新 epoch，旧 session 保留。新增表在启动时自动迁移；此前已被 telemetry retention 删除的 control 身份无法恢复。

## 发现（修复前）


### R1 · P1 · 发送成功仍可能被遥测异常转成工具失败

位置：[runtime.ts](../../src/agent/runtime.ts)，`executeSend`（859 行）、`recordSendDuration`（1853 行）。

`executeSendAttempt()` 已经处理 committed/unknown/no_retry，并返回 `terminate:true`，但外层 `finally` 无保护调用 `recordSendDuration()`。后者既写 SQLite，又调用 `usageSink`，任一步抛错都会覆盖已生成的成功结果。Pi 得到异常后不再得到 terminal 结果，有机会继续请求模型并再次发送。

动态复现：真实 `BotRuntime.executeSend`，仅注入假的 Telegram API 和一个抛错的 usage sink；远端调用 1 次，canonical 已保存 `sent`，最终 Promise 却以 `usage broadcast failed` 拒绝。这不是只有伪造内部返回值才能触发的情况。

建议：发送的 terminal 结果必须在整个 tool execute 边界成立。发送耗时采样及 observer 失败只能降级记录；不要只在内部 component helper 里保护。长期守卫应检查“远端已提交 + 任一后置副作用失败 → 不抛出可重试工具错误”。

### R2 · P1 · 图片上下文预算读取了错误的 Pi entry 结构

位置：[context.ts](../../src/agent/extensions/context.ts)，`contextImageBytes`（87 行）、`contextImageNames`（112 行）；[runtime.ts](../../src/agent/runtime.ts)，`maybeAutoCompact`。

两函数只识别 `{type:"custom", data:...}`，但实际 `sendCustomMessage` 保存的是 `{type:"custom_message", details:...}`。`SessionManager.buildContextEntries()` 返回后者。因此图片字节预算始终漏算真实 Telegram batch。

动态复现：通过安装的 Pi 0.84.1 的真实 `SessionManager.inMemory()` 和 `appendCustomMessageEntry()` 创建包含一个 1024 字节文件的 entry，结果为 `entryType=custom_message`、`reportedBytes=0`、`names=[]`。图片预算触发压缩的功能没有生效；普通 token 压缩仍可能生效。

还有被此错误遮住的设计风险：`pruneCompactedImages()` 在修正 walker 后会直接删除仍被 compacted context 引用的文件，不检查其他 bot，也绕过 [lifecycle.ts](../../src/media/lifecycle.ts) 的引用保护。保留的 recent entries 也不等于已被摘要覆盖的内容。因此不能只改 entry type 就结束修复。

建议：walker 接受 Pi 的 `SessionEntry` 判别联合并读取 `details`；回收仍交给唯一 lifecycle owner。需要缩减 retained images 时，先定义新 epoch 的保留策略，不能通过删除共享文件隐式改变其他 session 的 provider prefix。

### R3 · P1 · ingest 成功与路由接收之间没有完整恢复边界

位置：[poller.ts](../../src/telegram/poller.ts)，106–121 行；[ingest.ts](../../src/telegram/ingest.ts)，`createIngestReplyObligation`；[index.ts](../../src/daemon/index.ts)，`route` 与启动恢复。

offset 在 `onMessage` 前推进，回调失败随后被当作 side channel 错误吞掉。但该回调包含核心路由。reply-to-bot 的 obligation 在 ingest transaction 中建立，@mention/name 的 obligation 则要到 runtime trigger 才建立。进程在两者之间退出，或者路由读取/claim 在 trigger 前失败，会留下 canonical 消息，却没有持久化的 direct-address 调度证据。

动态复现：含 @mention 的 update 入库后令 routing callback 抛错，结果 offset 已到 51、obligation 数为 0、同 update 重放返回 duplicate。启动恢复只扫描已有 obligations；后续普通上下文可能偶然读到该消息，但 direct-address 的必达保障已经丢失。

建议：让路由接收或可恢复的路由工作记录成为 ingest 的持久化后继步骤。可复用现有 routing claims，而非另建通用队列。仅把 offset 写入移到回调后仍不够，因为重放时 duplicate 分支不再调用回调。

### R4 · P2 · 路由优先级与 caption @mention 都不符合声明

位置：[router.ts](../../src/agent/router.ts)，55 行及 108 行。

`routeMessageDecision` 逐 bot 调用同时判断 mention/reply 的函数，并在第一个结果处返回。这是“bot 顺序优先”，不是全局“mention > reply”。动态复现：配置顺序 A、B，消息 reply A 同时 @B，实际选择 A/reply。交换配置顺序会改变显式语义。

另一个独立触发条件：normalize 将 `caption_entities` 存入 entities，但路由只在 `row.text` 非空时解析 mention。动态复现：caption 中只有 `@beta_bot`、概率为 0 时返回 nobody。

建议：按规则优先级扫描全部 bots，再处理下一种规则；entity 切片必须对应其 text/caption 原文。还应验证 ingest 预建 reply obligation 与最终 mention target 一致，避免恢复路径把已被高优先级覆盖的 reply 又交给另一 bot。

### R5 · P2 · 多 poller 乱序编辑会把 canonical 回退到旧内容

位置：[ingest.ts](../../src/telegram/ingest.ts)，`editMessage`（189 行），无条件 UPDATE（224 行）。

函数读取 existing.edit_date 却不判断传入版本是否更旧。不同 bot 的独立 long polling 进度允许 A 已收到新版，B 随后才交付旧版。

动态复现：原文 → A 收到 `edit_date=300, text=new` → B 收到 `edit_date=200, text=old`，最终数据库为 `old/200`。不可变 event 也可能追加一条更晚摄入的旧编辑，使模型理解回退。

建议：canonical 接受单调更新的编辑版本；明确相同 timestamp 重复事件策略，保留跨 bot 乱序回归测试。不要依赖每个 token 内 update_id 有序来推断跨 token 全局有序。

### R6 · P2 · operator send 把未知发送结果当作明确失败

位置：[manual-send.ts](../../src/daemon/manual-send.ts)，134–145 行；[tg-extension.ts](../../.pi/extensions/tg-extension.ts)，1523 行之后。

agent/control 已共享 `classifyTelegramCreateFailure()`，manual send 却把 timeout、网络断开等统一返回 `telegram_error`。Pi compose 只有 `unknown_outcome` 分支提示检查群消息并关闭 compose；其余失败会恢复输入，保持可发送状态。

动态复现：send API 抛 `TimeoutError`，manual service 返回 `telegram_error / Telegram send failed`。远端是否创建消息未知，但用户得到明确失败提示，再按一次发送会生成新 requestId，内存去重不能保护这次重发。

建议：复用已有 create outcome 分类，保持三个发送入口的一致语义；无需创建新的通用 transport 框架。

### R7 · P2 · 自动压缩后 flush 又把旧 batch 写入新 epoch 的 visibility

位置：[runtime.ts](../../src/agent/runtime.ts)，1390–1405 行；[message-events.ts](../../src/db/message-events.ts)，`commitConsumedContext`。

flush 在提交 SQLite consumed context 前调用 `maybeAutoCompact()`。压缩完成回调先替换 visibility、推进 epoch，随后 flush 用新的 `this.epoch` 把压缩前 `packed.visibleMessageIds` 再插入数据库。

动态复现：使用真实 flush/SQLite，注入 compact 回调并令压缩保留集合为空；结束时内存 visible 为 `[]`，数据库新 epoch 中却仍包含本批消息。该测试模拟的是压缩移走整个 batch 的合法结果，没有调用真实模型。

影响：当前内存 preflight 与 durable visibility 分叉；sticker candidates、媒体回收等读 DB 的逻辑会继续认为已移出 context 的消息可见。启动 reconcile 能修复一部分状态，但不能替代运行中的一致性。

建议：先完成本批 session/SQLite 提交，再进行后置压缩；若允许 Pi 在 provider turn 内自动压缩，也需要从压缩后的 active entries 确认最终 visibility，不能无条件复用旧 packed IDs。

### R8 · P2 · 重试策略有两个 owner，配置不能准确约束真实请求

位置：[runtime.ts](../../src/agent/runtime.ts)，467–500 行；[provider-guard.ts](../../src/agent/provider-guard.ts)，134 行。

自定义 guard 只在取得 stream 对象的 Promise 一直不 settle 时重试；stream 返回后立即交出控制，不处理后续 stream 内错误。同时 session 的 `SettingsManager.inMemory` 只设置 compaction，没有设置 retry。

核对已安装 Pi 0.84.1：该设置实际解析为 `enabled=true, maxRetries=3, baseDelayMs=2000`，Pi 的 `_prepareRetry` 使用此策略。因此项目的 `provider_retries=0` 不会关闭 Pi 对可重试 stream 错误的额外请求；反过来，把项目参数设大也不等于所有网络超时都按此预算重试。

这是明确的配置和成本语义分叉，不是对 guard 存在本身的否定。它目前的测试主要让 StreamFn 返回永不 settle 的 Promise，未覆盖正常返回 stream 后才出错的模型。

建议：明确区分请求 watchdog 与重试策略，将重试次数和 backoff 接入 Pi 原生 retry owner。若必须保留 pre-stream watchdog，说明其与 Pi retry 的组合上限，并测试零重试配置的真实 session 行为。

### R9 · P2 · 自定义 compaction 丢弃取消信号和 timeout 配置

位置：[runtime.ts](../../src/agent/runtime.ts)，`handleBeforeCompact`、`generateCompactionSummary`（838 行）。

Pi 的 `session_before_compact` event 提供 signal，但实现只传 preparation；`completeSimple` options 没有 signal/timeoutMs，并绕过聊天 stream guard。注释说 aborted 代表 shutdown/abort，实际项目没有把这个取消链传入请求。

静态证据：慢或挂起的辅助模型请求无法由这个 compaction event 的取消信号终止，也不受项目 providerTimeoutMs 约束；行为取决于 provider 自己的 timeout，最终还有 daemon 的硬退出兜底。不能将其描述为和聊天请求相同的受控生命周期。

建议：把 event.signal 与显式 deadline 传到底层，并统一 manual/auto compaction 的生命周期。保留群聊摘要 prompt 的产品差异；本结论不要求换回 Pi 的 coding-oriented 默认摘要。

### R10 · P2 · 永久 control 排除记录存入了会过期的 telemetry 表

位置：[control-command.ts](../../src/telegram/control-command.ts)，`claim`、`consumeReply`、`consumedControlMessageIds`（373 行）；[retention.ts](../../src/db/retention.ts)，`DELETE FROM agent_events WHERE ts < ?`。

control message/reply 的排除身份完全来自 agent_events，而 retention 按 telemetryDays 无差别删除此表记录。文档宣称跨 restart/epoch 永久排除，实际只是保留期内排除。

触发条件是 control 身份过期时，相关 message event 仍因 cursor 落后等原因保留：之后 flush 不再识别该 control ID，会按普通群消息注入。即使日常低延迟消费使此情况不常见，业务 authority 的生命周期仍不应由遥测保留天数决定。

建议：让 durable control identity 与业务事件寿命一致；最小修复可以对真正承担业务 authority 的事件区别保留，再评估是否需要专门存储。不要直接延长所有 telemetry 的保留期。

## 有条件的部署问题

[pid.ts](../../src/daemon/pid.ts) 的 identity/discovery 完全依赖 Linux `/proc`。macOS 没有该路径，`isOurDaemon` 返回 false，现有 start/stop/restart/status 不能正常识别本项目 daemon；foreground 再次夺锁的检查也受影响。生产 runbook 指定 Linux，但入门说明未明确排除 macOS，且包含 macOS 安装指引。

如果项目只支持 Linux，应该明确并启动时 fail fast；如果当前 macOS 工作区也是运行目标，这是需要修复的功能缺陷。此次未启动或停止任何真实 daemon，平台结论来自代码路径，不声称做了 macOS 真实部署测试。

## Hack、过度防御与抽象判断

### 应处理的临时补丁和重复责任

- 自动压缩后按文件删除来降低 provider 图片负载，把“上下文内容策略”塞进“共享缓存副作用”，并且与现有 lifecycle 形成第二条回收路径。R2 的结构错误遮住了它，不能原样启用。
- 自定义 provider retry 加 Pi 默认 retry，缺少统一配置约束。R8 展示了实际行为差异，应收敛 owner，而非再包一层 retry。
- `BotRuntime` 约 1934 行，同时负责 session 初始化、调度、context commit、发送、媒体准备、UI activity 和 usage SQL。问题不在行数，而在 R1/R7 显示这些职责已经相互改变业务结果。

### 最值得建立的三个边界

| 边界 | 最小调整 | 已有证据 |
| --- | --- | --- |
| Telegram send outcome | 三个入口共享 rejected/committed/unknown 分类；整个 execute 的后置 observer 不能改写结果 | R1、R6 |
| Active context commit | 一个 owner 决定 cursor、epoch、visibility；所有 entry walker 使用 Pi 类型；媒体 lifecycle 消费该状态 | R2、R7 |
| Provider request policy | Pi retry 接收唯一配置；自定义摘要和聊天请求都有显式取消/deadline | R8、R9 |

这些可以先通过小函数和现有模块完成，不要求建立新的继承体系。媒体 vision/context 的不同输出语义是实质差异，仅因两个 worker loop 相似就合成通用 pipeline，收益不足。TUI 大文件也应按已有组件职责渐进整理，不应先抽象通用 renderer 框架。

### 可以删减的防御

- `maybeAutoCompact` 对公开必有的 `buildContextEntries` 使用 optional call 和 `?? []`，会把接口/假 session 错配静默解释成零图片。精确锁定 Pi 版本时应让类型与契约测试承担此责任。
- 对已持久化的内部 session entry 接受 `unknown[]` 再反复宽松猜结构，降低了编译器发现 R2 的机会；外部输入需要校验，内部已知 union 应按类型分支。
- `failures.length < 8` 对注释已经承诺固定少量副作用的本地数组做截断，价值很低，还会静默损失诊断。这只是低优先级清理，不与正确性问题等量齐观。

### 应保留的防御和设计

- Telegram create unknown outcome 不自动重发，SQLite busy 只重试本地持久化：防的是实际远端不可回滚边界。
- IPC 字节偏移、partial write、队列上限；搜索与媒体的大小/时间边界：都有明确资源风险。
- run_js 的独立子进程、env scrub、realm 隔离、超时守卫：不能为“简洁”删除。本轮没有证明 sandbox 逃逸，也没有进行 OS 隔离攻击审计；现有威胁模型中的残余风险仍然存在。
- 配置跨字段校验、唯一配置来源、模型能力 fail fast、Pi provider/auth 复用：没有充分理由引入替代配置/认证层。
- 自定义群聊摘要、JSONL IPC、raw Telegram adapter：存在明确产品或边界差异，不能只因 Pi 有相近函数就判为造轮子。

## 审查基线验证与覆盖限制

- `bun test`：141 pass、0 fail，495 assertions，12 个执行测试文件。
- `bun run check`：通过。
- `bun run lint`：通过，91 files。
- `bun run docs:check`：通过。
- 额外最小复现在临时目录使用 SQLite 和本地文件，图片 entry 使用真实安装的 Pi SessionManager；Telegram API/provider 均未调用真实服务。覆盖 R1、R2、R3、R4 两种路径、R5、R6、R7；R8 核对真实 Pi settings 与已安装源码，R9/R10 为静态路径结论。
- 未读取生产聊天数据库、修改 secrets、重启 daemon 或运行付费 e2e。审查覆盖核心入口及跨模块调用链，不等于逐分支形式验证、安全认证或长期负载测试。

现有测试全绿并不否定以上问题：图片预算虽有测试，但 fake 使用了同样错误的 custom/data 结构，没有真实 session-entry 守卫；runtime fake session 对 compaction 的覆盖不足；send 的保护未覆盖最外层 finally。建议修复时保留这些长期边界测试，而不是添加只锁 helper 实现的脚手架。

已按以下顺序整改：R1/R6 统一不可逆发送结果；R2/R7 统一 active context 与媒体生命周期；R3/R4/R5 修复消息交付语义；R8/R9 统一 provider 生命周期；R10 修复业务记录 retention。runtime 已抽出 send 边界，其余生命周期保持就近归属。

本记录是时间点审查。相应修复落地后更新该条状态及验证证据；架构和产品的永久规则仍以 [architecture.md](../architecture.md)、[testing.md](../testing.md) 为权威。

## 整改验证

- `bun test`：153 个测试、14 个文件全部通过；真实 Pi SessionManager 用于 context/compaction 守卫，Telegram/provider 使用本地替身。
- `bun run check`、`bun run lint`、`bun run docs:check` 通过。
- macOS 进程归属用临时假 daemon 验证，Linux 分支未在 Linux 主机实跑。
- 未修改实际配置和 secrets、未重启生产 daemon、未调用真实 Telegram/provider 或付费 e2e。

## 2026-09-07 生产上线验证（Asia/Singapore）

用户授权通过 SSH 在 `mcp.mizore.blog` 真实部署和重启测试。远端原工作区干净，与本地基线 `f05464be0171ca03d1b33ed30fa94d63c0c77f25` 一致；部署本地工作区改动，未修改 secrets、bot 配置或 systemd 托管方式。部署前备份源码及 SQLite，历史 session 保留。

首次部署后确认两 bot 的 schema 18 新 epoch、177 条 control identity 迁移与 SQLite quick_check 正常；两个 bot 均已通过自然群消息完成真实模型调用、图片上下文和文字/贴纸发送。第二次重启恢复原 session，A/B epoch 分别保持 1594/924。另用隔离临时 session 验证真实摘要模型压缩成功，不写生产上下文。

### 额外发现并修复：启动回填阻塞与过早 ready

生产库约 85,801 条 canonical messages、3,225 个 media identity。`listReferencedMissingDisplayMediaIds` 对每个媒体候选重复扫描消息历史，导致同步 startup backfill 耗时约 94 秒；socket 在该查询前创建，CLI 因此提前报告 ready，而 IPC/轮询仍被事件循环阻塞。

- 增加非空 media 的 `CAST(json_extract(media, '$.file_unique_id') AS TEXT)` 部分表达式索引，lifecycle 使用相同 TEXT 表达式。单独对 json_extract 建索引仍因 affinity 不一致走扫描，不能省略 CAST。
- 生产数据库内存副本上的索引查询约 92 ms，执行计划由 `SCAN message` 变为 `SEARCH message ... idx_messages_media_identity`。
- readiness socket 移到同步初始化和信号处理器安装之后发布，后台媒体下载仍保持异步。
- 新增长期 EXPLAIN QUERY PLAN 守卫，同时覆盖 startup backfill 与 compaction prune；不使用易抖动的测试时间阈值。

本地最终验证：154 个测试全部通过，typecheck、lint、docs:check 通过。Linux 生产主机也执行同一测试集；原“Linux 未实跑”的审查限制由本次验证补齐。

补丁上线实测：启动到 ready 8.019 秒，随后 IPC snapshot 1.030 秒返回 100 条 timeline item；两 bot 为 idle，原 epoch 保持不变。远端最终 154 tests / 540 assertions 全通过，typecheck 通过。当前 daemon PID 为 760956（时间点记录）。初次部署备份在 `/home/aac6fef/telegram-deployment-backups/20260906T155327Z`，启动补丁前备份在 `20260906T160355Z`。

最终部署文件校验：38 个任务文件与本地 SHA-256 一致。远端 lint 通过；远端 docs:check 因未安装 mdbook 无法执行，文档构建已在本地通过，该依赖不参与 daemon 运行。
