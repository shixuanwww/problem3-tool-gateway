# 模块 4：确认的精确绑定（`argument_hash` + 快照）

**代码**：`server/gateway/canonical.ts`、`service.ts`（待确认记录的创建与复用）

## 1. 这段在干什么

把"用户同意了什么"精确固化成 `argument_hash`（规范化后完整参数的 sha256）与 `arguments_snapshot`，使得：**改一个字节的参数，旧的确认就作废**。

## 2. 关键设计决策 + 为什么

| 决策 | 为什么 |
|---|---|
| 绑 `argument_hash` 而不是只绑工具名 | 用户点"同意"时，同意的是"**把这份邮件发给 mentor@example.com**"，不是"允许调用 `send_email`"。只绑工具名 ⇒ 确认退化成绕过权限的万能钥匙（confused deputy） |
| 🔴 **对象键必须递归排序**再序列化 | 否则 `{a:1,b:2}` 与 `{b:2,a:1}` 是两个 hash ⇒ Agent 只要换个键序就能绕过绑定 |
| 参与 hash 的字段 = `arguments` 的**全部键，不做任何剔除** | 剔除空串/时间戳这类字段看似"更稳"，实际是把可控的边界变成不可控：到底剔哪些？谁定？⇒ 一律不剔，**要求逐字节重发**。代价是演示脚本里禁止出现 `Date.now()` / 随机 ID |
| `send_email` 的 `message_id` 由 **Gateway 生成、不进 `arguments`** | 它是一次执行的产物，不是调用参数。放进 `arguments` 会让同一份"用户意图"每次算出不同 hash |
| 额外存一份 `arguments_snapshot` 并在确认后**按快照执行** | 防 TOCTOU：从"建记录"到"用户点确认"之间，请求参数已经不可信了（可能被改，也可能只是又发了一次）。执行必须以**当时落库的那份**为准 |
| 复用确认时**同时**校验 `tool_name` 与 `argument_hash`，不一致直接 `deny` | 题面明写"工具或参数发生变化 → 拒绝"。注意这里是 `deny` 而不是"新建一条待确认" —— **拒绝**才算如实反映"有人在试图复用一张已经对不上的票" |
| `status` 与 `decision` 分开表达 | 同模块 3 |

## 3. 可能被追问的问题

**Q：`canonicalize` 到底做了什么？**
A：递归序列化：对象 → 按键的**码点升序**排好再拼紧凑 JSON（无空格）；数组保序；字符串用 `JSON.stringify` 转义（保证可逆）；数字 `String(n)`；`null`/`undefined` 统一成 `null`。然后 `sha256:` + hex。用例 10 断言 `{a:1,b:2}` 与 `{b:2,a:1}` 同 hash、嵌套对象也递归排、而数组保序（`[1,2]` 与 `[2,1]` 必须不同）。

**Q：为什么不直接用 `JSON.stringify(arguments)`？**
A：因为它**保留插入顺序**。`JSON.parse` 出来的对象键序取决于原始文本里键出现的顺序，也就是说 **hash 会取决于请求的字节排列而不是语义** —— 攻击者可以靠重排键来制造不同的 hash（或反过来，让两个语义不同的请求撞成同一个 hash 的错觉）。

**Q：TOCTOU 具体怎么被挡住？**
A：两处。① 待确认记录里存了 `arguments_snapshot`，`handleDecision` 执行时**只读快照**，完全不看决策请求体；② `argument_hash` 只用于"这条确认是否对得上这次调用"的比对。用例 11 就是走 HTTP 在决策请求体里塞一份**不同的** `arguments:{path:'report.txt'}`，断言被删的仍然是快照里的 `draft.txt`、而 `report.txt` 安然无恙。

**Q：那 `expires_at` 是干什么的？是防重放吗？**
A：防的是"确认被搁置很久之后突然被用"。默认 300 秒（`APPROVAL_TTL_MS`）。过期的确认在 `handleDecision` 第 3 条被拒（409 确认已过期）。用例 7 通过**注入可控时钟**（`new GatewayService({now})`）把时间往前拨 301 秒来验证 —— 不用真等 5 分钟。

**Q：`used` 和 `decided` 有什么区别？**
A：`decided` 是"用户做过什么决定"（`approve` / `deny` / `undefined`=还没决定）；`used` 是"这张票是否已经被消费掉"。拒绝一条确认会把 `decided` 置 `deny` 但**不动** `used`；批准则两者都动。
