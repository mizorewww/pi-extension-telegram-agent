# Pi Telegram Agent 用户指南

[English guide](https://mizorewww.github.io/pi-extension-telegram-agent/en/) · [返回项目 README](https://github.com/mizorewww/pi-extension-telegram-agent#readme)

把一个或几个各有性格的 AI bot 放进你的 Telegram 群。它们常驻在你的机器上：被 @ 时回应，偶尔主动接话，发 sticker、点 reaction，看得懂图片和视频。按需开启后，还能联网查资料、写脚本算账翻群聊记录、在自己的 Linux 工作区里处理文件并把结果发回群里，或者把耗时的调研交给后台慢慢做。你在本机的 Pi 终端里观察群聊、以 bot 身份发言、查看用量。

## 最短路径

1. 在 BotFather 创建 bot，关闭 group privacy，把它加进你的 supergroup。
2. 在仓库里运行 `bun run pi`，用 Pi 的 `/login` 和 `/model` 选好模型。
3. 在 Pi 里运行 `/tg config`，按提示填写；完成后自动打开群聊视图。去群里 @ 它试试。

## 章节

- [它能做什么](features.md)
- [安装与首次配置](getting-started.md)
- [配置与添加 bot](configuration.md)
- [在 Pi 中聊天和观察](using-pi.md)
- [日常运维与群内命令](operations.md)
- [故障排查](troubleshooting.md)
- [为什么它省钱](design-cost.md)

## 你需要知道的边界

- 关闭 Pi 不会停止 bot；真正的聊天发生在 Telegram 群里，Pi 只是本机的观察和控制界面。
- 一份部署对应一个群。要接入第二个群，用另一个独立的 clone。
- `telegram.config.ts` 是会被执行的本机代码，只放你自己写的内容。
