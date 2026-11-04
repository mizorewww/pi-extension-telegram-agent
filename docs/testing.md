# 测试

不搞 TDD：先把设计想清楚再写。`test/` 只有一小组守卫（cache golden、零外网、沙箱 / codemode / search / 管理员命令的安全边界），行为正确性靠类型检查、服务器上的真实运行和 opt-in e2e。

## 验证漏斗

由便宜到贵，跑到能覆盖改动的那层为止：

```bash
npm run build && node --import ./dist/test/network-guard.js --test dist/test/<相关文件>.js   # 1. 直接覆盖改动的测试
npm test                  # 2. 全量（零外网、零付费调用）
npm run check             # 3. tsc --noEmit
npm run lint              # 4. Biome lint + format（npm run format 自动修）
npm run docs:check        # 5. 文档站构建 + 链接检查
```

真实服务验证只能显式 opt-in（需要 `.env`，会产生费用或发群消息）：

```bash
node dist/scripts/smoke-pi.js --bot <id>         # 单次真实 provider 请求
node dist/scripts/e2e-agent.js --bot <id> --message <真实群消息ID> # 真实链路
node dist/scripts/e2e-compaction.js --bot <id>   # 通过公开 control 入口压缩
```

e2e-agent 与 e2e-compaction 必须先停止 daemon；脚本复用 pid lock 拒绝并行运行。agent 使用真实已归档的人类消息，不伪造 reply target；已被 Pi 接纳的消息会去重，应选新消息。

## 守卫

每个测试文件开头的注释说明它守的 invariant；新增守卫时写清楚这一行，不在这里另列清单。

文档站固定使用 mdBook 0.5.4，发布只走 `.github/workflows/docs-pages.yml`。
