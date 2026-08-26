# 安装与首次配置

本项目让 1..N 个各有 persona 的 AI bot 住进一个 Telegram supergroup。设计目标是快（daemon 常驻、消息直接路由）、上下文优化（provider prefix cache 让重复上下文不重复计费）、简洁（一套配置、没有中间概念），省成本是这三者的结果。

配置只有一套：`telegram.config.ts` 放非 secret 设置，`.env` 放 token 等 secret，模型认证由 Pi 管理。下面的向导会在最后一步替你写好这些文件。

## 1. 准备本机环境

安装 Bun，然后 clone 仓库并进入项目目录：

```bash
git clone <repository-url> pi-extension-telegram-agent
cd pi-extension-telegram-agent
bun run pi
```

`bun run pi` 会在项目 Pi CLI 不存在时执行 frozen-lockfile 安装，再启动锁定的 Pi 0.84.1。它不读取相邻的 `../pi` 源码。若你需要显式预安装，可运行 `bun install --frozen-lockfile`。

## 2. 准备 Telegram

对每只 bot：

1. 在 BotFather 创建 bot 并保存 token。
2. 使用 BotFather 的 privacy 设置关闭 group privacy，使 bot 能收到普通群消息。
3. 把 bot 加入目标 supergroup；如果群权限限制发言，为它开放发送消息权限。
4. 准备 supergroup 的数字 ID。向导接受裸正数、负数或 `-100...` 形式并统一归一化。

不要把 token 发进群、issue、日志或 Git。每只 bot 必须有自己的 token env key。

## 3. 准备 Pi 模型

在项目 Pi 会话中：

1. 运行 `/login`，完成 Pi 原生 provider 登录。
2. 运行 `/model`，选择默认provider与聊天模型。默认 vision 模式下主模型不需要图片输入；如果打算用 `media.mode: "context"` 让主模型直接看图，所选模型必须支持图片输入，否则daemon启动会以`image_input_unsupported`失败。即使交互式Pi会话使用其他thinking level，Telegram runtime仍默认reasoning `off`，除非在`telegram.config.ts`显式覆盖。

Telegram 项目读取 Pi 合并后的 global/project 模型设置与 Pi auth store，不把模型 credential 复制进本仓库。首次向导默认 `tools.search: false`，所以不需要先申请 TinyFish key。

## 4. 运行 `/tg config`

配置文件缺失或无效时，`/tg config` 仍会出现在 Pi 帮助和补全中，不需要先启动 daemon。

向导打开输入框前，会先在本地用 Pi catalog/auth 预检并显示 `provider/model:thinking`；这不会调用模型。随后依次要求：

1. 中文或 English public persona template；
2. Telegram supergroup ID；
3. 本机 bot ID、Telegram 显示名、token env key 名与 BotFather token；
4. 最终写入确认。

Pi 当前原生 `input` dialog 没有密码遮罩。BotFather token 输入时可见；请使用私密终端，不要录屏或共享屏幕。向导不会把它写进 notification、进程参数、Pi session 或 provider context。provider 认证留在 Pi 中，这里不会再次询问。

按 Esc 取消任一步都不会留下半份配置。确认后会原子写入：

- `.env`：Telegram token，mode 0600，Git ignored；
- `telegram.config.ts`：Telegram deployment字段；向导固定刚刚通过预检的Pi provider/model，其余字段省略并继承有界默认（reasoning off、search/`run_js`/vision关闭、`media.mode`为默认的`"vision"`、有界context/cache/retention），mode 0600，Git ignored；
- `personas/<bot-id>.local.md`：本机 persona，mode 0600，Git ignored。

## 5. 确认 ready

向导先用 production loader 验证完整配置，再执行受控 daemon restart。只有命令退出成功并明确报告 `daemon ready` 时，Pi 才打开 all-bots feed。

如果 Pi 缺少有效默认模型或认证，预检会在任何 dialog 和写入前停止。先用 Pi `/login`、`/model` 修复，再运行 `/tg config`。

如果 Telegram credential 或网络导致 readiness 失败，已验证文件会保留，界面不会声称已连接。按顺序执行：

```text
/tg status-daemon
/tg restart
```

必要时查看 `data/daemon.log` 的脱敏诊断。不要为了重试反复覆盖配置。

## 已有配置

再次运行 `/tg config` 时可以：

- 验证现有 deployment；
- 用 Pi editor 编辑项目根 `telegram.config.ts` 原文，确认后保留完整 backup；
- 对默认 source 明确执行“备份并替换”；
- 取消并保持所有字节不变。

下一步：[配置与添加 bot](configuration.md)。
