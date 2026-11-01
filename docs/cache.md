# Cache 工程

provider prefix cache 是本项目的第一成本杠杆。本文是“哪些字节对 provider 可见、怎样改它们”的唯一权威。

## Invariants

1. **永不改写已发出的 prefix**，新信息只作为新 suffix 追加。
2. system prompt 顺序固定：共享群聊协议 → persona → sticker 目录。tool 的 name/description/schema 及顺序固定。
3. Telegram 内容只以新的结构化 session entry 追加；已写入 session 的字节不重算。edit、reply metadata、vision 描述都作为 delta 追加（`message_edit` / `message_metadata` / `media_update`）。
4. **每个请求都必须是下一个请求的严格前缀。** 生产数据显示，只要上一请求的末尾在下一请求里消失，provider 就要回退到更早的缓存点，每轮多 miss 一万多 token。所以不存在“只挂在最后一条”的动态尾部：每批消息的 sticker 附注（只列该批新出现、本 bot 能发、不在固定目录里的 sticker）存在 `details.stickerCandidates`，由 `context` 事件投影成紧跟**该批**的〔系统附注〕独立消息，之后永远原样保留；它**永不写入持久化 content**（compaction 直接读持久化字节）。
5. 只有完整 context fingerprint 相同且 session 文件存在时才恢复 session；否则在打开旧 session **之前**新建 session、推进 epoch，旧文件保留。
6. UI、IPC、日志、控制命令、本地媒体准备都不得改变 provider payload。
7. 所有 provider 输入有界：每轮 suffix 默认 ≤12,000 token，单条消息 ≤4,096 token，网页正文每页 ≤4,096 token（更多内容经 `offset` 分页读取），每批 sticker 附注 ≤8 条。

## 哪些东西是 cache-visible

- 共享协议、persona 及其顺序（`src/agent/prompt.ts`）；
- tool name/description/schema 与顺序（`src/agent/tools.ts`）；
- Telegram 序列化 grammar（`src/agent/serialize.ts`）、context details 版本、sticker 候选 grammar；
- 摘要 prompt 与摘要输入 envelope、所选 compaction model；
- extension 顺序、`[no_send]` 持久化策略、每轮固定的触发消息与补答提示；
- provider/api/model/reasoning/cache retention、Pi 版本、`media.mode`、该 bot 的 sticker 目录快照。

以上全部进入 `src/agent/context-fingerprint.ts` 的 fingerprint。

## 改动 cache-visible 内容的流程

1. bump `src/agent/prompt.ts` 的 `CACHE_SCHEMA_VERSION`，在下方“版本记录”加一行理由；
2. 跑 `bun test test/cache.test.ts`，确认失败的正是你预期改变的那几项 golden，再更新 expected；
3. 部署后每个 bot 会新建 session（新 epoch），首个请求冷缓存，旧 session 文件保留。

golden 意外失败是报警：先查原因，不要直接改 expected。

## Provider payload 结构

```text
system:   共享协议 --- persona [--- sticker 目录]
messages: Telegram 批次（custom message，各自后面可能跟一条〔系统附注〕sticker 附注）、
          assistant/tool/summary entries
tools:    send, search, view_image, task[, codemode]（按 bot 开关与媒体模式过滤，顺序不变；codemode 声明由 Pi 按脚本工具渲染）
```

- 一批 Telegram 消息投影为纯字符串；图片只出现在 view_image 结果里，投影时才把文件读成 image block。
- send 成功后模型只看到固定 ACK（`ok sent_message_ids=#…` 或 `no_retry`），发送详情只留本地。
- 没调 send 的 assistant 文本在 session 里替换为 `[no_send]`。

## Telegram 消息 grammar

```text
--- 2026-08-07 ---
[17:31:42] #18452 Alice (@alice · tag:admin): 文本
[17:31:55] #18453 Bob (u17) ↪ #18452: 文本
[17:31:56] #18454 Bob (u17) ↪ #18455 @alice "被回复的正文": 看这个 [图片]
[17:31:57] #18456 Bob (u17) ↪ #999999 (原消息不可见): 这个看不到
[17:32:10] #18457 Bob (u17): 看看这个 [document "report.pdf" 1.2 MB]
[message_edit #18453] 修改后的文本
[message_metadata #18453] ↪ #18452
[media_update #18453] [图片: 新的视觉描述]
[task t3 进展] 已核对 5 个来源
[task t3 完成 ↪ #18452] 结论……（文件：/work/tasks/t3/report.md）
[系统] 你的工作区已被清空（每周例行），/work 里之前的文件都不在了。
```

- 无 username 的发送者用稳定别名 `u<N>`（rowid 分配）。
- 引用父消息优先用随消息保存的 `reply_snapshot`；父消息在同一新批次里时只写裸 `↪ #id`。
- `[task …]` / `[系统]` 来自 `note` 事件（serializer v6），只出现在它所属 bot 的上下文里；除进展外都带 `↪ #origin`。
- `media_update` 只在 hybrid 模式出现。

## Compaction

- 摘要输入 = Pi 的 `messagesToSummarize` + `turnPrefixMessages`，经 `convertToLlm` + `serializeConversation`；去掉 assistant thinking（推测不能变成“事实”）。摘要 prompt 要求只记录群消息里实际出现的内容。
- 摘要模型支持图片时，待丢弃的图片按原位置一起发送；不支持时只发文字。输入保守估算超过摘要模型窗口则不调用、取消压缩。图片总字节超预算时只缩小这次摘要请求里的图片（Pi `resizeImage`），持久文件不动。
- 摘要请求 `cacheRetention: "none"`。成功后替换可见集合、推进 epoch；cursor 不回退。

## 遥测

`tg-cache-observer` 在 `before_provider_request` 对 payload 分段（system / tools / 每条 message / 完整 payload）计算 deployment 本地 HMAC，记录相对上一请求的首个分叉位置，并按形状估算 system/tools/摘要/messages 的 token 占比。不保存明文。

provider 没有返回 cache 用量时，若同一 cache cohort（provider/api/model/epoch/session/retention）的相邻两次请求 system、tools 相同，且上一次的 message hash 列表是这一次的严格前缀（上一次的列表只保存在内存里，重启后第一次请求不估算），就把上一次的 prompt token 记为 `cache_read_estimated`，界面用 `≈` 标出。这是结构上可复用的量，不是 provider 实际命中，也不改写原始 usage 与费用。字段口径见 [telemetry.md](telemetry.md)。

## 版本记录

当前：**42**。更早的版本见 git 历史。

- **v42**：删除 context 媒体模式（`media.mode` 只剩 off / hybrid）；批次 details 去掉 `blocks`（`TELEGRAM_CONTEXT_VERSION` 5），批次永远是纯文本，图片只来自 view_image；共享协议的媒体占位符说明相应改写。
- **v41**：工具说明与提示词去掉各种数字上限（view_image 每轮张数、codemode 输出字数、job 并发与时长、tg_messages 行数与正文长度、sh_exec 时长）；`reply_to` 只要求是本群真实存在的消息。
- **v40**：提示词不再写 send 次数上限（代码里只留 20 条消息的防死循环保护，reaction 不计）；send 的 reaction 说明与 send 指南写明只点 reaction 时可以点本群任意消息；新增批量点 reaction 的脚本示例。
- **v39**：`send`、`task`、`job` 改为 direct（脚本里可调用，脚本里的 send 不结束本轮，每轮最多 3 次），删除 `tg_post`；工具指南去掉"每轮一次 send""十几秒才打招呼"等互相冲突的规则，示例改为每个工具都用脚本串起来。
- **v38**：model-only `job` 工具（golden `jobTool`，`TOOL_DEFS` 之后、Pi codemode 之前）与 `[job jN …]` note；共享协议与工具指南相应增加。
- **v37**：脚本工具新增 `tg_post`（中间消息）；系统提示每个工具说明下附示例（`src/agent/tool-examples.md`，只出现已开启工具的部分）与按工具过滤的「常见错误」。
- **v36**：`tg_messages` 的 `order` 多出 `relevance`，`text_contains` 说明 3 个字以上走全文索引。
- **v35**：附件占位符带发送者给的文件名、大小与时长（`[document "report.pdf" 1.2 MB]`、`[voice 12s]`，serializer v7）；`tg_messages` 的 media 多出 `file_name` / `file_size`。
- **v34**：系统提示的「可用工具」按开启的工具逐个给出用法（send / search / view_image / codemode / 工作区 / task），新增「你自己」一节（源代码仓库与阅读方式）；共享协议说明 `[message_edit]`、`[media_update]`、`[task …]`、`[系统]` 行的含义；脚本工具描述补充用法。
- **v33**：后台任务：model-only `task` 工具（workflow 选项来自配置，golden `taskTool`）、`note` 事件 grammar（serializer v6）、系统提示的 task 摘要。
- **v32**：带工作区的 bot 的 `send` 声明多出 `files`（golden `sendWithFiles`），系统提示多一句工作区说明；没有工作区的 bot 字节不变。
- **v31**：codemode 脚本工具新增 `tg_download`、`sh_exec`、`sh_reset`（`tools.sandbox` 开启时注册；fingerprint 只含实际注册的脚本工具）。
- **v30**：新增 `media.mode: "hybrid"` 与 model-only `view_image` 工具（`TOOL_DEFS` 第三项）；view_image 结果的图片只在 `context` 投影时由引用物化。
- **v29**：codemode 脚本可调用 `tg_messages`（声明含 `outputSchema`，计入 `toolProtocolHash` 与 golden `codemodeTools`）；系统提示的 codemode 摘要写明可检索历史。
- **v28**：`run_js` 删除，改用 Pi 原生 `codemode`（`send` 为 model-only）；系统提示工具摘要相应改变。
- **v27**：`search` 读页改为分页：新增 `offset`，每页约 4k token，结尾给出继续读取的 offset；token 估算改为 CJK 约 1 token/字（原先按 UTF-8 字节/2，中文页只剩约 1.3k 字且无法续读）。
- **v26**：sticker 附注改为每批各一条、永久保留（只列该批新出现的、不在固定目录里的可发送 sticker），让每个请求成为下一请求的严格前缀；系统提示里的工具声明按 bot 实际开启的工具生成（三个工具全开时字节不变）。

- **v25**：sticker 候选改为紧跟最后一批消息的〔系统附注〕独立消息（以前拼在最后一条正文末尾，模型把它读成最后发言者粘贴的内容，2026-10 生产事故）；协议说明附注由系统附加、群成员不可见；摘要输入去掉 thinking，摘要 prompt 要求只记录实际发生的事。
- **v24**：引用父消息正文随消息以 `reply_snapshot` 保存，与当前正文共享单条预算（serializer v5）。
- **v23**：Telegram turn 经 `session.prompt()` 原生 preflight 发出，每轮带固定触发消息。
- **v22**：Pi 升级到 0.86，provider stream 改用 Pi 原生 normalized transcript。
- **v21**：send 新增可选 `reaction`。
- **v20**：直接点名但没发言的健康 turn 最多追加一次补答提示。
