# 开发指南

日常开发流程。路由与硬约束见根目录 `AGENTS.md`，验证命令见 [testing.md](../testing.md)。

## 任务说明

给出可验证的契约，而不是模糊愿望或逐行脚本：需求、期望的可观察结果、相关文件、范围内/外、验收标准、硬约束（cache、兼容、安全）、边界例子、验证方式、文档义务、是否授权提交。

> 反例：“加个 cache，弄稳一点。”
> 正例：“60 秒内对同一不可变对象的重复读取不得产生第二次上游请求；cache 失败不改变错误语义；内存有界。覆盖命中/过期/上游失败/并发四个测试。不改公开接口。”

## 开发循环

1. **摸底**：只读受影响边界的文档章节，搜现有模式，确认归属层（`AGENTS.md` 第 4 节）。行为改动先回答 [Debug impact](debugging-guide.md#新功能的-debug-impact)。
2. **计划**：多文件、跨边界、改持久格式的工作先拆成 commit 大小的步骤。
3. **实现**：一次一个内聚步骤，按验证漏斗逐层验证。
4. **自审**：对照验收标准过 diff，确认 cache impact。
5. **提交**：每个步骤通过验证就立即原子提交，不积压。
6. **报告**：说清未验证的部分、假设与风险。

## Cache 与成本（每个任务都要回答）

1. **会不会改变 provider 可见字节？**
   - `NONE`：报告里写明。
   - `INTENTIONAL`：按 [cache.md](../cache.md#改动-cache-visible-内容的流程) bump 版本并更新 golden。
   - golden 意外失败是报警，不要随手改 expected。
2. **对命中率和每轮成本是正还是负？** 负影响要有理由；正影响用 `llm_runs` 实测。

设计取向：

- 稳定、跨 bot 共享的内容放前缀；动态内容只做有界的追加 suffix。
- 能用确定性代码（router、SQL、规则）解决的，不花 LLM token。
- 每轮新增的 provider 可见 token 必须有界；无界增长一票否决。
- UI 改动若影响了 provider payload，就是边界 bug。

写代码前先问：能不能少一层抽象或一个持久状态？能不能直接用 Pi 原生能力？能不能用确定性代码代替一次模型调用？能不能删掉一个动态字段？未经明确需求，不把单群 deployment 扩成多群、多租户或热加载。极简不能以削弱事务、幂等、超时、脱敏、类型检查或回归测试为代价。

## 文档

| 变化 | 更新 |
|---|---|
| 边界 / invariant | `architecture.md` |
| provider 可见字节 | `cache.md` |
| 表结构 | `data-model.md` |
| 用量字段 / 公式 | `telemetry.md` |
| 测试守卫 | `testing.md` |
| 长期有效的设计取舍或事故教训 | `engineering/decisions.md` |
| 用户命令 / 配置 / 排障 | 中英文 user-guide **同一提交**同步；README 只留最短路径 |

写法：一个事实只有一个权威位置，其它地方链接；段落短、只写当前事实；用表格写归属、用编号写流程；用户文档不写内部 invariant。过程记录靠 git 历史，不建过程文档。

文档站固定使用 mdBook 0.5.4：`bun run docs:build` 构建，`bun run docs:check` 构建并检查链接。发布只走 `.github/workflows/docs-pages.yml`。

## 提交

一个 commit 一个结果：

1. **一个可观察行为**（或一个纯机械变化），可以单独 review/revert。
2. **自包含**：实现、测试、该行为必需的文档一起提交；不提交会让主分支无法 typecheck 的半边改动。
3. **已验证**：lint、typecheck、相关测试通过后再提交。
4. **显式暂存**：按路径暂存，提交前看 `git diff --cached`；禁止 `git add -A`。
5. **签名**：GPG 签名失败就停下排查，不提交未签名 commit。不做 `reset --hard`、force push、改写已有历史。

Commit message：英文祈使句、首字母大写、≤72 字符、写具体的代码结果（如 `Filter sticker candidates by bot sendability`，而不是 `Update files`）。body 写“为什么”和关键 invariant，不列文件。纯机械提交在末尾空一行加 `Work-Type: mechanical`。
