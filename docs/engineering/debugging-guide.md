# Debug 指南

## 原则

先定位边界再猜原因：接收到 update、路由选中、Pi 接纳、provider 执行、Telegram 提交是不同事实。业务 archive 与 Pi 原生存储是权威，日志丢失不能改变行为。

日志只记身份和状态，禁止正文、prompt、响应、thinking、tool 参数、凭据、完整 URL/path 和 stack。单条 ≤4096 字节、≤24 字段、字符串 ≤256。使用 bot_id、message_id、requestId、原生 task/entry identity 关联，不建平行运行态。

## 第一入口

```bash
npm run debug -- --since 30m
npm run debug -- --bot A --since 2h
```

JSON schema 3 只读本地配置身份、业务 SQLite 和日志尾部：daemon 存活、archive high-water、poller offset、pending dispatch、最近 claims 与有界结构化日志。不读取 `.env`/Pi 凭据，不联网，不打开第二个 Harness，不导出消息正文或自动推断原因。

窗口最长七天，窗口外、被保留期删掉或日志轮转的证据可能缺失。概率触发合法地跳过或沉默。

## 回应链证据

1. raw update、canonical 行与不可变 event：是否接收并持久化。
2. pending dispatch 与 routing claim：是否完成向 bot 的交接，结果是 started/coalesced/skipped。
3. 生产进程内的原生 conversation / submission / task：Pi 是否接纳并执行。不要在运行中的数据库上另开一个恢复执行器。
4. `agent.response`：provider 返回类别与原始用量；不是 Telegram 发送证明。
5. `agent_send` 的 preflight/committed/degraded 与 canonical 发送行：远端提交与本地记账。

Pi `telegram.state` 的 admittedSeq 只表示持久化接纳位置，pending 保存未结清原文。只有确定尚未执行的发送可以重试；未知结果按 `no_retry` 结束，不能以“没查到 canonical 行”为由重发。

## 媒体与工作区

检查消息的 media 身份、该 bot 的 media_file_ids、下载状态、FFmpeg 能力、非空 media.vision 与追加 media_update。本地文件存在不等于已送进模型。view_image 返回的原生图片保存在 Pi；七天源缓存清理不影响既有会话。

容器通过 Pi RemoteExecutionEnv 连接。网络/权限/资源问题按 [sandbox runbook](../runbooks/sandbox.md) 检查；不要把模型凭据放进工作区来绕过问题。

## 日志契约

生产代码只用 `src/observability/log.ts` 的结构化 log。component/event 固定，字段仅 boolean、有限数字、短枚举或身份，Error 转固定 category。不记 token delta、typing 心跳或工具参数。

systemd 每次启动前按 8 MiB 轮转日志，保留三代、权限 0600。诊断不能为了观察而重放模型请求或 Telegram create；有副作用的真实验证见 [testing.md](../testing.md)。
