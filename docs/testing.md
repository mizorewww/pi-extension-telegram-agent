# 测试策略与状态

> 当前真实测试状态，不是计划书。本文件是测试与验证的唯一权威来源。

## 验证漏斗（由便宜到贵，按序跑到能覆盖改动的那层）

1. **目标**：`bun test test/<相关文件>` —— 直接覆盖被改行为的最小测试
2. **全量 unit**：`bun test`（不触网络）+ `bun run check`（tsc --noEmit）
3. **e2e**：`bun run scripts/e2e-agent.ts --bot <id>` / `e2e-compaction.ts --bot <id>`（需 `.env`，触真实配置 provider / Telegram，opt-in）
4. **真实群 / 长运行 smoke**：跨边界或稳定性改动才需要；观察 daemon.log、遥测、内存

## 当前测试集

`test/` 只保留长期 invariant 与安全边界的守卫，共 13 个测试文件：

- `cache.test.ts` — cache golden：锁定 cache-visible protocol 的 hash（system prompt、tool schema 与顺序、消息/compaction 序列化 grammar、extension 顺序、sticker catalog block）。任何 provider-visible 变化都会在这里报警。
- `context-protocol.test.ts` — context fingerprint / extension / model capability 契约：恢复 session 的 cache-identity 判断、structured context 协议、相邻 raw payload 严格前缀的本地 cache estimate、用户级已安装provider extension进入daemon shared runtime，以及不允许 Pi 静默 clamp 不支持的 reasoning 档位。
- `network-isolation.test.ts` — 证明 `bun test` 在真实 `.env` 存在时也机械拒绝外网 / 付费 API fetch（配合 `network-guard.ts` preload，只放行 loopback）。
- `runjs.test.ts` — run_js sandbox：正常计算可用，host realm 隔离与资源限制成立。
- `search.test.ts` — TinyFish search/fetch 契约：参数边界、SSRF prefilter（public IP 表）、untrusted boundary、telemetry 脱敏；只用本地 Bun server。
- `db.test.ts` — SQLite migration：旧库迁移幂等且保留历史 telemetry；本地 cache estimate 只回填同 cohort 的严格 payload 前缀，不覆盖 provider usage 或 `cache_retention=none`。
- `media.test.ts` — 跨bot Telegram media source配对、static/animated/video sticker metadata与原始file_id发送、vision模式（描述singleflight/persistent cache跨bot复用、视频固定代表帧单次vision调用、deployment全视频流水线并发门、缺FFmpeg时下载前no-op且不持久化terminal结果）与context模式（photo/static sticker转换、video抽帧singleflight与`context_files`持久化复用、失败可重试）、TGS/voice/audio不产出上下文图片、部署路径迁移、static sticker展示缓存、compaction后跨bot引用保护/派生文件清理/失败重试/启动不复活回收文件，以及Pi attach filter握手、activity单卡/原生thinking/完整正文、username与视觉描述乱序合并。
- `telegram-control.test.ts` — `/status` 的 InputRichMessage Markdown、统计数字千位分隔与缓存命中率、独立 plain projection、create→canonical persistence，以及仅在确定性rich拒绝时单次fallback的exactly-once边界。
- `telemetry.test.ts` — Pi/Telegram status共享读模型：latest排除compaction、lifetime/live totals包含compaction、切换provider/model后的immutable per-run cost累计、本地 estimate 的 `≈` 标记、统一费用精度、runtime snapshot、统一字段顺序、context/window与`CH = R/(↑+R+W)`派生口径。
- `runtime-obligation.test.ts` — direct address（explicit @mention / reply / 配置名称点名）在 coalesced trigger 下仍建 durable obligation 并交付、已可见不重复建、普通 overflow 静默消费设计锁定，以及 flushLoop teardown 窗口 trigger 不滞留。

## 测试选择规则

- **鼓励 TDD**：新行为先写失败的测试再实现。但脚手架测试在功能稳定后必须删除——测试集只保护长期 invariant 与安全边界，不锁实现细节，不为覆盖率保留一次性验收测试。
- 能确定性复现的 bug fix 必须有回归测试。
- 契约变化（IPC 协议 / schema / 序列化 grammar）需要跨边界测试。
- Agent 行为测可观察轨迹与结果，不断言 prompt 字符串。
- provider cache 相关改动必须跑 `test/cache.test.ts` golden；golden 失败是报警，先查原因，确认是有意变更后按 `docs/cache.md` 流程 bump version 再更新 golden，不要随手改 expected value。
- 涉时间序列化的测试必须 pin TZ（`bun test` 强制 UTC，参考 `test/cache.test.ts`，生产为 Asia/Singapore）。
- `bun test` 即使检测到真实 `.env` 也不得调用外网或付费 API；`bunfig.toml` 的 test preload 只放行 loopback。真实 TinyFish / provider / Telegram 验证只能用明确 opt-in 的 e2e 脚本或一次性脚手架，脚手架验收后立即删除，不能按 credential 存在自动启用。
- 不得为了通过而删除或削弱断言、类型检查或安全控制。

## 运行命令

```bash
bun test                # 全量 unit（零外网、零付费调用）
bun run check           # tsc --noEmit
bun run lint            # Biome lint + format check（bun run format 自动修）
bun run docs:check      # 文档站构建 + 链接检查
bun run scripts/smoke-pi.ts --bot <id>              # 当前 bot 的 Pi provider/model smoke（需 .env）
bun run scripts/e2e-agent.ts --bot <id>              # 真实链路 e2e（需 .env，opt-in）
bun run scripts/e2e-compaction.ts --bot <id>         # 通过公开control入口验证compaction（需 .env，opt-in）
```

## 失败诊断

改源码前先定位失败来源：1) 被改的行为 2) 过期的生成物 / golden 3) 缺 bootstrap / build 产物 4) 环境或工具链不一致（TZ、bun 版本）5) flaky / 外部依赖（Telegram、DeepSeek、TinyFish、codex）6) 与本次改动无关的既有失败。外部 / 既有失败单独报告，不混入本次结论。

## 已知 flaky

（暂无）

- `daemon-control.test.ts` — 进程归属识别、含空格路径与跨部署拒绝。
