# 文档索引

## 用户

- [README](../README.md) / [README.en](../README.en.md)：产品入口与快速开始
- [中文用户指南](user-guide/zh/src/README.md) · [English user guide](user-guide/en/src/README.md)（发布在 <https://mizorewww.github.io/pi-extension-telegram-agent/>）

## 开发与运维

| 文档 | 内容 |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | agent 常载：哲学、路由、硬约束、已知坑 |
| [project.md](project.md) | 三个世界、行为约束、术语、部署边界 |
| [architecture.md](architecture.md) | 进程、消息路径、发送边界、上下文、媒体、控制命令 |
| [cache.md](cache.md) | provider 可见字节、fingerprint、改动流程 |
| [data-model.md](data-model.md) | SQLite 表与保留期 |
| [telemetry.md](telemetry.md) | 用量与状态的字段和公式 |
| [testing.md](testing.md) | 验证漏斗与规范命令 |
| [engineering/debugging-guide.md](engineering/debugging-guide.md) | 诊断报告、证据梯、日志契约 |
| [engineering/decisions.md](engineering/decisions.md) | 长期有效的设计取舍与生产事故 |
| [runbooks/daemon.md](runbooks/daemon.md) | 启停、systemd、部署、备份、故障恢复 |
| [runbooks/sandbox.md](runbooks/sandbox.md) | bot 工作区：rootless Docker 用户、镜像、配置、清空 |

一个事实只在一处是权威，其它地方链接过去。改了什么，就更新对应的文档：

| 变化 | 更新 |
|---|---|
| 边界 / invariant | `architecture.md` |
| provider 可见字节 | `cache.md` |
| 表结构 | `data-model.md` |
| 用量字段 / 公式 | `telemetry.md` |
| 长期有效的设计取舍或事故教训 | `engineering/decisions.md` |
| 用户命令 / 配置 / 排障 | 中英文 user-guide 同一提交同步；README 只留最短路径 |
