# 安装与首次配置

## 1. 准备本机

需要 [Bun](https://bun.sh/) 和本机安装的 Pi（`pi --version` 能运行）。

```bash
git clone https://github.com/mizorewww/pi-extension-telegram-agent.git
cd pi-extension-telegram-agent
bun install --frozen-lockfile
```

可选：安装 `ffmpeg`（同时提供 `ffprobe`），开启看图后 bot 才能看懂视频；没有它，视频只显示成文字占位，其它功能不受影响。macOS 用 `brew install ffmpeg`，Debian/Ubuntu 用 `sudo apt install ffmpeg`，Arch 用 `sudo pacman -S ffmpeg`。

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

模型认证只保存在 Pi 里，不会写进本仓库。默认配置不看图，任何聊天模型都可以；之后如果把 `media.mode` 改成 `"hybrid"`，主模型必须支持图片输入。

## 4. 写配置

```bash
cp telegram.config.example.ts telegram.config.ts
cp personas/template.zh.md personas/friend.local.md
```

1. 新建 `.env`，写入 bot token（`key: value` 冒号格式，不是 `KEY=value`）：

   ```text
   telegram_bot_token: 123456789:AA...
   ```

2. 编辑 `telegram.config.ts`：填 `group_peer_id`；删掉 `provider` 和 `model` 两行就沿用 Pi `/model` 的选择；把 bot 的 `name` 改成群里叫它的名字，`persona_path` 改成 `personas/friend.local.md`。每个字段都有注释，拼错或不认识的字段启动时会被拒绝。
3. 在 `personas/friend.local.md` 里写这个 bot 的人格设定。

这三个文件都被 Git 忽略，只放在你的机器上。

## 5. 启动

```bash
bun run start
```

daemon 在前台运行，Ctrl-C 停止；长期运行请交给 systemd，见[日常运维](operations.md#启动和停止)。输出里出现 `"ready"` 后，去群里 @ 你的 bot 试试，或发 `/help`、`/status` 查看群内命令与状态。

起不来时终端会给出原因，常见的是 token 错误、网络不通、bot 不在群里或所选模型不在 Pi 目录里，见[故障排查](troubleshooting.md)。

之后改配置：直接编辑 `telegram.config.ts`，然后重启 daemon。

下一步：[配置与添加 bot](configuration.md)。
