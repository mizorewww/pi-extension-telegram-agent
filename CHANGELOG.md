# v1.1.12

- 新增 `cron` 工具（模型与 Code Mode 均可调用）：支持相对时长（`15m`/`2h`/`1d`）、带时区 ISO 时间（单次提醒）与 5 段 cron 表达式（按服务时区周期触发），持久化在 `daemon_state` 中跨重启与 `/new` 保留；`/task` 与 `/task cancel cN` 同步支持查看与管理员取消。cache schema 升到 58。

# v1.1.11

- 删除自建缓存保温器、自定义 HTTP 连接池包装、未使用的视觉/搜索遥测回调管道、控制命令冗余协调层与已过期的 v1.0 多 bot 数据库迁移代码，移除 `undici` 顶层依赖，较 v1.1.9 净删约 250 行代码。

# v1.1.10

- 升级 Pi 各包到 1.5.2，统一迁移配置与工具声明到 `@earendil-works/pi-schema`，移除 `typebox`、`@earendil-works/pi-tui`、`@earendil-works/pi-agent-core` 顶层依赖。cache schema 升到 57，升级后开启新会话。
- 接入 Pi 同款 `undici` HTTP/1.1 全局连接池（避免 Node 内置 HTTP/2 会话假死），并使用 `@earendil-works/pi-ai` 原生经济学策略为声明缓存周期的模型自动做提示缓存保温。
- 修复待回应追踪（`TelegramState.pending` 改按 `InboxDoc` 水位清理，压缩后不再误留并触发重复恢复）、失败轮次后的队列推进（`afterFailedRun: "continue"` 与子任务队列回收）、Code Mode 并发排队、任务取消竞态及 `.env` 向导合并保存。
- 归档 SQLite 统一开启 `busy_timeout` 与 `synchronous = NORMAL`，移除手写锁重试；补齐外链 IPv6 转换段拦截，复用 Pi 原生文本与 token 估算工具。

# v1.1.9

- 接话判断可以用 Gemini Decisions API：`decider.model` 写 `google/gemini-decision-1`，用 `.env` 的 `gemini_api_key`（Pi 还没有 Gemini classifier，所以直接调用）。它会看最近几条消息里最新的 4 个图片、sticker 或视频截帧，3 秒内没准备好的媒体仍按文字占位。配置向导的默认判断模型改为它。
  - 在 400 条真实群聊切片上（看过图片后重新标注），gemini-decision-1 看图、不带示例时 ROC-AUC 0.874，pplx-decider-v1.2 为 0.847；同样约 30% 接话率下 F1 0.58 对 0.56。差异不显著，PR-AUC 仍是 pplx 高（0.68 对 0.56）。
  - 接话阈值默认值从 0.15 改为 0.18：两种模型在 0.18 都接约 30% 的旁听消息。显式配置了 `decider.threshold` 的部署不受影响。
- 判断示例移出代码：`decider.examples_path` 指向配置目录里的 markdown 文件，原样附在判断说明后；`decider-examples*.md` 已加入 `.gitignore`。原来代码里的 14 个示例（为 pplx-decider 调过）放在 [gist](https://gist.github.com/mizorewww/1dc8c6d7f2e5e563e79ed910c009bae9)。**继续用 pplx-decider 的部署请下载它并配置 `examples_path`，否则升级后判断不带示例。** Gemini 实测不带示例最好。

# v1.1.8

- 新增群历史语义搜索：开启 `tools.semantic`（需要 Code Mode，并在 `.env` 写入 `gemini_api_key`）后，`tg_messages` 多一个 `semantic` 参数，用一句话描述要找的内容，就能找回换了说法、只记得大概或跨语言的历史对话，返回原文对话段。
  - 归档按 30 分钟静默或 800 字切成对话段，每段只用 `gemini-embedding-2` 嵌入一次（768 维），存在新表 `message_chunks`，检索在内存里算余弦相似度，不调用聊天模型。窗口大小来自生产归档上的实测：800 字比 1500、3000 字排序更准。
  - 后台每 5 分钟索引已结束的对话，按配额的一半限速并遵守 429 的 `retryDelay`。首次开启会回填全部历史：约 27 万条消息、720 万 token，约 $1.4，十几分钟完成。
  - 可与 `sender`、`since`、`until`、`text_contains` 等条件组合；`matches` 列出最多 10 段及分数。分数只在同一次结果内排序，没有可靠的“没找到”阈值，工具说明要求模型读原文判断。
  - cache schema 升到 56，开启 `semantic` 后开启新会话。

# v1.1.7

- 修正启动和每日维护时 bot 卡住约 75 秒：媒体缓存清理的查询没有命中索引，会逐行扫描全部消息，期间不收消息、轮询超时。现在毫秒级完成。
- daemon 不再因收到 `SIGUSR1` 打开 Node inspector。

# v1.1.6

- 修正工作区在 `/new` 或中断后失效：不再永久关闭与容器的连接，之后的 shell / 文件操作会重新拉起容器，不再一直报 `Connection closed` 直到重启。

# v1.1.5

- 修正 `/status` 上下文构成：`/new`、换模型或压缩后不再沿用上一请求的 token 总数，改为按上一请求测得的 provider/本地估算比例校准当前估算。

# v1.1.4

- 富文本不再限制文章篇幅：`send.rich` 的说明删去“富文本很占屏”，改为一条可写约 3 万字、决定写文章就一次写完整，不删减、不拆成多条。cache schema 升到 55，升级后开启新会话。

# v1.1.3

- `send` 新增 `rich` 字段，用 Telegram Bot API 10.1 的富文本消息（Rich Markdown）发送标题、表格、LaTeX 公式、脚注和折叠块，与 `message` 二选一。工具说明附带长文与数学推导的例子，并提示只在写长文或推导时使用，日常聊天仍用 `message`。Telegram 拒绝解析时不发送，错误交回模型改写。cache schema 升到 54，升级后开启新会话。

# v1.1.2

- 接话判断默认阈值从 0.45 降到 0.15，bot 更愿意接话：按“健谈的群友会不会接”重新标注 356 条真实切片，0.15 时接话召回从 0.16 升到 0.57，约三分之一的旁听消息会开启一轮。显式配置了 `decider.threshold` 的部署不受影响。
- `tg_messages` 的参数示例加入“看不懂群里的梗时先翻历史”。cache schema 升到 53，升级后开启新会话。

# v1.1.1

- 修复 v1.1.0 发布包打包失败（打包清单仍引用已删除的脚本）。v1.1.0 未发布安装包，请直接安装本版本；其余变化见 v1.1.0。

# v1.1.0

这是一次不兼容升级：一次部署只运行一个 bot，配置文件改为扁平结构。

- 删除多 bot 与概率路由。`bots` 数组、`routing_p`、`router_secret`、`/fire`、`/set` 全部移除；`name`、`token_env`、`persona_path`、`tools`、`sticker_sets` 移到配置顶层。
- 新增接话判断：人类 @、回复或叫名字时必回；其余消息（包括其他 bot 的发言）由 Pi 原生分类模型判断是否接话，默认 OpenRouter `perplexity/pplx-decider-v1.2`，阈值 0.45。判断模型只读最近的消息切片，不进入 bot 上下文。未配置 `decider` 时每条消息都接话；判断失败按接话处理。提示词与 14 个通用示例在 `src/agent/decider.ts`，按 150 条人工标注的真实切片调优。
- 删除 `view_image`：需要看清细节时，bot 用 `tg_download` 取到工作区，再用 Pi 原生 `read` 看图。hybrid 媒体描述改用当前聊天模型，删除 `media.vision_model`。
- 删除自带的 pid 锁，单实例由 systemd 保证；opt-in e2e 脚本在 daemon 运行时拒绝启动。
- `/status` 重新显示上下文构成（system prompt、工具声明、压缩摘要、消息与剩余空间）。
- 首次启动自动迁移归档数据库：保留与当前 token 对应 bot 的原始更新、file_id、轮询位置和工作区清空时间，删除其他 bot 的数据与 `routing_claims`。之后更换 token 会清空旧 bot 的 file_id 与轮询位置。
- 工作区容器与卷改名为 `tg-box`、`tg-work`，Pi 存储改为 `pi/agent.sqlite`。cache schema 升到 52，升级后开启新会话。

升级步骤：停止服务；把 `telegram.config.ts` 改成扁平结构（删除 `bots`、`routing_p`、`media.vision_model`，需要时加入 `decider`）；如需接话判断，在 Pi 中为 `openrouter` 保存 API key；可将 `pi/<bot id>.sqlite` 改名为 `pi/agent.sqlite` 以保留用量记录；然后运行安装命令。旧的 `tg-box-<id>` 容器与 `tg-work-<id>` 卷可以删除。

# v1.0.3

- sticker 目录随会话固定：目录 sticker 的描述在两次重启之间补齐时，不再导致下次启动重置会话；目录只在 `/new`、切换模型或目录本身变化时刷新。

# v1.0.2

- 修复升级后 Devin 对 codemode 内联系统目录的请求拒绝。首次请求完整声明固定工具；codemode 沿用 Pi 原生执行器，以固定可调用名单和返回类型共享这些工具的参数 schema。
- 历史查询支持按昵称查找发言者及其更名前后的记录；补齐用户、时间、关键词、回复和翻页示例。
- 新会话从当前群聊归档水位开始；已有 Pi 会话继续恢复保存的游标。
- 消息按完整批次渲染，优先保留当前正文，再分配引用空间；贴纸附注与实际入选消息保持一致。

# v1.0.1

- 修复首次安装时 systemd 卸载尚未启动的服务后，重置失败计数导致安装中断的问题。安装器按实际服务状态执行重置，并继续验证每个 bot 的首次成功轮询。

# v1.0.0

这是一次不兼容升级。旧版的仓库内运行、Bun、systemd user unit 和原后台任务部署方式全部废弃；不提供兼容入口或旧会话导入。

- 发布 Linux x64 安装包和 `install.sh`，附 `SHA256SUMS`。安装器校验官方校验和后，将 Node.js 24 私有安装到 `/opt/pi-telegram-agent/node`；程序包包含编译结果和锁定的生产依赖，不需要在服务器编译项目或更改系统 Node。
- 安装向导逐项配置 bot、模型、persona、媒体、容器与任务，保留已有值供修改；下载、校验、预检和启动显示当前阶段及预计耗时。
- 程序安装在 `/opt/pi-telegram-agent`，配置放在 `/etc/pi-telegram-agent`，状态与 Pi 认证放在 `/var/lib/pi-telegram-agent`，通过独立服务用户和 systemd system service 运行。群内配置写回继续保留。
- 全面采用 Pi 1.5.0 原生会话、SQLite 持久化、队列、压缩、工具、子会话和后台任务恢复，移除自建会话状态与 RPC 子进程管理。
- 文件和 shell 工具通过 Pi 原生 ExecutionEnv 进入工作容器；codemode 使用 Pi 原生沙箱。容器不再携带模型认证或独立 agent 引擎。
- `task` 的工作流改为 `AGENTS.md`；`job` 使用可恢复的原生脚本工具任务，不消耗模型 token。发送结果不确定时保持 `no_retry`，不会在恢复后重复发送。
- 保留 hybrid 媒体描述与按需观察原图；原生图片内容可进入 Pi 会话。
- 用户文档统一到根目录 `README.md`，删除独立中英文手册、文档站及其构建发布流程。

安装前先停止旧 daemon，并自行保管旧配置、认证和数据。新安装器以本版本的目录和服务布局为准。
