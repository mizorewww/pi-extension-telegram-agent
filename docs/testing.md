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
```

## 守卫清单

| 文件 | 守护什么 |
|---|---|
| `cache.test.ts` | cache-visible 协议 golden：system prompt、tool schema 与顺序、event 序列化、摘要输入、extension 顺序；每批 sticker 附注作为独立〔系统附注〕消息紧跟该批且永久保留（请求严格前缀）；工具声明只写已开启的工具；摘要不含 thinking。 |
| `context.test.ts` | fingerprint 变化或 session 文件缺失时不恢复；压缩切点计入图片；未发送的 assistant 文本不进入后续 context；裁剪 session 文件后 provider context 逐字节不变且可重复执行。 |
| `runtime.test.ts` | 直接点名的回复义务：coalesce 不丢、失败 turn 保留且不记零用量、沉默只补答一次、结果未知不重发；真实 Pi 压缩在图片超预算时触发、失败 turn 不触发阈值摘要但保留 overflow 恢复。 |
| `session-control.test.ts` | `/model` 与 `/new` 原子切换 session/epoch、失败不改旧状态、重启后恢复；变更类命令只允许人类管理员，命令消息不进 provider context。 |
| `telegram.test.ts` | mention 优先于 reply；路由交接在 handler 失败并重启后仍送达；manual send 结果未知不重发；未配置 bot 的 cursor 不阻塞保留期清理。 |
| `provider-guard.test.ts` | 请求创建/消费 deadline 中止且不重试；HTTP 413 进入 Pi overflow 恢复。 |
| `sandbox.test.ts` | run_js 拿不到 host realm、超时与输出有界；有 bubblewrap 时原始代码也看不到项目文件和网络（仅 Linux）；search 只访问公网 HTTP(S)，遥测不含 query/URL/正文/key。 |
| `daemon-control.test.ts` | 进程归属识别（含空格路径）、拒绝其他部署与无法验证的 pid。 |
| `network-isolation.test.ts` | `network-guard.ts` preload 机械拒绝外网，即使存在真实 `.env`。 |

## 规则

- 测可观察轨迹与结果，不断言 prompt 字符串；cache golden 是唯一例外。golden 失败是报警：确认变化是有意的，按 [Cache 工程](cache.md) bump `CACHE_SCHEMA_VERSION` 后再改 expected。
- 涉及时间序列化的测试先 pin `TZ`（`bun test` 强制 UTC，生产为 Asia/Singapore）。
- 不得为通过而删除或削弱断言、类型检查或 sandbox 等安全控制。
- 失败先定位来源：被改的行为、过期 golden、环境（TZ、bun 版本）、外部服务；与本次改动无关的既有失败单独报告。
