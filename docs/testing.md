# 测试

`test/` 只保留长期 invariant 与安全边界的守卫。新功能可以先写失败测试驱动实现，稳定后删掉只锁实现细节的脚手架测试；能确定性复现的 bug 留一个回归测试。

## 验证漏斗

由便宜到贵，跑到能覆盖改动的那层为止：

```bash
bun test test/<相关文件>   # 1. 直接覆盖改动的测试
bun test                  # 2. 全量（零外网、零付费调用）
bun run check             # 3. tsc --noEmit
bun run lint              # 4. Biome lint + format（bun run format 自动修）
bun run docs:check        # 5. 文档站构建 + 链接检查
```

真实服务验证只能显式 opt-in（需要 `.env`，会产生费用或发群消息）：

```bash
bun run scripts/smoke-pi.ts --bot <id>         # 单次真实 provider 请求
bun run scripts/e2e-agent.ts --bot <id>        # 真实链路
bun run scripts/e2e-compaction.ts --bot <id>   # 通过公开 control 入口压缩
bun run scripts/e2e-examples.ts --photo <id> --pdf <id> --thread <id> --sender @user   # 提示词里每个【脚本】示例对真实工具跑一遍；改 tool-examples.md 后必跑
```

## 守卫清单

| 文件 | 守护什么 |
|---|---|
| `cache.test.ts` | cache-visible 协议 golden：system prompt、tool schema 与顺序、event 序列化、摘要输入、extension 顺序；每批 sticker 附注作为独立〔系统附注〕消息紧跟该批且永久保留（请求严格前缀）；工具声明只写已开启的工具；摘要不含 thinking。 |
| `context.test.ts` | fingerprint 变化或 session 文件缺失时不恢复；压缩切点计入图片；未发送的 assistant 文本不进入后续 context；裁剪 session 文件后 provider context 逐字节不变且可重复执行；view_image 结果只存引用、投影逐字节稳定，并计入可见集合、图片预算与压缩保留预算。 |
| `runtime.test.ts` | 直接点名的回复义务（bot 触发的点名不产生义务）：coalesce 不丢、失败 turn 保留且不记零用量、沉默只补答一次、结果未知不重发；慢的看图描述不会让回复等待超过短等待上限；`tg_post` 中间消息不结清义务、每轮最多 2 条；回合中的新点名被 steer 进来时同一次 send 结清两个义务且不重复打包，没送达时留给下一轮；真实 Pi 压缩在图片超预算时触发、失败 turn 不触发阈值摘要但保留 overflow 恢复。 |
| `session-control.test.ts` | `/model` 与 `/new` 原子切换 session/epoch、失败不改旧状态、重启后恢复；变更类命令只允许人类管理员，命令消息不进 provider context；`/fire` 默认关闭、只由人类管理员按 bot 开关。 |
| `telegram.test.ts` | mention 优先于 reply；bot 消息只在目标 bot 开启 `/fire` 时按正常路由触发，不改投、不触发自己、额度耗尽即停、人类发言补满；同部署 bot 的 agent send 写库后本地路由，poller 回声不二次 dispatch，控制回复与写库失败的发送不路由；路由交接在 handler 失败并重启后仍送达；manual send 结果未知不重发；未配置 bot 的 cursor 不阻塞保留期清理。 |
| `provider-guard.test.ts` | 请求创建/消费 deadline 中止且不重试；HTTP 413 进入 Pi overflow 恢复。 |
| `codemode.test.ts` | codemode 脚本没有 host 能力、调不到 `send`、只能调用可调用工具；结果有宿主上限，脚本图片不进 session；Pi 在工具调用结束后、下一次模型调用前送达 steer 的自定义消息（升级 Pi 时守住该语义）。 |
| `messages.test.ts` | `tg_messages` 只读本群：不返回控制消息与其他 chat，分页无缝，LIKE 通配符被转义；附件占位符带清洗后的文件名、大小、时长；全文索引能找到中文子串、按相关性排序、随编辑同步，并为旧库补建。 |
| `sandbox.test.ts` | 工作区容器参数始终带隔离 flag、不挂宿主机目录、不传 env；路径（含容器内软链接解析结果）不能离开 `/work`；每周清空每个边界只触发一次、首次见到不清空；`send` 的文件缺失时在任何 Telegram create 之前失败；文件以 multipart 上传（单张走 sendPhoto，多个走带 reply 的 sendMediaGroup）。 |
| `tasks.test.ts` | 任务容器参数带隔离 flag、凭证不进 argv；RPC 帧不被 U+2028 切开；报告变成所属 bot 的 note，进展节流，完成 / 失败 / 需要输入时对发起人产生义务；daemon 停止不判失败，重启后 running 任务从原 session 继续、need_input 任务等回答再启动；用量写入 `task_usage`；note 只进入所属 bot 的输入；后台 job 的完成 / 失败 / 中断都在发起消息上产生 note 与义务，并发受限。 |
| `search.test.ts` | search 只访问公网 HTTP(S)，遥测不含 query/URL/正文/key；长页分页可完整读完且不重复抓取。 |
| `daemon-control.test.ts` | 进程归属识别（含空格路径）、拒绝其他部署与无法验证的 pid。 |
| `network-isolation.test.ts` | `network-guard.ts` preload 机械拒绝外网，即使存在真实 `.env`。 |

## 规则

- 测可观察轨迹与结果，不断言 prompt 字符串；cache golden 是唯一例外。golden 失败是报警：确认变化是有意的，按 [Cache 工程](cache.md) bump `CACHE_SCHEMA_VERSION` 后再改 expected。
- 涉及时间序列化的测试先 pin `TZ`（`bun test` 强制 UTC，生产为 Asia/Singapore）。
- 不得为通过而删除或削弱断言、类型检查或 sandbox 等安全控制。
- 失败先定位来源：被改的行为、过期 golden、环境（TZ、bun 版本）、外部服务；与本次改动无关的既有失败单独报告。
