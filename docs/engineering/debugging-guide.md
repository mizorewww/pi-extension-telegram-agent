# Debug 指南

> 本文是新功能可诊断性与故障调查的权威契约。适用于 daemon、Telegram、agent、tool、SQLite、IPC 与 media；不授权真实网络调用或扩大日志内容。

## Invariant

1. **先区分边界，再猜原因。** response opportunity、provider run、tool调用、Telegram remote commit与本地持久化是不同事实。
2. **业务状态是authority。** SQLite/session决定正确性；`daemon.log`是有界side channel，丢日志不得改变行为。
3. **日志只记身份与状态，不记内容。** 禁止消息正文、caption、persona、prompt、provider response/thinking、tool args、token/key、完整URL/path、stack与媒体identity。唯一例外是下述显式本机provider-context取证，它只写当前命令stdout，不进入日志/DB。
4. **所有输入有界。** 单条日志≤4096 bytes、最多24 fields、string≤256；debug报告每bot最多20 claims、20 runs、50 events、100 logs，窗口最长7天。
5. **可关联但不新建平行真相。** 使用已有`bot_id/message_id/run id/epoch/ingest_seq/request_id`；新增业务状态必须进入职责拥有表，而不是藏在日志里。
6. **测试默认零输出、零外网。** fixture显式捕获logger sink；真实provider/Telegram只能在用户授权的e2e中使用。

## 第一入口：只读诊断报告

```bash
bun run debug -- --since 30m
bun run debug -- --bot A --since 2h
bun run debug -- --bot A --show-provider-content  # 敏感：显式读取完整当前provider上下文
```

命令只读取deployment配置、本机Pi模型目录、readonly SQLite/Pi session、PATH工具可用性与最后64 KiB结构化日志，不访问网络、不写DB、不输出credential。输出JSON包含daemon存活/socket状态、每bot cursor/high-water/reply obligations、最近claims/runs/safe events/logs、`findings`、`video_transcoder`与`provider_contexts`。run 中的 `cache_read/cache_write/cache_miss` 是 provider 原值；nullable `cache_read_estimated` 是相邻 raw payload 严格前缀的本地理论复用量，不能当作 provider 命中证明。模型能力诊断只输出provider/model与requested/effective/supported reasoning；`model_reasoning_available`明确标记本次是否成功读取模型目录，失败时业务报告仍然生成且`model_reasoning`为`null`。

`provider_contexts`默认列出完整的模型输入结构：provider/model/api/cache元数据、system长度/hash、完整tool description/schema，以及每条消息的role、content types/长度/hash、tool name/call id/error；消息与system正文省略。这样可以机械回答“search schema是否注册”“TinyFish toolResult是否与call id配对”“follow-up前结果是否仍在active branch”。`--show-provider-content`必须同时指定单个`--bot`，才把完整system prompt和当前compaction-aware消息投影写到stdout；其中可能含persona、群正文、tool args/result与历史thinking，不得贴issue、重定向到长期文件或纳入自动日志。它是当前session的pre-adapter重建，不伪称历史最后一次HTTP request；历史精确边界仍以`llm_runs`哈希为准。

`findings`固定语义：

| code | 已证明的事实 | 下一步 |
|---|---|---|
| `unsupported_reasoning_effort` | 配置requested档位不在该模型supported levels中，Pi会静默clamp为effective档位 | 将main/compaction/vision配置改为supported值；daemon启动也会fail fast |
| `video_transcoder_unavailable` | vision已启用，但PATH缺少`ffmpeg`或`ffprobe`；finding同时给出`impact=video_recognition_disabled`与`action=install_ffmpeg_and_restart` | 安装FFmpeg发行包并restart；它只用于视频抽帧，daemon、聊天、图片vision与sticker发送不受影响 |
| `cursor_backlog` | 该bot尚未消费全部immutable events | 看最近claim与runtime state；没有trigger时可正常 |
| `pending_reply_obligation` | direct address（explicit @mention / reply / 配置名称点名）尚未被structured commit确认交付 | 查flush/provider失败；restart后应自动recover |
| `route_without_run` | started claim超过120秒仍无匹配`llm_runs.trigger_message_id` | 查`agent_runtime.flush_failed`与provider readiness |
| `model_silence` | run完成、公开send为0，且附近有`assistant_text` | 模型主动沉默，不是Telegram传输失败 |
| `tool_preflight_failed` | send在Telegram create前被本地确定性拒绝 | 按category修输入/visibility/catalog，不查Telegram |
| `send_degraded` | create结果处于committed/partial/unknown边界 | `committed/partial/unknown`都不得自动重试；按stage修本地副作用 |

报告是线索而非历史证明：旧自由文本log不解析；窗口之外或retention删除的证据会缺失；概率trigger可合法沉默或busy-skip。

## 响应链证据梯

按顺序停止在第一处缺失/失败：

1. `telegram_ingest.update_committed` / canonical row / immutable event：Telegram update是否durable。
2. `routing.decision` + `routing_claims`：目标、reason、started/skipped/coalesced是否明确。
3. `agent_runtime.flush_started`：runtime是否得到response opportunity。
4. `agent_runtime.context_packed`：`input_events/visible_count/obligation_count/rows_scanned/suffix_budget`是否合理；不查看正文。
5. `llm_runs` + `agent_runtime.provider_turn_settled|flush_failed|model_silence`：provider是否完成、失败还是沉默；run同时给出system/tools/compacted/messages分段与thinking/send耗时，便于核对status。
6. `agent_tool.execution_started|finished`：哪个tool、是否error；args只在受限本地`agent_events`已有契约内，不进入daemon log/debug报告。
7. `agent_send.preflight_failed|started|committed|degraded`：Telegram create之前或之后的准确commit boundary。
8. canonical sent row、`agent_events.send/send_degraded`与IPC event：远端结果后的本地持久化/展示是否完成。

不要用“看到模型有输出”推断公开发送，也不要用“群里没消息”推断provider没运行。

### 图片与视频理解证据梯

1. canonical `messages.media`与`media_file_ids`证明哪个bot拥有可用`file_id`；`file_id`只能交给同一bot的Bot API。
2. `media.local_path`与`media_cache_ready/skip/error`证明本地媒体准备，不证明vision provider已经运行。视频path只是本地source，不会进入IPC。
3. 成功compaction后，`media_cache.post_compaction_pruned`只聚合`scanned/deleted/stale/failed`；`failed>0`保留DB path供下次重试，全部无候选时合法静默。`prune_observer_failed`表示observer自身失败，但compaction仍已提交。两者都不得加入media identity或path。
4. 视频先检查`video_transcoder`；`video_transcoder_unavailable`在Telegram下载、FFmpeg与provider前立即no-op，可在安装并restart后重试。CLI只提醒operator，daemon log带`blocking=false`，不向群内发送告警。`video_probe_failed`/`video_frame_extraction_failed`证明失败发生在provider前。不得记录命令stderr或path。
5. `agent_events.kind=vision`的固定`outcome`、`frames`与`providerCalled`证明foreground识别结果；deployment并发门会在视频下载前排队。跨bot路由时应使用任一已配置且有mapping的接收bot，`file_id_unavailable`只表示所有可用source均缺失。
6. 非空`media.vision`与对应`message_events.kind=media_update`证明描述已持久化并进入append-only provider队列；主模型选择别的话题不等于没有识图。
7. `/tg attach`的snapshot/history直接读`media.vision`，live路径读`vision_update`；全局、A、B等filter都应显示同一群消息描述，filter只限制LOCAL/usage。

不得把私人图片、OCR正文、`file_unique_id`、`file_id`或本地path复制进daemon日志；内容取证只在明确授权的本机SQLite/provider-context检查中短暂查看。

## 结构化日志契约

每行是schema v1 JSON：

```json
{"schema":1,"ts":"...","level":"info","component":"agent_send","event":"committed","fields":{"bot_id":"A","sent_count":1,"trigger_message_id":42}}
```

- 调用`src/observability/log.ts`的`log.debug/info/warn/error(component,event,fields)`；production daemon模块不得裸用`console.*`。
- `component/event`使用稳定snake_case；字段只传boolean、有限number、短enum/identity。Error只先转固定category，不传message/stack。
- 高频progress只按固定批次记录；禁止token delta、typing heartbeat、每字节/chunk日志。
- 新event必须说明它区分了哪个相邻状态；如果现有event/DB已能回答，就不要新增。
- `data/daemon.log`在受控spawn前按8 MiB轮转，保留`.1`–`.3`，mode 0600。foreground也输出同一JSONL。

## 新功能强制 Debug impact 检查

每个新功能/行为改动在实现前回答，并写进任务说明：

1. 成功、合法no-op/沉默、可重试失败、不可重试/unknown commit分别如何观察？
2. 用哪些已有identity跨边界关联？是否误把log当业务authority？
3. 哪些字段绝不能记录？每事件/查询/队列上限是多少？
4. `bun run debug`能否判断故障停在哪层？需要新增finding还是现有证据足够？
5. 回归测试是否捕获稳定event/category并放入secret/content canary？
6. 是否仍为Cache impact NONE、0新增LLM call/token？若不是，按cache流程另行处理。

完成前必须跑相关logger/report测试，并用fixture验证至少成功与一个失败/no-op路径。只写“加日志”而没有状态区分、隐私边界与验证，不算完成。

## 调查与修复模板

1. 保存只读报告参数和聚合结论，不复制群正文。
2. 用message/run/epoch在SQLite与JSONL间关联，标出第一处状态分叉。
3. 建确定性fixture复现该分叉；外部服务故障优先fake，不用生产群注入失败。
4. 修职责拥有层；日志只补缺失的可观察状态，不能用重试掩盖unknown commit。
5. 验证回归、source audit、cache golden、全量unit/typecheck；真实smoke单独说明授权与成本。

参考案例一（精确回复失败）：route/run/send 均存在，`agent_send.preflight_failed{category:reply_not_visible}` 证明失败发生在 Telegram create 前；修复的是 turn-local visibility 时序，而不是重试 Telegram 或要求模型更积极。

参考案例二（provider context 取证）：历史 session 里的 `search` call/result 证明 TinyFish 返回没有被 context extension 过滤；当时 context inventory 显示当前工具只剩 `send`，再回溯配置归一化即可定位“省略字段被改成禁用”，无需猜模型为何不调用。
