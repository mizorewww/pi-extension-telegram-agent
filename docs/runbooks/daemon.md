# Runbook：daemon 起停与 bot 配置

## 配置

- **首选路径**：运行 `bun run pi`，先用 Pi `/login` 与 `/model`完成模型认证/默认选择，再执行 `/tg config`。向导在任何写入前本地预检并显示`provider/model:thinking`，随后只收集一个bot的Telegram最小配置，写入ignored `telegram.config.ts`、`.env`与`personas/<id>.local.md`，再走本runbook的受控restart。Pi当前没有密码输入控件，Telegram token输入时可见；只在私密终端操作，不要录屏或共享屏幕。
- 已有配置重跑 `/tg config` 时可验证、用 Pi editor 编辑项目根 source，或在明确确认后备份并替换默认 source。
- **手工路径**：复制 `telegram.config.example.ts`、`.env.example` 与一个 public persona template，再按下列字段编辑。
- `telegram.config.ts`（项目根，唯一配置文件）：复制 `telegram.config.example.ts` 后编辑，`defineConfig()` 提供类型与逐字段注释。它会作为受信本机代码执行，不要粘贴来源不明的配置。
  - `group_peer_id`：群的裸正数 peer id（`-100...` 形式会被自动归一化）
  - deployment 默认模型：canonical example显式选择`openai-codex/gpt-5.6-luna`、reasoning `off`与short cache retention。旧配置省略provider/model时仍继承Pi合并后的选择，但省略reasoning始终是`off`；切换provider必须同时给model，认证始终来自Pi。
  - 每 bot：`id`（`[A-Za-z0-9_-]+`，唯一）、`name`、`token_env`（指向 `.env` 里的 token key）、`persona_path`（绝对路径 / `~` / 相对项目根，可放仓库外）、`routing_p`（Σ≤1），可选覆盖 provider/model/reasoning/cache retention、compaction、12k suffix/4096 message预算、cooldown、`tools`与`sticker_sets`。顶层另有`context_window`（主模型有效上下文上限，同时把`compaction_threshold`压到`context_window − 16384`以内）、`media`（`mode`选`"vision"`默认或`"context"` opt-in；context模式下每次模型调用的图片上限`max_images_per_turn`与下载/抽帧并发`download_concurrency`）、`vision`段（`enabled`默认false、`foreground_media_limit`、`concurrency`，仅vision模式生效）和90/30/365天telemetry/raw/event retention。模型覆盖只是选择，不承载credential。
  - `sampling_cooldown_ms` 默认 2000，可全局设置并由单 bot 覆盖；必须有限且 `>=0`，0 关闭概率冷却。它只影响 probability routing，mention/reply/name 不会被静默吞掉。
  - `provider_timeout_ms` 默认 300000（5 分钟）、`provider_retries` 默认 2（共 3 次尝试），可全局设置并由单 bot 覆盖。单次 provider 调用超过 timeout 即中止请求（abort 信号同时传给 Pi 的 fetch）并按指数退避（10s/20s/40s…，60s 封顶）重试；预算耗尽后该 turn 以 error 收尾而非永久卡死。上游长挂（如本地 cliproxy 上游故障）时 bot 自动恢复，无需手动 restart。
  - `context_image_budget_bytes` 默认 10000000（约 50 张降采样照片），可全局设置并由单 bot 覆盖。上下文图片以 base64 传输，provider 计费 token 严重低估其成本（Gemini 3 按质量档固定计费 ~532 token/张，50 张仅 ~2.7 万 token，128K 窗口装得下；瓶颈是传输字节而非计费），文本阈值永远等不到；图片总字节超过预算即触发压缩。压缩后历史图片进摘要并清理文件与 DB 引用，上下文恢复轻量，不会反复触发。
  - `telegram_admins`：Telegram群内控制白名单，接受正整数user id或规范化`@username`；推荐固定numeric id。缺省/空数组会拒绝所有`compact`/`set`，但不影响公开`help`/`status`。
- `.env`（`key: value` 冒号格式）：只放项目拥有的secret——bot tokens、`tiny_fish_api_key`、`router_secret`、`gpg_key_passphrase`（仅签名用）。LLM credential由Pi auth store独占。只有至少一个bot启用`tools.search`时才强制要求对应TinyFish key；首配默认关闭search，可在补key后编辑配置开启。
- 改配置后重启daemon生效（无热重载）；本机persona除公开模板外默认被Git忽略。model/persona/cache policy/tools等cache-visible字段变化会在restore前生成新fingerprint/session/epoch，旧session文件保留但不会错误恢复。
- 一份配置/daemon只对应一个`group_peer_id`。同一checkout的`data/`、pid、socket与DB是共享deployment资源，不能只换配置文件并行跑第二个群；多群当前必须使用彼此隔离的工作目录与data目录，不能共享DB/session/socket/pid。

## 启动

```bash
bun run start                      # 后台运行，日志 data/daemon.log
bun run src/main.ts start --foreground   # 前台（调试用）
bun run restart                    # deployment-wide 优雅重启全部配置 bot
bun run status                     # 状态（pid 校验：cmdline 必须是本项目 daemon）
bun run stop                       # SIGTERM 优雅停止
```

生产部署（Linux）用 systemd user unit 托管，崩溃/被 OOM 杀后自动拉起，开机自启：

```bash
systemctl --user enable --now telegram-agent   # unit: ~/.config/systemd/user/telegram-agent.service
sudo loginctl enable-linger <user>             # 不登录也随开机启动
```

- unit 前台跑 `bun run src/daemon/index.ts`，stdout/stderr 仍追加到 `data/daemon.log`；`Restart=on-failure` + `OOMScoreAdjust=-200`。
- 与 CLI 不冲突：`bun run stop` 是 SIGTERM 干净退出，不会触发 Restart；日常 `status`/`restart`/`stop` 照旧用 CLI。


- 配置了sticker sets时，首次Telegram catalog拉取可能延长启动；以后复用本地DB。默认`media.mode: "vision"`下媒体理解由`vision.enabled`（默认false）与`auxiliary_visual_model`控制；选择`"context"`时主模型必须支持图片输入（用Pi `/model`确认catalog input含image），不支持时启动直接以`image_input_unsupported`失败。`start`会在60秒内等socket；超时但child仍存活时只报告starting，并提示用`status` / `daemon.log`确认。
- daemon启动会把历史`media.local_path`按basename迁到当前deployment的`data/media`；static photo/sticker恢复可显示状态，video source恢复为lazy抽帧输入，缺失项清空。启动backfill最多恢复100个仍被当前配置bot上下文、未消费event或reply obligation引用的static缺口，不会重新下载compaction已回收的无引用历史。该过程不调用vision或聊天provider。
- 视频抽帧要求PATH中同时存在`ffmpeg`与`ffprobe`——两种媒体模式都靠它处理视频。macOS可用`brew install ffmpeg`，Arch Linux可用`sudo pacman -S ffmpeg`，Debian/Ubuntu可用`sudo apt install ffmpeg`。缺失时`start`/`restart`/`status`会说明它只用于视频抽帧并建议安装，但命令与daemon readiness不因此失败；聊天、图片vision/图片上下文和static/animated/video sticker发送都继续工作，视频（含视频sticker与GIF动图）在vision模式跳过识别、在context模式只以文字占位进入上下文。视频在Telegram下载前直接跳过，不消耗provider token，也不向群里告警；当前模式需要抽帧时`bun run debug`会输出带固定impact/action的`video_transcoder_unavailable`。安装后restart即可启用。
- 每 bot 启动日志的 `sticker-catalog` 行会报告 `catalog/sendable/missing_file_id`；`missing_file_id>0` 的条目不会暴露给该 bot。检查 set 名/token 权限或 Telegram `getStickerSet` 失败，不要复制另一个 bot 的 file_id。
- 配置错误会在启动期逐条列出（stderr / daemon.log），不会静默跑坏配置。
- 双 start 竞态由排他pid锁挡住；并发restart由`data/daemon.control.lock`串行，第二个立即报`restart already in progress`。
- restart会验证同仓库进程身份，并回收同一deployment里缺失于pid file的孤儿daemon；foreign PID与仅在参数中提到daemon路径的shell命令不会收到signal。旧PID、pid file与socket全部消失后才spawn，新socket必须可真实连接才报告ready。
- 首次初始化超过60秒但child仍存活时只报告starting；child早退会显示`data/daemon.log`中有界且脱敏的末尾，不会输出token/env值。

## 观察

先用只读、零网络诊断入口判断链路停在哪层：

```bash
bun run debug -- --since 30m
bun run debug -- --bot A --since 2h
bun run debug -- --bot A --show-provider-content  # 敏感，本机单bot取证
```

默认输出不含消息正文/secret/path，聚合daemon、cursor/obligation、routing claim、LLM run、安全事件、结构化log与完整provider结构元数据，并标记route无run、模型沉默、tool preflight失败和send degraded。显式`--show-provider-content`会在stdout显示完整system/当前session投影，可能包含群正文、tool result与thinking，只可本机短暂取证。`daemon.log`为JSONL，受控start/restart前按8 MiB轮转保留3代且mode 0600；不要把整个文件贴到issue。字段与判断方法见[Debug指南](../engineering/debugging-guide.md)。

```bash
bun run pi                          # 从项目依赖启动 Pi，自动加载 Telegram extension
```

进入 Pi 后：

```text
/tg config              # 首配、验证或安全编辑本机配置
/tg attach              # 全局视角：群消息 + 全部 bot LOCAL 事件
/tg attach friend       # 单 bot 视角：群消息 + 仅 friend 的 LOCAL/usage
/tg compose friend      # 可选：固定原生 editor 以 friend 身份连续发送
/tg compose off         # 暂时关闭发送模式，editor 提交给 Pi agent
/tg compose             # 恢复当前 feed scope 的 Telegram 发送
/tg more                # 显式加载一页更早历史
/tg detach              # 断开实时订阅，已显示内容保留
/tg status friend       # lifetime + latest usage/latency 详细通知
/tg start              # 启动 daemon
/tg restart             # 优雅重启deployment并恢复当前feed filter
/tg stop                # 停止 daemon
/tg status-daemon       # daemon 进程状态
```

- Telegram feed 是 Pi transcript 中一个 TUI-only custom entry；滚动、resize、选择、editor 与图片布局由 Pi fullscreen host 负责。
- attach 会自动进入 Telegram scope compose：单 bot filter或全局唯一bot直接发送；全局多bot每次提交复用Pi原生`select`选择身份。editor上方的feed header在`attached`后显示`send as <id/name>`或`choose bot on send`，选择与发送时原位更新。`compose <bot-id>`固定身份，`compose off`把输入交还Pi，bare `compose`恢复scope。
- compose 仅支持纯文本。附件会被阻止；明确失败会把原文放回 editor。若 ACK 超时或 daemon 在发送中断线，结果可能未知：先检查群聊，不要直接重发；插件不会自动重试，并会安全关闭 compose。
- selector取消会恢复原文且不发送；选择/发送期间拒绝第二次提交。RPC/extension source不受compose影响。attach切换会建立新scope；detach、daemon断线、restart/config变更或Pi退出会关闭compose并让迟到选择失效；bot token始终只在daemon内。
- 媒体如何到达模型由`media.mode`决定，媒体本身都仍inline显示，UI不调用模型。默认vision模式：显式开启`vision.enabled`后，photo/sticker/video被有界lazy流程识别，同一native media card或placeholder下方原位出现`Vision · ...`描述；视频最多抽3帧并合成一次vision调用，所有bot的下载→抽帧→识别共用deployment的`vision.concurrency`上限。context模式：照片与静态sticker作为图片直接进入主模型上下文，视频抽1-3张代表帧；每次模型调用最多附`media.max_images_per_turn`张图，下载/抽帧共用`media.download_concurrency`并发，超出上限或上下文预算的媒体降级为文字占位。两种模式下voice/audio/非视频document/TGS动态贴纸都只有文字占位；缺少FFmpeg时视频保留文字占位与fallback。
- attached feed 的footer与Pi原生信息顺序一致：cwd/branch/session name；Telegram lifetime `↑/↓/R/W/CH/$`、latest context与右对齐的provider/model/reasoning；其他临时extension status仅在存在时追加。compose status位于feed header。无关的Pi operator usage行在attached期间隐藏，detach后恢复。`/tg status [bot]`列出runs/since/epoch、latest cache/output/reasoning/latency/cost与lifetime totals/平均latency。
- 在editor输入`/tg `后按Tab/选择使用Pi原生分级菜单；`attach/status/compose`的下一层会从配置动态列出bot id/name，`compose`另有`off`，bare `compose`也可直接执行。
- 关闭 Pi 或 `/tg detach` 不影响 daemon。
- `/tg restart`先关闭compose并中止旧IPC；在途manual send按unknown outcome处理且绝不自动重发。ready后保留原transcript，自动以原bot/all filter重连；失败时保留已显示内容与可执行诊断。

## Telegram 群内控制

下列命令直接发到配置群，由daemon确定性处理；它们不会进入persona或主LLM上下文。Telegram客户端菜单不可见时仍可手工输入：

```text
/help
/status
/compact                                  # telegram_admins only
/set <routing_p|cooldown_ms> <value>      # telegram_admins only
```

- 命令默认作用于接收消息的 bot；`/<command>@<bot_username>` 由该 suffix bot 定向回复/执行；未知 deployment suffix 不接管。
- `set` 写穿 `telegram.config.ts`（原子写入 + 全量 loadConfig 校验，任何一步失败回滚文件），成功后立即更新内存 effective 值；重启后仍然生效。routing_p 总和超过 1 时校验失败、整次拒绝。
- `compact` 只作用于接收/定向的单个 bot，不接受自定义 instructions。busy/stopping bot 不会被 abort。它会调用配置的compaction模型并产生相应费用；成功提交新visibility后，还会按全部当前配置bot的引用回收最多256个本地媒体cache文件（source与context模式派生图片）。该observer不删历史/vision结果/file mapping，失败不回滚compact；有候选时日志记录`post_compaction_pruned`聚合数。
- 回复始终引用原命令。命令 edit 只消费、不执行；replay/second-bot 副本不会重复 mutation 或回复。发送结果未知时 daemon 不自动重试。

## 新增一个 bot

1. `.env` 加一行 token：`my_bot_token: REPLACE_WITH_BOTFATHER_TOKEN`
2. `telegram.config.ts` 的 `bots` 数组加一项（id 唯一、`token_env` 指向新 key、persona 文件存在）
3. 重启 daemon → 启动日志会列出新 bot；Pi 中 `/tg attach <id>` 可单独观察
4. 需要 sticker 就加`sticker_sets`；启动时同步的固定目录以identity + format形式（set + static/animated/video + emoji + short_id）固化进该bot的system prompt，模型按short_id直接发送，不做每轮检索

## Opt-in 第三个 bot 真实 smoke

这组操作会调用真实provider与Telegram，可能产生费用/群消息；默认测试不会执行。准备一个只用于验收的bot id（下例为`C`）后逐项记录结果：

1. 在`.env`加入C的Telegram token；在配置追加C、独立persona与`routing_p: 0`。若选择不同Pi provider，同时显式给`provider`与`model`，并先在Pi完成对应登录。
2. `bun run restart`，确认日志出现C的`getMe` identity及`provider/model`，且A/B/C都只有一个poller，没有409。
3. `bun run scripts/smoke-pi.ts --bot C`，确认当前配置的Pi provider/model完成一次headless调用。
4. `bun run scripts/e2e-agent.ts --bot C`，确认真实群出现C的run/send结果；需要compaction验收时再运行`bun run scripts/e2e-compaction.ts --bot C`。
5. 在Pi执行`/tg attach C`、`/tg status C`、`/tg compose C`，确认C过滤、独立lifetime stats与手动发送；再切回全局feed确认A/B/C同时可见。
6. 在Telegram分别mention与reply C，确认只有C得到explicit response opportunity。验收后删除临时C配置并`bun run restart`；历史DB/session可保留但不会被未配置bot纳入IPC stats。

所有需要单bot身份的smoke/e2e脚本都强制`--bot <id>`；没有默认bot，未知id会在任何网络调用前失败并列出有效id。

## 故障排查

- `/tg config` 报Pi model not ready：尚未写文件；退出向导，用Pi `/login`、`/model`修复后重试。
- `/tg config` 报daemon not ready：已通过production loader的文件会保留。先执行`/tg status-daemon`，查看`data/daemon.log`中的脱敏诊断，修正Telegram/network后执行`/tg restart`；不要反复覆盖配置。
- `status` 报duplicate/orphan project daemon：运行`restart`；它只处理同仓库真实daemon entry并等待全部退出，避免Telegram long poll 409。
- malformed pid file与socket同时存在：controller会拒绝猜测；先检查`data/daemon.pid`、`data/daemon.sock`与`ps`，不要手工signal未经身份确认的PID。
- 面板无数据：尚无 llm_runs（bot 从未被触发）
- `/tg attach` 报「unknown bot id」：id 拼错，错误信息会列出全部配置的 id
- `/tg compose` 报 no connected feed：先 `/tg attach [bot]`，确认 transcript 已收到 snapshot；compose 不会自行启动 daemon
- Telegram群内mutation报权限不足：检查发送者的canonical numeric user id/`@username`是否在`telegram_admins`；display name、群匿名身份和bot身份都不会授权。
- 发送提示 unknown outcome：原文会恢复且 compose 自动关闭；先在 Telegram 群确认是否已出现，再决定是否重发
