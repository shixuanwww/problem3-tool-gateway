# 答辩问答（`docs/defense/`）

> **为什么必须有这份东西**：题面原话 ——
> 「我们会对项目细节进行深入提问，**如果你不能答出细节可能会被认为过度使用 AI**。」
> 这是本题唯一的评分门。每个模块下面的三块结构固定：
> ① 这段在干什么（一句话）② 关键设计决策 + 为什么 ③ 可能被追问的问题 + 要能答的要点。

| # | 模块 | 文件 | 对应代码 |
|---|---|---|---|
| 1 | 可信工具表 + 参数校验器 | `01-registry-and-validate.md` | `server/gateway/registry.ts` `validate.ts` |
| 2 | 沙箱四道闸门 | `02-sandbox.md` | `server/gateway/sandbox.ts` |
| 3 | 五步决策与优先级 | `03-service-five-steps.md` | `server/gateway/service.ts` |
| 4 | 确认的精确绑定 | `04-approval-binding.md` | `canonical.ts` `service.ts` |
| 5 | 一次性与并发 | `05-once-and-concurrency.md` | `service.ts` `handleDecision` |
| 6 | 审计与持久化 | `06-audit-and-persistence.md` | `audit.ts` `service.ts` |
| 7 | 超时与安全重试 | `07-timeout-and-retry.md` | `executor.ts` |
| 8 | Client 的职责边界 | `08-client.md` | `client/*.ts` |
| 9 | MCP 接入 | `09-mcp.md` | `server/mcp/server.ts` |
| 10 | 间接提示词注入 | `10-prompt-injection.md` | `sandbox/web/promo.html` + 演示 |
