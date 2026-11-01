# Pi Telegram Agent

[中文](README.md) · [English](README.en.md)

让几个各有性格的 AI bot 长期住进你的 Telegram 群，像真实的群友一样聊天。它们跑在你自己的机器上，基于 [Pi](https://github.com/earendil-works/pi) agent，你在本机的 Pi 终端里观察和控制一切。

- **会聊天**：被 @ 时一定回应，偶尔主动接话，发 sticker、点 reaction，看得懂图片和视频。
- **会干活**（按 bot 逐个开启）：联网搜索和读网页；写脚本精确计算、翻查群聊历史；在自己的 Linux 工作区里处理文件，把做好的图片和文件发回群里；把耗时的调研交给后台任务，做完再回复你。
- **省钱**：要不要回应由确定性代码决定，不白花模型调用；prompt 前缀保持不变以复用 provider cache。
- **简单**：一个配置文件，加一个 bot 就是在数组里加一项。

可以这样问它：“@Mochi 上周谁提过火锅？”“把这个 PDF 第二页转成图片发出来”“调研一下三款入门相机，整理成报告”。更多见[它能做什么](docs/user-guide/zh/src/features.md)。

## 快速开始

需要：[Bun](https://bun.sh/)、本机安装的 [Pi](https://github.com/earendil-works/pi)（`pi` 在 PATH 中）、一个 Telegram supergroup，以及至少一个**关闭了 group privacy** 并已加入群的 [BotFather](https://t.me/BotFather) bot。

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
bun install --frozen-lockfile
bun run pi
```

在打开的 Pi 里：

1. `/login` 登录模型 provider，`/model` 选默认模型（凭据只保存在 Pi 里）；
2. `/tg config` 运行配置向导，填群 ID、token、persona。完成后 daemon 自动就绪。

去群里 @ 你的 bot 试试，或发 `/help` 看群内命令。

> Pi 的输入框没有密码遮罩，粘贴 token 时不要录屏或共享屏幕。

## 文档

- [用户指南](docs/user-guide/zh/src/README.md)（[在线版](https://mizorewww.github.io/pi-extension-telegram-agent/zh/)）：[配置与新功能](docs/user-guide/zh/src/configuration.md) · [日常运维与群内命令](docs/user-guide/zh/src/operations.md) · [故障排查](docs/user-guide/zh/src/troubleshooting.md)
- 主机运维：[daemon 与 systemd](docs/runbooks/daemon.md) · [bot 工作区（rootless Docker）](docs/runbooks/sandbox.md)
- 参与开发：从 [AGENTS.md](AGENTS.md) 和 [docs/index.md](docs/index.md) 开始

BSD 2-Clause 协议，见 [LICENSE](LICENSE)。
