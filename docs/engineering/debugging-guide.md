# Debug 指南

怎样调查故障，以及新功能必须满足的可诊断性要求。

## 原则

1. **先定位边界再猜原因。** 收到消息、得到回应机会、provider 调用、工具调用、Telegram 提交、本地持久化是不同的事实。
2. **SQLite 与 session 是权威，日志不是。** `daemon.log` 丢了也不能改变任何行为。
3. **日志只记身份与状态，不记内容。** 禁止正文、caption、persona、prompt、provider 响应、thinking、tool 参数、token/key、完整 URL/路径、stack、媒体身份。
4. **一切有界。** 单条日志 ≤4096 字节、≤24 个字段、字符串 ≤256；debug 报告每 bot 最多 20 claims / 20 runs / 50 events / 100 logs，窗口最长 7 天。
5. **用已有 identity 关联**（`bot_id`、`message_id`、run id、epoch、`ingest_seq`、`request_id`），不在日志里建平行状态。

## 第一入口：`bun run debug`

```bash
bun run debug -- --since 30m
bun run debug -- --bot A --since 2h
```

只读：本地配置身份、SQLite 和日志尾部 64 KiB；不读取 `.env`、Pi 凭据或 session 内容，不联网、不写库。JSON schema 2 输出 daemon 存活状态、每 bot 的 cursor / high-water / 回复义务数量 / pending dispatch、保留期用量、最近 claims、runs、事件种类与结构化日志。

报告只收集事实，不输出自动推断的 `findings`，也不再重建或导出 provider payload。用下面的证据梯定位问题：例如 `context.pending_reply_obligations > 0` 表示有待答消息；claim 已开始但没有对应时间的 run 时，查看 `flush_failed` / `provider_attempt_failed`。

报告是线索不是历史证明：窗口外或被保留期删掉的证据会缺失；概率触发合法地沉默或跳过。

## 回应链证据梯

按顺序检查，停在第一个缺失或失败的环节：

1. `telegram_ingest.update_committed` / canonical 行 / event：update 是否落库。
2. `routing.decision` + `routing_claims`：目标、原因、started/skipped/coalesced。
3. `agent_runtime.flush_started`：bot 是否得到回应机会。
4. `agent_runtime.context_packed`：`input_events`、`visible_count`、`obligation_count`、`suffix_budget` 是否合理。
5. `llm_runs` + `provider_turn_settled` / `flush_failed` / `model_silence`：provider 完成、失败还是沉默。
6. `agent_tool.execution_started|finished`：调了哪个工具、是否出错。
7. `agent_send.preflight_failed|reaction_dropped|started|committed|degraded`：Telegram 提交前还是提交后。
8. canonical 发送行、`agent_events.send` / `send_degraded`：远端结果之后的本地记账。

不要用“看到模型输出”推断已发到群里，也不要用“群里没消息”推断 provider 没运行。

压缩相关：`auto_compact_skipped{last_turn_failed:true}` 是故障期间主动跳过；`auto_compact_triggered{stage:preflight}` 是请求前发现图片超预算；`context_input_rejected` 表示压缩失败或仍超预算，本轮未发请求、义务保留；`compaction_input_rejected` 表示摘要请求在调用前被拒（窗口不足或图片无法缩到预算）；`provider_attempt_failed{category:provider_request_too_large}` 是 413 进入 Pi overflow 恢复。

## 媒体证据梯

1. `messages.media` 与 `media_file_ids`：哪个 bot 拥有可用的 `file_id`。
2. `media.local_path`：本地文件是否就绪（只在 vision / view_image 用到时下载，不代表已送入模型）。
3. 视频先看 `video_transcoder`；`video_probe_failed` / `video_frame_extraction_failed` 是本地抽帧失败。
4. hybrid 的文字描述：`agent_events.kind=vision` 的 outcome，非空 `media.vision` 与对应 `media_update` event。`view_image`：`tool_view_image` 事件的结果与图片数量。
5. 压缩后的 `media_cache.post_compaction_pruned` 只给聚合数字。

## 日志契约

```json
{"schema":1,"ts":"...","level":"info","component":"agent_send","event":"committed","fields":{"bot_id":"A","sent_count":1}}
```

- 生产 daemon 代码只用 `src/observability/log.ts` 的 `log.debug/info/warn/error(component, event, fields)`，不用 `console.*`。
- `component`/`event` 用稳定 snake_case；字段只放 boolean、有限数字、短枚举或身份。Error 先转固定 category。
- 不记高频进度（token delta、typing 心跳、每个 chunk）。
- `data/daemon.log` 在每次受控 start/restart 前（systemd unit 的 `ExecStartPre` 同样执行）按 8 MiB 轮转，保留 `.1`–`.3`，权限 0600。

## 新功能的 Debug impact

动手前回答并写进任务说明：

1. 成功、合法 no-op/沉默、可重试失败、不可重试/结果未知分别怎么观察？
2. 用哪些已有 identity 跨边界关联？
3. 哪些字段绝不能记？每个事件/查询/队列的上限是多少？
4. `bun run debug` 能否判断故障停在哪一层？需要补充哪条有界事实？
5. Cache impact 是否仍为 NONE、0 新增 LLM 调用？

只写“加日志”而没有状态区分、隐私边界与验证，不算完成。修复时改职责拥有层，日志只补缺失的可观察状态，绝不用重试掩盖结果未知的提交。
