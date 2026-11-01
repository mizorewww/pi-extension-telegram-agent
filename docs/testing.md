# 测试

不搞 TDD：先把设计想清楚再写。`test/` 只有一小组守卫（cache golden、零外网、沙箱 / codemode / search / 管理员命令的安全边界），行为正确性靠类型检查、服务器上的真实运行和 opt-in e2e。

## 验证漏斗

由便宜到贵，跑到能覆盖改动的那层为止：

```bash
bun test test/<相关文件>   # 1. 直接覆盖改动的测试
bun test                  # 2. 全量（零外网、零付费调用）
bun run check             # 3. tsc --noEmit
bun run lint              # 4. Biome lint + format（bun run format 自动修）
bun run docs:check        # 5. 文档站构建 + 链接检查
```

真实服务验证只能显式 opt-in（需要 `.env`，会产生费用或发群消息）：

```bash
bun run scripts/smoke-pi.ts --bot <id>         # 单次真实 provider 请求
bun run scripts/e2e-agent.ts --bot <id>        # 真实链路
bun run scripts/e2e-compaction.ts --bot <id>   # 通过公开 control 入口压缩
bun run scripts/e2e-examples.ts --photo <id> --pdf <id> --thread <id> --sender @user   # 提示词里每个【脚本】示例对真实工具跑一遍；改 tool-examples.md 后必跑
```

## 守卫

每个测试文件开头的注释说明它守的 invariant；新增守卫时写清楚这一行，不在这里另列清单。

文档站固定使用 mdBook 0.5.4，发布只走 `.github/workflows/docs-pages.yml`。
