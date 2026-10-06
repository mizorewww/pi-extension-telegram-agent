# 安装与首次配置

## 1. 准备本机

需要 [Bun](https://bun.sh/) 和本机安装的 Pi（`pi --version` 能运行）。

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
bun install --frozen-lockfile
bun run pi
```

`bun run pi` 启动你 PATH 中的 Pi，并自动加载本项目的 Telegram 扩展。

可选：安装 `ffmpeg`（同时提供 `ffprobe`），bot 才能看懂视频；没有它，视频只显示成文字占位，其它功能不受影响。macOS 用 `brew install ffmpeg`，Debian/Ubuntu 用 `sudo apt install ffmpeg`，Arch 用 `sudo pacman -S ffmpeg`。

## 2. 准备 Telegram

对每个 bot：

1. 在 [BotFather](https://t.me/BotFather) 创建 bot，保存 token。
2. 在 BotFather 里关闭 **group privacy**，否则 bot 收不到普通群消息。
3. 把 bot 加入目标 supergroup，确认它有发言权限。
4. 准备群的数字 ID（`1234567890`、`-1234567890`、`-1001234567890` 三种写法都可以）。

token 等于 bot 的密码：不要发进群、issue 或 Git。

## 3. 准备模型

在 Pi 里：

1. `/login` 登录模型提供商；
2. `/model` 选择默认模型。

模型认证只保存在 Pi 里，不会写进本仓库。默认情况下主模型不需要支持图片（看图由可选的辅助视觉模型完成）；只有当你在配置里改成 `media.mode: "context"`、让主模型直接看图时，所选模型才必须支持图片输入。

## 4. 运行 `/tg config`

向导会先在本地确认模型可用（不会调用模型），然后依次询问：

1. 中文或英文 persona 模板；
2. 群 ID；
3. bot 的本地 ID、显示名、`.env` 里 token 的名字、BotFather token；
4. 最终确认。

> Pi 的输入框没有密码遮罩，粘贴 token 时请确保没有在录屏或共享屏幕。

任何一步按 Esc 取消都不会留下半份配置。确认后写入三个文件（都被 Git 忽略，权限 0600）：

| 文件 | 内容 |
|---|---|
| `.env` | bot token |
| `telegram.config.ts` | 群 ID、bot、刚确认的模型；其它设置用默认值 |
| `personas/<bot-id>.local.md` | 这个 bot 的人格设定，随时可以编辑 |

## 5. 等待就绪

向导校验配置后重启 daemon，只有 daemon 明确报告 ready 才打开群聊视图。去群里 @ 你的 bot 试试，或发 `/help` 查看群内命令。

如果没有就绪（通常是 token 错误、网络不通或 bot 不在群里），配置会保留，按顺序执行：

```text
/tg status-daemon
/tg restart
```

仍有问题就看 `data/daemon.log` 或[故障排查](troubleshooting.md)。不需要重新填 token。

## 已有配置时再次运行

`/tg config` 会让你选择：验证现有配置、在 Pi 编辑器里直接改 `telegram.config.ts`、备份后整体替换，或取消。替换时旧文件会以 `.bak-<随机串>` 保留。

下一步：[配置与添加 bot](configuration.md)。
