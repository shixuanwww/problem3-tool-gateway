# 模块 5：一次性与并发

**代码**：`server/gateway/service.ts` → `claimDecision`（关键是 `a.used = true` 与它所在的文件锁临界区）、`server/gateway/persist.ts`

## 1. 这段在干什么

保证**一个确认只能成功使用一次** —— 即使两个请求在同一个 tick 里同时提交同一个 `approval_id`，也只能有一个真正执行工具。

## 2. 关键设计决策 + 为什么

```ts
// 🔴 整个"查记录 → 判六条 → 置 used"放在 withStateLock() 的同步临界区里
claimDecision(id, action, user) {
  return withStateLock(() => {                  // 同机多进程也只有一个赢家
    this.mergeFromDiskLocked();                 // 先合并磁盘最新状态
    const a = this.approvals.get(id);
    if (!a || a.used || expired(a) || a.decided === 'deny') return reject(...);
    a.used = true;                              // 同步置位 + 同步落盘
    a.decided = 'approve';
    this.persistStateLocked();
    return claim;
  });
}
// 锁外才做异步工作（工具执行不阻塞其它确认）
const result = await executeTool(def, a.arguments_snapshot);
```

| 决策 | 为什么 |
|---|---|
| 用**单线程同步 check-and-set**，`used = true` 写在**任何 `await` 之前** | Node 的事件循环是单线程的：`await` 之前的代码**不可能被打断**。所以同进程内第二个并发请求必然在第一个把 `used` 置位**之后**才被处理，于是在第 4 条（确认已使用）被拒。这是"可证明"而不是"碰巧" |
| 🔴 临界区外面再套一层**跨进程文件锁**（`persist.ts`，`open('wx')` + 超时 + 僵尸锁抢占） | 单进程的论证在 **HTTP 进程 + MCP stdio 进程**并存时不成立：两个进程各有自己的 `Map`，都能通过"未使用"检查。锁把"读磁盘 → 判 → 置位 → 落盘"变成一个跨进程临界区；**实测**两个真实进程同时确认同一个 `approval_id`：一个 `executed`、一个 `409 确认已使用`，outbox 恰好 1 封邮件 |
| 锁只包住**同步文件 I/O**，不包住工具执行 | 执行最长 5s（timeout）。若把执行也放进锁，一个慢调用会把所有确认卡死；而"一次性"只需要保证**认领**那一步原子 |
| 六条拒绝条件按固定顺序判 | 记录存在 → `action` 合法 → 未过期 → 未使用 → 同一用户 → 未被拒绝过。顺序影响**错误信息的可读性**（比如"换用户"应该报"确认者不是原用户"，而不是先报"已使用"） |
| 🔴 第 6 条必须是 `decided === 'deny'`，**不能**写成 `=== undefined` | `undefined` 是**每条新建记录的正常状态**。写成 `=== undefined` 的话，所有确认都会在第一步被判成"用户已拒绝"，**场景 2 永远不可能通过**。这是本模块最容易写错的一行 |
| **如实声明边界：同机安全，跨机不安全** | 文件锁只对**同一台机器**上的多进程有效。跨机器 / 多副本时文件锁没有意义，必须换成数据库的唯一约束（`UPDATE ... WHERE used = 0`）或分布式锁 —— README 已如实收窄措辞 |

## 3. 可能被追问的问题

**Q：为什么"不 await 就够了"？给我讲清楚。**
A：JS 的执行模型里，一个函数从被调用到撞上第一个 `await` 之间，**不会被其它任何代码插入执行**（没有抢占式调度）。所以"读 `used` → 判断 → 写 `used`"这三条语句构成一个**原子区间**。第二个请求的 `handleDecision` 要么整体在第一个之前跑（那它成为"第一个"），要么整体在 `a.used = true` 之后跑（那它看到 `used === true` → 被第 4 条拒绝）。两种顺序都不可能产生"两个都执行"。用例 13 用 `Promise.all` 在同一 tick 发两次，断言**恰好 1 次 `executed`**、outbox **恰好多 1 个文件**。

**Q：那如果我把 `a.used = true` 写到 `await executeTool(...)` 之后呢？**
A：两个请求都会看到 `used === false`，都会去执行 `send_email` ⇒ **发出两封邮件**。这正是"确认不能只看起来像确认"要防的场景。所以我把这段写成显式注释 + 放在 `// 此后才做异步工作` 之前。

**Q：执行失败了，`used` 还能恢复吗？**
A：不能，也**不应该**。`used = true` 表达的是"这张票已经消费掉了"，与执行成功与否无关。执行失败要让用户重新确认，就**新建**一张票（走 `POST /tool-calls` 再拿一个新的 `approval_id`）。

**Q：HTTP 层面的并发呢？两次请求可能落在两个事件循环 tick 上。**
A：`node:http` 的请求处理是回调驱动的，两个请求的回调**不可能同时运行**。所以本节论证对 HTTP 路径同样成立 —— 用例 13 走的是 service 直调，但 `server/index.ts` 只是 await 了同一个 `handleDecision`。

**Q：跨进程/跨机器怎么改？**
A：同机多进程已经用文件锁（`fs.open` + `wx`）+ **单调合并**（`used` 取或、`decided` 磁盘优先、`seq` 取最大）修好了；跨机器就必须要原子 compare-and-set 的存储，典型写法是 `UPDATE approvals SET used = 1 WHERE approval_id = ? AND used = 0`，然后**用受影响行数**判断自己是不是那个"唯一赢家"（`affectedRows === 1`）。

**Q：文件锁崩溃了会永久死锁吗？**
A：不会。锁文件带 mtime，超过 15s 未被释放即视为僵尸锁并被抢占；等待方最多等 5s 就抛错，不会无限挂起。`scripts/reset.ts` 也会清掉残留的 `*.lock`。
