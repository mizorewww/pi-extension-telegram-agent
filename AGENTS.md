# AGENTS.md

本文件是 agent 会话自动加载的唯一常载文档：短、稳定、高信号。用户说明统一在 `README.md`，发布变化在 `CHANGELOG.md`；这里保留工程约束。

## 1. 项目哲学

- **极简，最少机制**：一套设计，不留兼容层。Breaking change 随时可以做，只要求迁移干净、一步到位。
- **Pi 原生优先**：动手前先查 `node_modules/@earendil-works` 各包导出了什么；Pi 能做的事不自造轮子。
- **不花冤枉钱**：能用确定性代码解决的不花 LLM token；任何功能先评估 cache hit 率与每 turn 新增 token。
- 删代码优先于加抽象；防御代码只防真实可能的分支。

## 2. 仓库地图

- `README.md` — 安装、交互配置、使用与开发
- `CHANGELOG.md` — 发布变化
- `deploy/install.sh`、`deploy/configure.mjs` — 安装与配置的执行来源
- `src/config.ts`、`src/db/schema.sql` — 配置与归档 schema
- `scripts/release.mjs` — 发布产物与打包验证

## 3. 硬约束

- **Cache invariant**：永不改写已存在的 provider prefix；动态内容只以新 suffix 追加。每个请求必须是下一请求的严格前缀：不要做“只挂在最后一条”的动态尾部。每批的 sticker 附注只经原生 `beforeRequest` 投影为紧跟该批的〔系统附注〕消息并永久保留，永不写入持久化 entry.model——compaction 直接读持久化字节。cache-visible 协议（system prompt shape、persona 序列化、tool schema 与顺序、消息 / 摘要序列化 grammar、sticker catalog block）任一变化：bump `CACHE_SCHEMA_VERSION`、更新 `test/cache.test.ts` golden。
- Secret 不进日志、测试 fixture、commit；`.env` 不入库。
- daemon 生产模块只用 `src/observability/log.ts` 结构化日志；不记正文 / prompt / response / tool args / 完整 URL 与 path；业务正确性不得依赖日志。
- 不得为通过验证而削弱测试、类型检查或安全控制（如 codemode 边界、容器沙箱）。
- 不改 SQLite schema、消息序列化 grammar，除非有明确需求并更新相关 schema 与发布说明。
- 配置只有一套：`telegram.config.ts`（业务配置）+ Pi 内部 settings + `.env`（secrets）。禁止引入第二来源。

## 4. 改动路由

行为放进拥有该职责的层；不为归属不清新建共享抽象。归属不清先查现有调用点。

- Telegram API / 轮询 / normalize → `src/telegram/`
- schema / 持久化 → `src/db/`
- prompt / serialize / routing / runtime / provider-facing 工具 → `src/agent/`（tool description 是 cache-visible，见 `src/agent/tools.ts`）
- 进程管理 → `src/daemon/`
- 工具实现（search 等）→ `src/tools/`；codemode 接入 → `src/agent/extensions/codemode.ts`，注册顺序固定在 `src/agent/runtime.ts`
- 后台任务 → `src/tasks/`；工作区容器（sandbox）→ `src/sandbox/`；镜像 `deploy/box/Dockerfile`
- 配置文件写回（`/set`、`/model`）→ `src/onboarding/config-core.ts`

## 5. 测试规则

- 不搞 TDD：先想清楚设计再写代码，验证靠类型检查、真实运行和 e2e，而不是堆单测。
- `test/` 只留极少数守卫：cache golden、零外网、安全边界（沙箱 / codemode / search / 管理员命令）。新增守卫要能说清它守的是哪条一旦破了代价很高的 invariant，文件开头一行写明；不为 bug 机械补回归测试，不断言 prompt 字符串。
- `npm test` 零外网、零付费调用，由 `npm test` 的 Node `--import` preload 机械保证。

## 6. 验证漏斗

1. `npm run build && node --import ./dist/test/network-guard.js --test dist/test/<相关文件>.js` → `npm test`
2. `npm run check`（tsc --noEmit）
3. `npm run lint`（Biome lint + format check；`npm run format` 自动修）
4. `bash -n deploy/*.sh`、`shellcheck deploy/install.sh deploy/telegram-agent`（部署改动）
5. opt-in e2e：`scripts/e2e-*.ts`（需 `.env`，触真实服务，用户明确授权才跑）

规范命令以 package.json 与部署脚本为准。

## 7. 提交规范

- 原子提交：一个行为变化一个 commit；提交前只显式暂存本任务路径，禁止 `git add -A`。
- 提交自动 GPG 签名；签名失败停下诊断，不得绕过。不做破坏性 git 操作（reset --hard / force push / 改写历史）。
- subject：英文祈使句、首字母大写、≤72 字符、描述具体代码结果；纯机械变更末尾加 `Work-Type: mechanical`。
- 提交前跑覆盖本次改动的测试。

## 8. 已知坑

- `npm test` 强制 UTC：涉时间序列化的测试必须 pin TZ（参考 `test/cache.test.ts`，生产为 Asia/Singapore）。
- 本机 `telegram.config.ts`/`.env` 可能与生产共用 bot token：不要在开发机启动 daemon 或跑 e2e，两个 poller 会抢同一 token（409）并造成线上停摆。需要真实验证时在服务器上做。
- `.env` 是 `key: value` 冒号格式，由 `src/config.ts` 自解析，不是 dotenv 的 `KEY=value`。
- Pi 各包（含 durable、env、chord、ai、coding-agent、schema、codemode）精确锁定 registry `1.5.0`；升级必须同一原子提交一起更新 manifest、lock 并做兼容性验证。
- sticker / alias 的 short_id 用 rowid 分配，不用 COUNT+1（并发 / 删除下撞号）。
- Pi Durable 拥有会话与执行恢复，`guardModels` 只包装完整 provider deadline、413 归一化与有效规划窗口；不要再引入 AgentSession 状态机。升级时验证 unsafe send 重启边界与原生 task journal。

## 9. 指南更新规则

单次失误不加规则。新增 / 修改规则须满足：非显然、会复发、可执行。能机械强制的优先做成测试 / lint / schema check，而不是文字。
