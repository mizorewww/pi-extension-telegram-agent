# 文档索引

## 用户文档

- `../README.md` / `../README.en.md` — 中文 / English 产品入口与三步启动
- `user-guide/zh/src/README.md` — 中文用户指南
- `user-guide/en/src/README.md` — English user guide
- `https://mizorewww.github.io/pi-extension-telegram-agent/` — Pages 双语语言入口（由 Documentation workflow 发布）

## 规范性文档

- `../AGENTS.md` — agent 路由、安全、验证入口（常载）
- `project.md` — 项目目标、约束、术语
- `architecture.md` — 稳定的架构边界与 invariant
- `cache.md` — provider cache 工程：prefix invariant / CACHE_SCHEMA_VERSION / schema history / telemetry
- `telemetry.md` — Pi `/tg status` 与 Telegram `/status` 的统一 usage/status 读模型、字段和公式
- `data-model.md` — SQLite schema 与去重规则
- `engineering/development-guide.md` — **LLM 开发指南，日常开发流程以此为准**（含提交与追溯规则）
- `engineering/documentation-guide.md` — 文档写作规范
- `engineering/debugging-guide.md` — **结构化日志、只读诊断与新功能 Debug impact 规范**
- `testing.md` — 测试策略、规范命令、当前状态
- `runbooks/` — 可重复操作流程（daemon 运维）

## 审查记录

- [2026-09 设计审查与整改](engineering/code-review-2609.md)

## 写作规则

- 一个事实一个权威来源，其余地方链接而不是复制。
- 稳定事实放 architecture / cache / data-model；开发流程放 engineering/development-guide。
- 明确写清每篇文档的适用范围。
- 规范用词用 MUST / SHOULD / MAY；规范必须可验证或可 review。
- 模糊成本高的地方给具体例子。
