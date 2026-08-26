# AGENTS.md

本文件是 agent 会话自动加载的唯一常载文档：短、稳定、高信号。详细内容一律在 `docs/`，这里只放哲学、路由、硬约束和坑。

## 1. 项目哲学

- **极简，最少机制**：一套设计，不留兼容层。Breaking change 随时可以做，只要求迁移干净、一步到位。
- **Pi 原生优先**：动手前先查 `node_modules/@earendil-works` 各包导出了什么；Pi 能做的事不自造轮子（审计结论见 `docs/engineering/code-review-2608.md`）。
- **不花冤枉钱**：能用确定性代码解决的不花 LLM token；任何功能先评估 cache hit 率与每 turn 新增 token（`docs/cache.md`、`docs/engineering/development-guide.md`）。
- 删代码优先于加抽象；防御代码只防真实可能的分支。

## 2. 仓库地图

- `docs/index.md` — 文档总索引
- `docs/project.md` — 项目目标、约束、术语
- `docs/architecture.md` — 架构边界与 invariant
- `docs/cache.md` — provider cache 工程（prefix invariant / CACHE_SCHEMA_VERSION）
- `docs/data-model.md` — SQLite schema
- `docs/testing.md` — 测试策略与规范命令
- `docs/engineering/development-guide.md` — 日常开发流程
- `docs/engineering/debugging-guide.md` — 结构化日志与 Debug impact
- `docs/engineering/documentation-guide.md` — 文档写作规范
- `docs/engineering/code-review-2608.md` — 2026-08 全面 review 结论与 Pi 能力审计
- `docs/engineering/code-review-2608-2.md` — 2026-08-13 四路并行 review:误报记录、修复决策与未采纳清单
- `docs/engineering/code-review-2608-3.md` — 2026-08-20 六区并行 review:造轮子 / hack / 过度防御 / 冗余清理
- `docs/runbooks/daemon.md` — daemon 运维
- `docs/user-guide/` — 双语用户指南

动手前只读与受影响边界相关的章节，不要把无关文档塞进上下文。

## 3. 硬约束

- **Cache invariant**：永不改写已存在的 provider prefix；动态内容只以新 suffix 追加。sticker 候选等动态尾部只经 `context` 事件投影注入 provider payload（每请求重建、只挂最后一条），永不写入持久化 custom message content——compaction 直接读持久化字节。cache-visible 协议（system prompt shape、persona 序列化、tool schema 与顺序、消息 / 摘要序列化 grammar、sticker catalog block）任一变化：bump `CACHE_SCHEMA_VERSION`、更新 `test/cache.test.ts` golden、同步 `docs/cache.md`。
- Secret 不进日志、测试 fixture、commit；`.env` 不入库。
- daemon 生产模块只用 `src/observability/log.ts` 结构化日志；不记正文 / prompt / response / tool args / 完整 URL 与 path；业务正确性不得依赖日志。
- 不得为通过验证而削弱测试、类型检查或安全控制（如 run_js sandbox）。
- 不改 SQLite schema、IPC 协议、消息序列化 grammar，除非有明确需求并同步文档。
- 配置只有一套：`telegram.config.ts`（业务配置）+ Pi 内部 settings + `.env`（secrets）。禁止引入第二来源。

## 4. 改动路由

行为放进拥有该职责的层；不为归属不清新建共享抽象。归属不清先查 `docs/architecture.md` 和现有调用点。

- Telegram API / 轮询 / normalize → `src/telegram/`
- schema / 持久化 → `src/db/`（schema 变更必须更新 `docs/data-model.md`）
- prompt / serialize / routing / runtime / provider-facing 工具 → `src/agent/`（tool description 是 cache-visible，见 `src/agent/tools.ts`）
- 进程管理 / IPC server → `src/daemon/`、`src/ipc.ts`
- TUI → `.pi/extensions/tg-extension.ts` + `src/plugin/timeline.ts`（UI-only 改动不得影响 provider payload）
- 工具实现（search / run_js）→ `src/tools/`，注册顺序固定在 `src/agent/runtime.ts`
- 安装向导 → `src/onboarding/`

## 5. 测试规则

- 鼓励 TDD：新行为先写失败测试再实现。脚手架测试在功能稳定后必须删除——`test/` 只保留护长期 invariant / 安全边界的守卫，清单见 `docs/testing.md`。
- 能确定性复现的 bug 必须有回归测试；agent 行为测可观察轨迹与结果，不断言 prompt 字符串。
- `bun test` 零外网、零付费调用，由 `bunfig.toml` 的 test preload 机械保证。

## 6. 验证漏斗

1. `bun test <相关文件>` → `bun test`
2. `bun run check`（tsc --noEmit）
3. `bun run lint`（Biome lint + format check；`bun run format` 自动修）
4. `bun run docs:check`（文档站构建 + 链接检查）
5. opt-in e2e：`scripts/e2e-*.ts`（需 `.env`，触真实服务，用户明确授权才跑）

规范命令以 `docs/testing.md` 为准；仓库已有脚本时不要猜底层命令。

## 7. 提交规范

- 原子提交：一个行为变化一个 commit；提交前只显式暂存本任务路径，禁止 `git add -A`。
- 提交自动 GPG 签名；签名失败停下诊断，不得绕过。不做破坏性 git 操作（reset --hard / force push / 改写历史）。
- subject：英文祈使句、首字母大写、≤72 字符、描述具体代码结果；纯机械变更末尾加 `Work-Type: mechanical`。
- 提交前跑覆盖本次改动的测试。

## 8. 已知坑

- `bun test` 强制 UTC：涉时间序列化的测试必须 pin TZ（参考 `test/cache.test.ts`，生产为 Asia/Singapore）。
- Bun `socket.write` 返回字节数且可能部分写入：必须编码成 Uint8Array 后按字节偏移排队写（参考 `src/ipc.ts`）。
- `.env` 是 `key: value` 冒号格式，由 `src/config.ts` 自解析，不是 dotenv 的 `KEY=value`。
- Pi 四包精确锁定 registry `0.84.1`；升级必须同一原子提交更新 manifest、lock 并做兼容性验证。
- sticker / alias 的 short_id 用 rowid 分配，不用 COUNT+1（并发 / 删除下撞号）。
- `streamFunction` 包装（`src/agent/runtime.ts`）是 Pi 的官方注入形态（`Agent.streamFunction` 是公开可变字段，函数包函数注入 `cacheRetention`）；`createAgentSession()` 不接受 streamFn 选项，只能事后覆盖。升级 Pi 时仍必须验证该包装（见 `docs/engineering/code-review-2608.md`）。

## 9. 指南更新规则

单次失误不加规则。新增 / 修改规则须满足：非显然、会复发、可执行。能机械强制的优先做成测试 / lint / schema check，而不是文字。
