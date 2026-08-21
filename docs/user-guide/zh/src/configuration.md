# 配置与添加 bot

`/tg config` 是推荐入口。需要添加 bot 或调整高级项时，编辑 ignored `telegram.config.ts`，然后执行 `bun run restart` 或 Pi 中的 `/tg restart`。

## 文件边界

| 文件 | 保存什么 | 是否提交 |
| --- | --- | --- |
| `telegram.config.ts` | 群、bot、Pi 模型选择、routing、成本上限、tools | 否 |
| `.env` | Telegram/TinyFish token 与 router secret | 否 |
| `personas/*.local.md` | 真实 deployment persona | 否 |
| `telegram.config.example.ts` | public typed schema example | 是 |
| `personas/template.*.md` | public generic persona templates | 是 |

`.env` 使用项目自己的冒号格式，不是 dotenv 的等号格式：

```text
telegram_bot_token: 123456:REPLACE_WITH_BOTFATHER_TOKEN
router_secret: REPLACE_WITH_RANDOM_LOCAL_SECRET
```

## 成本优先的单 bot 配置

```ts
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  group_peer_id: 1234567890,
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  reasoning_effort: "off",
  cache_retention: "short",
  compaction_model: "openai-codex/gpt-5.6-luna:low",
  max_suffix_tokens: 12_000,
  max_message_tokens: 4_096,
  vision: {
    enabled: false,
    foreground_media_limit: 2,
    concurrency: 2,
  },
  telemetry_retention_days: 90,
  raw_update_retention_days: 30,
  message_event_retention_days: 365,
  bots: [{
    id: "friend",
    name: "Mochi",
    token_env: "telegram_bot_token",
    persona_path: "personas/friend.local.md",
    routing_p: 0.1,
    sticker_sets: [],
    tools: { send: true, search: false, run_js: false },
  }],
});
```

完整注释和高级默认见仓库根的 `telegram.config.example.ts`。TypeScript config 是受信本机代码；只编辑你自己维护的文件，不执行来源不明的片段。

## 添加第二或第三只 bot

1. 在 `.env` 增加独立 token key。
2. 从 public template 复制新的 ignored persona。
3. 在 `bots` 数组追加对象；`id` 必须唯一且只含字母、数字、`_`、`-`。
4. 执行受控 restart，并在 Pi 用 `/tg attach <id>` 与 `/tg status <id>` 验证。

```ts
{
  id: "helper",
  name: "Nori",
  token_env: "helper_bot_token",
  persona_path: "personas/helper.local.md",
  routing_p: 0,
  tools: { send: true, search: false, run_js: false },
}
```

`routing_p: 0` 只关闭普通消息的概率抽样；mention、直接 reply 和配置名称仍是明确触发。所有 bot 的 `routing_p` 总和必须 `<= 1`，配置顺序决定确定性概率桶顺序。

每个 bot 的 Telegram poller、agent session、模型选择、state 与 telemetry 都隔离；共享的是一个 Pi model runtime/auth snapshot、目标群与 canonical SQLite history。

## Pi 模型与 tools override

公开示例固定了一组成本优先profile：Luna、reasoning off、short cache retention，并用Luna low做compaction。向导会把已经通过Pi预检的provider/model固定进新配置，因此以后改变Pi默认值不会静默改变这个deployment。旧手写配置仍可省略这两个字段兼容继承Pi合并后的默认值；但省略`reasoning_effort`表示`off`，不再继承Pi的thinking level。daemon会通过Pi原生resource loader读取用户级已安装provider extension，因此插件提供的模型、能力与费用元数据和交互式Pi一致；项目extension不会进入bot session。单bot可以覆盖到另一个catalog entry；切换provider时必须同时填写provider和model。认证始终来自Pi，不来自本配置或`.env`。

`reasoning_effort`不仅必须是Pi全局枚举，还必须是所选模型实际支持的档位。Pi SDK本身会把不支持的值静默夹到最近档位；Telegram agent为避免费用、行为与状态显示不一致，会在任何Telegram/provider调用前拒绝启动，并列出requested与supported值。main bot、`compaction_model`及启用的vision模型执行同一检查。请在Pi `/model`查看可选档位；例如`deepseek-v4-flash`只接受`off`、`high`、`max`。

`compaction_model`的请求失败（provider error）时会自动用该bot的主模型重试一次并记录`compaction_fallback`日志，避免压缩模型不可用导致overflow的session永久卡死；主动abort（如daemon关停）不会重试。

以下边界都有默认上限：

- `max_suffix_tokens: 12000`和`max_message_tokens: 4096`限制每轮新增的Telegram provider context；
- 主聊天默认`cache_retention: "short"`，compaction使用配置的廉价task model且关闭provider cache retention；
- `vision.enabled`默认false；开启后，每轮最多处理`foreground_media_limit`个未缓存媒体，所有bot共用一个最多`concurrency`个active job的FIFO门。视频从Telegram下载到抽帧、provider请求全程占同一个slot。视频识别要求daemon主机PATH中有`ffmpeg`和`ffprobe`；缺失时下载前直接跳过且不占provider token，只给operator安装提示，不影响daemon、聊天、图片或sticker发送；
- telemetry、raw update、immutable message event默认分别保留90、30、365天。旧event只有在所有已知bot cursor都消费且没有reply obligation引用时才删除。

model、reasoning、cache policy、persona、tools、serializer等cache-visible字段变化都会得到新context fingerprint。受控restart会保留旧session文件，但在restore前创建新session，绝不会用新identity恢复旧context。

`tools`：

- `send`：允许agent发送本地转换为Telegram message entities的Markdown文字，以及static/animated/video sticker；普通正文保持普通字重；
- `search`：启用同一个TinyFish工具的有界网页检索与单页读取，需要 `.env` 中由 `tinyfish_key_env` 指定的TinyFish key；
- `run_js`：启用受限的确定性计算工具；默认关闭，因为模型提供的JavaScript即使经过sandbox仍有残余风险。

search与`run_js`只有字段显式为`true`才启用，不存在旧版隐式默认。启用search前把TinyFish credential加入`.env`（默认key名为`tiny_fish_api_key`）；它与Pi模型认证无关。启用后agent可显式搜索，或在回答确实需要页面内容时读取一个public HTTP(S) URL；不会自动抓取群里的每条链接，也不支持登录态、cookie或private/local地址。

## Routing 与管理命令

- mention > reply > 配置名称 > probability；bot 消息不会触发 bot-to-bot run。
- `routing_p` 是普通 human 消息的**回应机会**，不是最终群发言配额。每条 eligible 消息只生成一个确定性值并至多落入一个累计桶；当总和为 1 时，每条 eligible 消息恰有一个 probability target。
- `sampling_cooldown_ms` 只约束 probability 路径；默认 2000，0 表示关闭冷却。
- probability target busy 或 cooldown 时会直接 skip，不改投另一只 bot；mention/reply/name 走明确触发路径。即使成功开始，persona 仍可选择沉默，发送也可能失败，所以群内公开消息比例无需等于 `routing_p`。
- `telegram_admins` 默认空，拒绝 Telegram 群内 `compact`/`set`。需要时优先加入你自己的正整数 numeric user ID；不要复制示例占位值。
- Telegram `/set <routing_p|cooldown_ms> <value>` 写穿 `telegram.config.ts`（原子写入 + 全量校验，任何一步失败回滚文件），成功后立即更新内存 effective 值，重启后仍然生效。

只读诊断当前 deployment 用 `bun run debug`（见[运维](operations.md)与[故障排查](troubleshooting.md)）。

## 多群

一份 deployment 只有一个 `group_peer_id`。多个群必须使用隔离工作目录及 data/session/DB/pid/socket，不能在同一 checkout 只换配置文件并行运行。

下一步：[在 Pi 中聊天和观察](using-pi.md)。
