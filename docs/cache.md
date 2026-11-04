# Cache 工程

目标是在同一原生上下文片段内，让 provider 已见过的消息保持不变，新信息只追加。原生 compaction/reset 会建立新前缀；不能把跨压缩的请求称为严格前缀。

## Invariants

1. system 顺序固定为群聊协议、persona、sticker 目录；tool 名称、描述、schema 与注册顺序固定。
2. Telegram 批次在接纳时序列化一次，edit、引用补全、vision 作为新 delta，不能用最新 canonical 行重算历史输入。
3. 每批 sticker 候选保存在原生 entry 的 metadata，投影为紧跟该批的独立系统附注，之后原样保留；不能只挂在最新一条。附注不进入持久化模型正文，避免原生摘要把候选当成群成员已说过的话。
4. 图片使用原生 image content；清理下载缓存不能改变 Pi 已持久化字节。模型不需要重复看图时由 hybrid 描述承接。
5. fingerprint 不同先 reset，再启动该配置的 provider 请求；旧 Pi 记录保留。控制命令不进入模型上下文。
6. 每批输入采用统一字符预算，近期事件与待回复原文共享上限；单条截断，未打包的待回复项继续保留。网页正文分页，sticker 候选最多八条。

## Cache-visible 内容与改动流程

共享协议、persona、sticker 目录、工具声明/顺序、序列化 grammar、sticker 投影、补答策略、Pi 版本、模型/reasoning/cache retention 与媒体模式都会影响 cache 身份。runtime 用实际注册表与配置构建 fingerprint；原生工具声明由 Pi 负责。

修改任意协议时：bump `src/agent/prompt.ts` 的 `CACHE_SCHEMA_VERSION`，运行 cache guard，核对预期变化再更新 golden，并同步本文。当前 **v48** 切换到 Pi Durable：原生 input/toolResult/summary、原生图片、coding tools/codemode 与 child conversation；删除自建 context/摘要/telemetry 协议。旧 JSONL session 不导入新 Harness，archive 继续保留。

```bash
npm run build
TZ=UTC node --import ./dist/test/network-guard.js --test dist/test/cache.test.js
```

## Provider 输入

```text
system:   群聊协议 → persona → 固定 sticker 目录
messages: 原生 Telegram input → 该批系统附注 → assistant/toolResult → 后续 input
          Pi 原生压缩时替换旧片段为 summary，近期原文保持原样
tools:    实际启用的 Telegram tools、Pi coding tools 与 codemode
```

不再把未公开的 assistant 文本改写成 `[no_send]`，也不把原生图片替换成外部文件引用。公开发送只由 send 工具决定，存储方式不决定是否发群。

## Telegram grammar

既有 grammar 保持不变：`#消息ID`、发送者、`↪ #父消息`、日期分组，以及追加的 `message_edit` / `message_metadata` / `media_update`。无 username 的用户仍用 rowid 分配别名，引用优先使用消息自身的 reply_snapshot。后台任务报告由原生 `telegram.task` input 承载，附带发起消息身份。

## 压缩与成本

使用 Pi 原生摘要，沿用当前模型和 reasoning effort。固定预留 16,384 token，摘要输出上限不超过 13,107 token 和模型上限的较小值。原生摘要文本不包含 image/thinking；sticker 系统附注只参与普通请求投影。

不再维护图片字节预算、签名修正估算、独立廉价摘要模型或分块摘要器。Pi 1.5.0 对加密 thinking signature 和超大摘要的限制见 [设计决策](engineering/decisions.md)。原生失败恢复有边界，不能承诺任意超大输入都压缩成功。

Cache 用量直接采用 Pi/provider 计量，不维护请求 HMAC 对账或推算命中率。口径见 [telemetry.md](telemetry.md)。
