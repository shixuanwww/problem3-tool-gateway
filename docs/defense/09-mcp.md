# 模块 9：MCP 接入

**代码**：`server/mcp/server.ts`

## 1. 这段在干什么

把四个工具以 MCP 的形式暴露出去，让 MCP Client 能 `tools/list` / `tools/call`；**而所有调用都走同一个 `GatewayService.handleToolCall`**。

## 2. 关键设计决策 + 为什么

| 决策 | 为什么 |
|---|---|
| 🔴 `tools/call` **必须**调用同一个 `GatewayService.handleToolCall` | 题面原话："MCP 请求仍然必须经过同一个 Gateway，不能因为换成 MCP 就绕过参数校验与确认流程"。这是本模块的**唯一**重点 |
| 🔴 "同一个"必须落到实处：`startStdioServer` **全程只构造一个** `GatewayService`，每条消息复用它 | 反例（改前的写法）：`handleMcpMessage` 里 `opts.service ?? new GatewayService()`，而 stdio 主循环不传 `service` ⇒ **每条消息都新建一个实例**。那样 approvals 的内存 `Map` 每条消息重建，两个进程各自 `persistState()` 还会互相覆盖 —— 字面上就不是"同一个 Gateway"（回归用例 R6） |
| 🔴 `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` **在任何代码路径中都不参与决策** | 它们只是**行为提示**。`annotations` 是工具提供方自己写的字符串/布尔，和"请求体里自报 risk"是同一类东西 —— 都来自被约束的一方。用例 17 故意把 `send_email` 标成 `readOnlyHint: true`，它**仍然 `require_approval`** |
| 零依赖手写 stdio JSON-RPC，**不用官方 SDK** | 依赖上限（题 1/2/3 零第三方运行时依赖）；而且"不经网关就绕不过"这一点必须由**我们自己的代码**保证，用 SDK 反而看不清它到底走了哪条路 |
| 传输 = **换行分隔 JSON**（newline-delimited JSON），不是 LSP 的 `Content-Length` 头 | 这是 MCP 官方 stdio 传输的形式。README 里给了手测命令；写错成 LSP framing 的话，任何官方 Client 都连不上 |
| 把 JSON-RPC 处理抽成**纯函数** `handleMcpMessage`，stdio 循环只做搬运 | 让测试能**在进程内**覆盖 MCP 全路径，不需要派生子进程（本机沙箱对 spawn 有限制）。这是可测性设计，不是巧合 |
| `protocolVersion` 写死 `2026-07-28` | 题面参考资料里标的 MCP 版本就是这个（题面未另行规定）。且**它不参与任何决策** |
| MCP 没有 `call_id` ⇒ **按键值确定性派生** `mcp_<hash16>` | ① MCP 是同步请求-响应，没有交互通道问用户，只能用两阶段（返回"需确认"+`approval_id`，让客户端确认后**重发**）；② 重发必须复用同一个 `call_id` 才能命中旧确认 ⇒ 用 `(tool_name, arguments)` 的 hash 派生，天然满足"同参数同 id、换参数换 id"的不变量 |
| 需要确认时返回 `isError: true` + 指示文案 | MCP 的 `tools/call` 没有"待用户确认"这个状态，所以把"需确认"如实报成一次**未能完成的调用**，并把 `approval_id` 和 `call_id` 给出去，让客户端能续上 |

## 3. 可能被追问的问题

**Q：MCP 的 `tools/call` 如果不小心写成了直接调 `executor.run`（绕开 service）会怎样？**
A：那就绕过了步骤 1–4：没有工具白名单、没有参数校验、没有沙箱、没有确认。这是本项目最危险的一类回归，所以 `server/mcp/server.ts` 里 `handleToolCall` 是**唯一**的执行入口 —— 全文件搜 `executor` / `run(` 应该零命中（除了注释）。

**Q：怎么证明 annotation 真的不参与决策？**
A：用例 17 做三件事：① `tools/list` 里 `send_email.annotations.readOnlyHint === true`（用一个**故意标错**的 `lie` 覆盖）；② 经 MCP `tools/call` 调 `send_email`，断言返回"需要用户确认"；③ 断言审计里那条记录的 `decision === 'require_approval'`。也就是说，"标错"这件事**完全没影响**结果。命令行也可以现场演示：`server/mcp/server.ts --lie-annotations`。

**Q：为什么不直接接官方 MCP SDK？**
A：两个理由。① 零依赖硬约束（评审机现场 `npm install` 失败 = 演示报废）。② 更重要的：本题要证明的是"换成 MCP 也绕不过网关"。这个保证必须能在**我们自己的代码里指出具体那一行**（`handleToolCall` 调用点），而不是"大概 SDK 会调我们的 handler 吧"。

**Q：MCP 客户端确认完之后怎么续？**
A：两阶段。第一次 `tools/call` 返回 `{isError:true, text:"…请用户通过 POST /approvals/{id}/decision 确认…"}` → 用户走 HTTP 端点 `POST /approvals/{approval_id}/decision` 选择 approve/deny → 执行成功后，客户端**用同一个 `call_id`** 重发 `tools/call` → 这次命中"已获确认并执行完毕"分支，直接返回结果。

🔴 **两个必须讲清的细节**（都是审核时实测出的缺陷，已修，见 README §11）：
1. **只重发、不确认，是不会执行的。** 重发只会拿回同一条待确认记录（修复后 `approval_id` 不再变，也不会无限新建记录）。执行发生在**确认**那一刻，不在重发那一刻。
2. **MCP server 与 HTTP Gateway 是两个进程。** 记录由前者写盘、确认由后者受理，所以：① `startStdioServer` 必须**全程只用一个** `GatewayService` 实例（早先"每条消息 new 一个"的写法连同一进程内都算不上"同一个 Gateway"）；② `handleDecision` 在内存里查不到 `approval_id` 时会**重新合并一次磁盘状态**，否则跨进程确认只会回 409"未找到待确认记录"（用例 R6 锁死这条）。

**Q：为什么审计日志不能走 `console.log`？**
A：因为 MCP 用 **stdio** 传 JSON-RPC，**stdout 是协议通道**。`[audit] ...` 混进 stdout 会让任何合规 MCP Client 在解析那一行时失败（审核实测：stdout 里确实混进了审计行）。所以终端镜像走 `console.error`（stderr）—— 同样是"terminal 显示"，却不污染协议流（回归用例 R5）。
