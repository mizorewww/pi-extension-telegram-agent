# 成本设计概览

本项目不承诺固定节省百分比。provider价格、群活跃度、persona长度与模型cache行为都会变化；实际效果以`/tg status`和SQLite telemetry保留窗口为准。

项目的“极简”是最少机制而不是最少保障：优先少一个状态、接口、网络请求和provider-visible byte，同时保留transaction、timeout、脱敏、测试与可观察性。下面七项就是这一哲学在现有系统里的具体实现，不是未来平台功能清单。

## 1. 确定性 routing 先决定是否调用模型

mention、reply、配置名称和HMAC概率桶都由本地代码判断。普通消息没有命中时不会创建provider run；目标bot busy或处于probability cooldown时也不会改投另一个bot或补抽。

这样减少的是整个无意义调用，而不是在调用后省几个token。权威行为见[架构的 Routing 章节](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md)。

## 2. Stable provider prefix 复用cache

共享协议位于最前，persona随后，末尾是有界的 sticker 目录，再之后是固定顺序tool schema，让多只bot尽可能共享逐字节相同的prefix。固定目录每行为 `s<id>: <emoji> <描述>`（描述取持久化 vision 文本，缺失时逐级降级为 `s<id>: <emoji>`、`s<id>`；set 名与格式不进入模型可见文本），并有条数上限。另一份最多8条的动态候选只取当前context真正可见、且该bot可发送的最近用户sticker，行格式与目录一致。候选在session中独立保存，provider只在最后一批Telegram消息之后看到一次，不会在每个历史消息批次后重复；suffix预算不足时整体省略。三种格式都通过Telegram原始file id发送。

fingerprint覆盖Pi/provider/model/cache policy、protocol、persona、serializer、compaction、extensions与tools。cache-visible内容变化必须升级schema，并在restore前创建新session/epoch；旧session文件保留，但不会用不同identity恢复。UI、telemetry和operator命令不能偷偷改变provider bytes。权威规则见[Cache工程](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md)。

## 3. 有界 context 只携带需要的信息

Telegram canonical history与immutable event stream保存在SQLite。每只bot用单调cursor消费event，另一组visible refs只描述当前context仍真正包含完整内容的消息。模型每轮只收到token有界、direct address（@mention / reply / 配置名称点名）优先的event batch；日志、raw rich JSON、UI状态和无界工具输出不会进入provider context。

默认新增suffix上限是12,000 tokens，单event上限4,096。这把本地“完整事实来源”和模型“本轮必要上下文”分开。权威数据流见[架构](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md)与[数据模型](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/data-model.md)。

## 4. Compaction 在明确边界换epoch

主模型有效context由`context_window`限定（缺省65,536）；上下文到达可配置的触发阈值（缺省32K，最高`context_window − 16,384`）时生成摘要，保留最近 `compaction_keep_recent` token 原文（单位是 token：缺省 1 实际只剩摘要；生产推荐 20,000，约 1-2 个完整 turn），然后进入新epoch。失败或空摘要不会伪造epoch；structured details替换visible refs，业务消费cursor永不回退，也不会重放已压缩历史。

compaction使用配置的廉价task model且关闭provider cache retention，因此不是每轮在线优化器。阈值和保留量由配置决定，效果用telemetry验证。权威规则见[Cache工程](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md)与[测试状态](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/testing.md)。

## 5. 媒体按模式进入模型：默认文字描述，可选直接看图

`media.mode`选择媒体到达模型的方式。默认vision模式：`vision.enabled`开启后，辅助视觉模型为每个媒体生成一次文字描述——照片与静态sticker直接描述，视频（含视频sticker与GIF动图）抽最多3张代表帧、一次provider调用综合理解；结果按media identity持久化进`media.vision`列并在所有bot之间复用，以immutable media-update event追加而不是改写旧context，主模型读到的是`[图片: 描述]`占位，因此任何聊天模型都能用。UI使用缓存结果原位更新，不额外调用模型。opt-in的context模式完全不调用视觉模型：照片与静态sticker直接作为图片进入主模型上下文，视频本地抽取1-3张代表帧；媒体准备的全部成本是Telegram下载与本机转码。每张图片按固定1,100 token计入上下文预算，同时受`media.max_images_per_turn`（默认4）与上下文预算双重约束，超出的媒体自动降级为文字占位；准备好的图片记录进`media.context_files`持久化并跨bot复用。主模型必须声明图片输入，否则daemon启动即失败（`image_input_unsupported`）。两种模式下voice/audio/非视频document/TGS动态贴纸始终是文字占位——这是当前模型API的硬限制，不是可配置项。

用户和bot的static照片/sticker都先落canonical DB并共用一条有界展示缓存；vision模式的video source只在真实vision turn中lazy准备。SQLite只保存cache-relative文件名，deployment移动后不会继续把TUI绑定到旧绝对路径。同一媒体按media identity只准备一次，pruning与context packing共用这同一份事实。两种模式的视频抽帧都需要FFmpeg；缺失时视频在下载前跳过、只留文字占位，不占provider token，也不影响聊天、图片或sticker发送。固定sticker目录仍是system prompt里的固定前缀（含已持久化的描述），不参与每轮图片挂载。

成功compaction后，daemon会删除所有当前配置bot都不再引用的有界批次本地媒体文件；未消费消息与待回复媒体仍保留。消息、视觉描述与`media.context_files`、sticker short id和Telegram file mapping不会删除，因此以后重新需要时可以下载source，并继续复用已有的vision结果或派生文件。restart也不会把这批无引用历史自动下载回来。

权威流程见[架构](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md)的媒体链路章节。

## 6. 网页只按需读取且结果有界

搜索与读取网页复用一个tool，不增加第四项稳定schema。query只返回最多5条短结果；url只有模型明确需要时才发出一次网络请求，正文先受8,000字符本地护栏约束，再受2,048 provider tokens上限约束。群链接不会eager fetch，所以未使用网页能力的turn没有额外网络请求或动态token。

页面正文是不可信数据，URL安全和日志脱敏在确定性代码中完成，不用额外模型调用。单次fetch仍会产生TinyFish请求并把有界正文加入当前动态context，实际成本取决于调用频率与页面长度。

## 7. UI 与 telemetry 走side channel

Pi native feed、assistant partial、feed status widget、`/tg status`和Telegram control使用本地IPC/SQLite/control plane。它们可观察运行状态，但不进入persona或主provider context。

因此打开Pi、滚动历史或查看usage不会消耗一次聊天模型调用。权威边界见[Pi原生transcript架构](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md)与[Cache工程](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md)。

## 如何评估自己的 deployment

1. 用`/tg status [bot]`或Telegram `/status`按[统一 telemetry 口径](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/telemetry.md)记录runs、当前context/window、prompt miss/read/write、output、reasoning、latency与cost；“lifetime”只表示配置的SQLite保留窗口。`≈` 表示 provider 未返回 cache token 细项时的本地严格前缀估算，不证明 provider 实际命中。每个run仍按原始 provider usage 与当时实际provider/model费率固化cost，本地估算不回算费用；切换模型后的累计值会保留旧模型费用并加上新模型费用，订阅provider的值可能只是等价按量估算。
2. 比较同类活跃期，不把不同provider/persona/群规模混为一组。
3. 调整compaction阈值时用`bun run debug`与`llm_runs`遥测的context数据做依据；不要凭感觉改。
4. 任何prompt/tool/serialization改动先按[开发指南的cache流程](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/engineering/development-guide.md)验证golden和epoch。
5. 同时比较每个有效公开回复与每个run的成本；沉默或发送失败的run仍产生provider成本。
6. 设计新能力时先尝试删除一层、一个tool、一次模型调用或一个动态字段；未经明确需求，不把单群deployment扩成多租户系统。
