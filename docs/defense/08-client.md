# 模块 8：Client 的职责边界

**代码**：`client/index.ts`、`client/display.ts`、`client/http.ts`、`client/types.ts`、`client/scripts/*.json`

## 1. 这段在干什么

扮演 **Agent 的代理**：拿 Agent 生成的 `ToolCall`（本题用固定 JSON 模拟）→ 提交给 Gateway → 按返回的决定处理并跟用户交互。

## 2. 关键设计决策 + 为什么

| 决策 | 为什么 |
|---|---|
| 🔴 Client **不判断权限、不执行工具** | 题面的核心论点就是"权限判断与执行必须在 Gateway"。Client 只要有一点权限判断，就多出一个可被绕过的权威来源 |
| 🔴 **不得只显示"是否继续"**，必须展示工具名 + **完整参数** | 题面逐字写的。理由：用户要确认的对象是"这一次具体操作"，不把参数摊开，"确认"就是盲签。实现上 `display.ts` 还会把 `path`/`to`/`subject`/`body` 映射成人话字段名（路径 / 收件人 / 标题 / 正文） |
| 确认走 `POST /approvals/{id}/decision`，`action` 传 `approve`/`deny` | 题面规定的唯一通道。**Client 不直接告诉 Gateway"执行吧"**，只是把用户的选择转达 |
| `user_id` 由 Client 注入，缺省 `user_default`；**Agent 不得覆盖** | 身份是"谁在操作"，不能由被约束的 Agent 自己声明。`server/index.ts` 里也是硬写 `user_default`，请求体里带了也忽略 |
| 🔴 确认请求还必须带**用户会话令牌** `x-approval-secret`（P1） | Agent 通道（`/tool-calls`）拿不到它，所以"Agent 自己 POST 确认"这条路被堵住。Client 从 `server/data/approval-secret` 读，或由 `--approval-secret` 传入；没有令牌就**拒绝发确认**，绝不降级 |
| 🔴 **必须先解析响应体、再看状态码** | `deny` 走 400、确认类冲突走 409，但响应体是完整的 `ToolCallResponse`。写成 `if (!res.ok) throw` 会把 `reason` 全丢掉 —— 场景 3 就演示不出"为什么被拒" |
| `client/types.ts` 复制一份**最小子集**契约，而不是跨目录 import 服务端类型 | Client 是概念上独立的进程（可能换成别的语言/运行时）。真跨目录 import 会让"独立"变成假象。文件头注明了来源 |
| 交互与否自动判定（`stdin` 不是 TTY ⇒ 演示模式自动选） | 评审机/CI 里没有 TTY，真去 `readline` 会永久挂住。演示模式会**打印一行说明**"以用户身份自动选择确认/拒绝 —— 真实系统里这一步必须是人的点击"，不假装是真实交互 |
| 场景 2 在确认**前后各打印一次** `outbox/` 列表 | 题面要求"确认前不产生副作用"，**只有打印对比才能证明**它 |
| 场景 3 在拒绝后打印 `config.json` 指纹 | 题面要求"沙箱外的文件不受影响"，同理 —— 打印**前后指纹一致**才算证明，光说"拒绝了"不算 |

## 3. 可能被追问的问题

**Q：Client 能做权限判断吗？比如它自己发现路径越界就不提交？**
A：技术上能写，但**不应该**。① 那是客户端判权限，等于把权威复制了一份，两边逻辑不同步就是漏洞；② 提交给对方拒绝，本身是有信息量的正确行为 —— 场景 3 要演示的正是"越界请求被 Gateway 拒绝"，Client 提前拦下反而演示不出来。

**Q：`--scenario all` 会自动确认，这不是伪造用户同意吗？**
A：演示脚本里会自动选，但**显式打印了"演示模式"**，并且真实交互路径（TTY）是走 `readline` 真问用户的。这属于"为了跑通演示而做的降级"，不是把假的东西说成真的。

**Q：那 Agent 自己直接 POST `/approvals/{id}/decision` 呢？**
A：**会被 401 挡下**（P1 之后）。该端点除了 `user_id` 还必须有 Gateway 生成的**用户会话令牌**（`x-approval-secret`），令牌只落在 `server/data/approval-secret`、只打印在服务端终端，并且**不出现在任何 `/tool-calls` 响应里** —— Agent 提调用时根本拿不到它。回归用例 R7：无令牌 / 错令牌都回 `401` 且 `outbox/` 无副作用。
**残余边界**：这是"本机 control token"，能读到该文件的本机进程仍可冒充用户；`user_id` 仍是写死的 `user_default`。生产环境应由 OS 会话 / OAuth 令牌推导身份（README「未实现」第 1 条）。

**Q：为什么 Client 用 `fetch` 而不用第三方 HTTP 库？**
A：Node 22 内置 `fetch`，零依赖。

**Q：固定 JSON 算"接真实 Agent"吗？**
A：题面原文明确允许："基础部分不要求接入真实大模型，**可以使用固定 JSON 模拟 Agent 输出**"。`client/scripts/*.json` 就是 Agent 输出的替身，每个文件的 `call_id` 写死且唯一 —— 这也很重要，因为 `call_id` 与 `(tool_name, arguments)` 是一一绑定的（见模块 3）。
