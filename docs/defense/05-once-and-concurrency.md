# 模块 5：一次性与并发

**代码**：`server/gateway/service.ts` → `handleDecision`（关键是 `a.used = true` 的位置）

## 1. 这段在干什么

保证**一个确认只能成功使用一次** —— 即使两个请求在同一个 tick 里同时提交同一个 `approval_id`，也只能有一个真正执行工具。

## 2. 关键设计决策 + 为什么

```ts
// 🔴 check 与 set 之间不得出现 await
const a = approvals.get(id);
if (!a || a.used || expired(a) || a.decided === 'deny') return reject(...);
a.used = true;                  // ← 同步置位，此刻起其它请求必然看到 used = true
a.decided = 'approve';
// 此后才做异步工作
const result = await executeTool(def, a.arguments_snapshot);
```

| 决策 | 为什么 |
|---|---|
| 用**单线程同步 check-and-set**，`used = true` 写在**任何 `await` 之前** | Node 的事件循环是单线程的：`await` 之前的代码**不可能被打断**。所以第二个并发请求必然在第一个把 `used` 置位**之后**才被处理，于是在第 4 条（确认已使用）被拒。这是"可证明"而不是"碰巧" |
| 不引入锁库 / 队列 / 信号量 | 单进程 + 单线程下，锁是**多余的**，而且引入它就得解释"锁的粒度/死锁/超时"，收益为负 |
| 六条拒绝条件按固定顺序判 | 记录存在 → `action` 合法 → 未过期 → 未使用 → 同一用户 → 未被拒绝过。顺序影响**错误信息的可读性**（比如"换用户"应该报"确认者不是原用户"，而不是先报"已使用"） |
| 🔴 第 6 条必须是 `decided === 'deny'`，**不能**写成 `=== undefined` | `undefined` 是**每条新建记录的正常状态**。写成 `=== undefined` 的话，所有确认都会在第一步被判成"用户已拒绝"，**场景 2 永远不可能通过**。这是本模块最容易写错的一行 |
| **如实声明多进程不适用** | `approvals` 是进程内 `Map` + 一个 JSON 文件。起多实例时 `Map` 不共享，"一次性"保证就没了 —— README 与 PLAN 都写明要换成文件锁 / DB 唯一约束 |

## 3. 可能被追问的问题

**Q：为什么"不 await 就够了"？给我讲清楚。**
A：JS 的执行模型里，一个函数从被调用到撞上第一个 `await` 之间，**不会被其它任何代码插入执行**（没有抢占式调度）。所以"读 `used` → 判断 → 写 `used`"这三条语句构成一个**原子区间**。第二个请求的 `handleDecision` 要么整体在第一个之前跑（那它成为"第一个"），要么整体在 `a.used = true` 之后跑（那它看到 `used === true` → 被第 4 条拒绝）。两种顺序都不可能产生"两个都执行"。用例 13 用 `Promise.all` 在同一 tick 发两次，断言**恰好 1 次 `executed`**、outbox **恰好多 1 个文件**。

**Q：那如果我把 `a.used = true` 写到 `await executeTool(...)` 之后呢？**
A：两个请求都会看到 `used === false`，都会去执行 `send_email` ⇒ **发出两封邮件**。这正是"确认不能只看起来像确认"要防的场景。所以我把这段写成显式注释 + 放在 `// 此后才做异步工作` 之前。

**Q：执行失败了，`used` 还能恢复吗？**
A：不能，也**不应该**。`used = true` 表达的是"这张票已经消费掉了"，与执行成功与否无关。执行失败要让用户重新确认，就**新建**一张票（走 `POST /tool-calls` 再拿一个新的 `approval_id`）。

**Q：HTTP 层面的并发呢？两次请求可能落在两个事件循环 tick 上。**
A：`node:http` 的请求处理是回调驱动的，两个请求的回调**不可能同时运行**。所以本节论证对 HTTP 路径同样成立 —— 用例 13 走的是 service 直调，但 `server/index.ts` 只是 await 了同一个 `handleDecision`。

**Q：多进程怎么改？**
A：把 `approvals` 挪到有原子 compare-and-set 的存储里，典型写法是 `UPDATE approvals SET used = 1 WHERE approval_id = ? AND used = 0`，然后**用受影响行数**判断自己是不是那个"唯一赢家"（`affectedRows === 1`）。或者用文件锁（`fs.open` + `wx` 标志）实现单机互斥。
