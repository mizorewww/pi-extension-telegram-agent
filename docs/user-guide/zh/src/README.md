# Pi Telegram Agent 用户指南

[English guide](https://mizorewww.github.io/pi-extension-telegram-agent/en/) · [返回项目 README](https://github.com/mizorewww/pi-extension-telegram-agent#readme)

本指南面向部署和使用者。你不需要先理解内部架构，就能把 1..N 个可配置 AI 群友接入一个 Telegram supergroup，并用 Pi 原生界面观察和操作。

## 最短路径

1. 准备群 ID 与 BotFather token，并用 Pi `/login`、`/model`完成模型登录与默认选择。
2. 在仓库中运行 `bun run pi`。
3. 在 Pi 执行 `/tg config`，完成后等待 all-bots feed 自动打开。

按顺序阅读：

- [安装与首次配置](getting-started.md)：Telegram与Pi模型准备、原生向导。
- [配置与添加 bot](configuration.md)：typed config、secret 边界、routing 和 N-bot。
- [在 Pi 中聊天和观察](using-pi.md)：attach、compose、history 与 telemetry。
- [日常运维](operations.md)：daemon、配置变更、备份与多群隔离。
- [故障排查](troubleshooting.md)：从可观察症状到安全的下一步。
- [成本设计概览](design-cost.md)：为什么 routing/cache/context/媒体/UI 不浪费调用和 token。

## 产品边界

- 一份 deployment = 一个 Telegram supergroup + 1..N bots。
- 关闭 Pi 不会停止 daemon；Telegram 群才是实际聊天场所，Pi 是本机观察和控制界面。
- 多群需要隔离工作目录和全部 data/session/process 资源；当前不支持同目录并行多群。
- `telegram.config.ts` 是会执行的受信本机代码，不是下载配置的沙箱。
- tracked 文件不含有效 credential 或真实 deployment persona；旧 Git 历史仍可能包含已移除的 persona。
