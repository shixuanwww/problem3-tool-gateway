# 模块 1：可信工具表 + 最小 JSON Schema 校验器

**代码**：`server/gateway/registry.ts`、`server/gateway/validate.ts`

## 1. 这段在干什么

`registry.ts` 是**服务端唯一事实来源**的工具表（4 个工具 + 各自的风险与幂等性标记）；
`validate.ts` 是一个**自己写的** JSON Schema 最小子集校验器，用来在步骤 2 校验参数。

## 2. 关键设计决策 + 为什么

| 决策 | 为什么 |
|---|---|
| 工具表和策略**只存在于 Server 进程内**，请求体里的 `risk` / `requiresApproval` / `inputSchema` 一律忽略 | 策略是**信任边界的定义，不能由被约束的一方提供**。Agent 若能声明"我这个工具是安全的"，策略等于不存在（用例 16 验证） |
| `requiresApproval` 显式写出来，而不是运行时由 `risk` 推导 | `risk` 是"语义标签"，`requiresApproval` 是"执行闸门"。分开写：① 便于审计与演示 ② `delete_note` 的 `risk` 是 `destructive`，但题面把它当**用户确认**的例子，所以两者本来就不是一对一 |
| `idempotency` 单独一个字段 | README 第 5 问的**唯一**判据来源。`send_email` 标 `non_idempotent` ⇒ 超时不自动重试 |
| 自己写校验器而不用 AJV | 本题**零第三方依赖**（评审机现场 `npm install` 失败 = 演示报废）；且"参数校验"是核心考点，必须每一行都能讲清 |
| 🔴 **遇到不支持的 schema 关键字必须显式报错** | 静默忽略 = 给自己开洞：写错一个 `minLenght`，校验就形同虚设，而没人会知道 |
| `additionalProperties` 缺省视为 `true`（与标准一致），但**必须支持显式 `false`** | 题面给的 `delete_note` 示例就用了 `additionalProperties: false`；缺省 `true` 是 JSON Schema 的标准行为，乱改会让别人的 schema 意外拒绝 |
| 错误信息带**具体路径**（`arguments.to: expected string`） | 这是给人看的排错信息，不是给机器看的错误码 |

## 3. 可能被追问的问题

**Q：如果 Agent 在请求体里塞 `{risk:'read_only', requiresApproval:false}` 呢？**
A：完全无效。服务端只在 `registry.ts` 里查工具定义，请求体里那些字段**根本不参与读取**；而且审计里会留一条 `detail:"ignored client-supplied policy: risk, requiresApproval"`。用例 16 就是拿 `send_email` 这么打，结果仍然是 `require_approval`。

**Q：你怎么保证校验器真的覆盖了所有声明的关键字？**
A：反向枚举 —— 维护一个 `SUPPORTED_KEYWORDS` 白名单，**schema 里出现白名单外的键就报错**。也就是说，如果我将来给 schema 加了一个新关键字却忘了实现校验，测试会立刻红，而不是静默放过。

**Q：`arguments` 不是对象（比如传了个数组或字符串）会怎样？**
A：在 `server/index.ts` 里非对象会被归一化成 `{}`，然后步骤 2 因为缺 `required` 字段而 `deny`。也就是说**最坏结果是拒绝，不是崩溃**。

**Q：为什么不校验 `arguments` 的类型就直接进 schema 校验？**
A：`validateSchema` 的第一步就是 `type` 匹配，schema 声明 `type:'object'` 时会先判 `isPlainObject`（排除 `null` 和数组），类型不对立刻返回 `expected object, got array`。

**Q：`read_webpage` 为什么也在 registry 里？题面只要三个工具。**
A：题面 Challenge 2 明确要求"增加一个 `read_webpage` 工具"。它和三个基础工具走**完全一样**的流程（同一次 `handleToolCall`、同一张表），没有特殊通道。

**Q：为什么把 `send_email.to` 用 `pattern` 正则校验？**
A：题面要求"非法参数被拒绝"。缺字段会被 `required` 拦住，但 `to: "abc"` 这种**有值但不像邮箱**的情况需要 `pattern` 才拦得住。注意 schema 里的 pattern 是写在 JSON 里的，校验器用 `new RegExp(pattern)` 编译 —— 顺手还处理了"pattern 本身是非法正则"的情况。
