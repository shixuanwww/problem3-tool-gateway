# 实现与 `PLAN.md` 的偏离与补充（`docs/notes-plan-conflicts.md`）

> 原则：**凡 `PLAN.md` 与题面原文冲突，以题面原文为准**（本次核对结果：**无冲突**）。
> 下面全部是 **PLAN 自身未规定 / 内部不自洽** 的地方，以及本实现据此作出的取舍。每条都写了理由。

---

## 1. 与 PLAN 的结构性差异

| # | PLAN 写的 | 实现 | 为什么 |
|---|---|---|---|
| 1.1 | §7 列 `server/tools/{read_note,delete_note,send_email,read_webpage}.ts` | 四个文件**都在**，另加一个 `server/tools/index.ts` 作为 barrel，导出 `builtinTools` 默认表 | `executor.ts` 需要一份"可被替换的默认实现表"（用例 19 的超时桩要注入替身）。barrel 是零成本的，语义不变。§0.6 已声明"目录名、函数名、接口风格可调" |
| 1.2 | §7 只把 `scripts/reset.ts` 定位成 CLI 入口 | 额外导出 `resetAll()` / `clearOutbox()` / `listOutbox()` / `INITIAL_NOTES`，CLI 行为不变 | 测试需要"用例前后重置"（§11 硬要求）。若在测试里重写一遍清目录逻辑，就会出现**两份夹具定义**，改一处漏一处 |
| 1.3 | §8 给的跑法是 `node --experimental-strip-types --test tests/*.test.ts` | 实际跑法必须加 **`--test-concurrency=1`** | `node --test` 默认**并行跑文件**，而三个测试文件共用同一份 `sandbox/` 与 `server/data/` —— 并行会让"恰好 1 个文件"这类断言互相污染。已写进 README 与 `package.json` |

## 2. PLAN 未规定、由本实现拍板的取值

| # | 空白 | 取值 | 理由 |
|---|---|---|---|
| 2.1 | `allow` 路径上工具执行失败/超时时，`decision` 是什么？（题面只说 `status` 可能是 `failed`） | `decision='allow'` + `status='failed'` + `reason` | `decision` 表达"策略判定"（策略就是允许执行），`status` 表达"执行结果"。两个维度不能混 |
| 2.2 | 命中"已批准且已执行"的调用时，返回值里的 `decision` 是什么？ | `allow` + `status='executed'` + `reason:'…不重跑'` | **功能理由**：题面规定 Client 收到 `allow` 才"展示工具执行结果"；若回 `require_approval`，Client 会去等一个永远不会来的用户操作。用例 18/14 会断言这条路径 |
| 2.3 | §4.10 说非幂等超时"转 `require_approval` 让人工确认" —— 但**没有定义人工确认之后能不能执行** | `/approvals/{id}/decision` 走 `allowAfterTimeout: true`，放行一次 | 不放开就是**死锁**：用户确认了，`executor.run` 又因为"存在 timeout 记录"把人拦住，邮件永远发不出去。人工的显式确认是唯一能越过这道闸门的钥匙。**注意 `success` 记录仍然一律不重跑，这条不放宽** |
| 2.4 | `/approvals/{id}/decision` 被拒绝时，那条审计的 `decision` 字段填什么？ | 填 `deny`（净效果 = 该调用被否定）；`action=deny` 的正常路径同样填 `deny` | §11 要求"一次请求恰好一条审计"且 `decision` 必需非空。审核口径：这条审计描述的是**该调用的最终归属** |
| 2.5 | PLAN §7 的 `server/index.ts` 端点表里 `GET /audit` 是"可选" | 实现了 | 演示与测试都要用（客户端收尾打印、`assert` 审计条数）。零成本 |
| 2.6 | `user_id` 在 HTTP 层怎么取？ | **硬写 `user_default`**，请求体里带了也忽略 | 与"Agent 不得覆盖"的口径一致 —— 但要知道这只是**占位**：真正的身份必须来自会话/令牌（README「未实现」第 1 条） |

## 3. 被 PLAN 预判到的坑（实测遇到了，如实记录）

| # | PLAN 的提醒 | 实测结果 |
|---|---|---|
| 3.1 | §5 阶段 A 第 6 条 / 用例 6：符号链接夹具**不落盘**，Windows 无权限时 skip 并显式标注 | 本机**确实无权创建文件符号链接**。已按预案退化：尝试 `fs.symlinkSync(..., 'junction')`（Windows 上不需要权限），指向 `os.tmpdir()` 下的外部目录，读 `link_out/secret.txt` —— **被 realpath 挡下**，第 3 道闸门因此得到实证。测试输出打印走的是哪条路径 |
| 3.2 | §4.3 步骤 4 ③：同 `call_id` 换参数必须 `deny`，且六个演示脚本要**各自写死唯一 `call_id`** | 照做。`client/scripts/*.json` 六个 `call_id` 互不相同（`call_001`–`call_006`）；Challenge 2 另用 `call_007`（`read_webpage`）。测试里另用 `call_900/901/120/121` 等，全部唯一 |
| 3.3 | §4.6 第 6 条：`decided === undefined` 必须放行，写成 `=== undefined` 会让场景 2 永远失败 | 实现为 `if (a.decided === 'deny')`，并在代码里写了警示注释 |
| 3.4 | §9 第 0 步：`reset.ts` 必须**重建** notes 夹具（只清不建会让场景 1 与用例 1 必红） | 照做：`INITIAL_NOTES` 每次重置都写回 |
| 3.5 | §11：审计 `detail` 禁止出现邮件正文或文件内容原文 | 有测试断言（`tests/basic.test.ts` 用例 8 读审计全文，断言不含演示邮件正文） |

## 4. 与题面的符合性结论

逐条核对过，**题面 16 条要求一条未丢**：

- Basic：目录树 / 三个工具 + JSON Schema / `ToolCall` / `GET`↔`POST` 五步 / 三种决定与响应形态 / Client 三条职责 + "不得只显示是否继续" / `POST /approvals/{id}/decision` / 三个基础场景 / 5 个日志字段
- 进阶：待确认 7 字段 / 一次性 + 并发 + 五条拒绝 / 沙箱三绕过 / 审计 7 字段
- Challenge：MCP（含 annotations 不作依据）/ `read_webpage` + 注入 + "为什么提示词不是边界"
- 提交：**测试 8 项一一覆盖**（`tests/basic.test.ts` 用例 1–8）+ **README 5 问**（README §6）+ 留 session + git 分阶段 commit + README 存在

## 5. 未做（明确不做，不是漏做）

- 多进程 / 分布式"一次性"保证（README「未实现」第 2 条，如实声明）
- `/approvals/{id}/decision` 的会话 / 令牌鉴权（README「未实现」第 1 条，如实声明）
- MCP 的 `resources` / `prompts` / 采样等其余能力（题面只要求 tools）
- 真实邮件服务、真实大模型（题面明确不要求）

## 6. 审核后修复的 4 个实质缺陷（2026-10-11）

外部审核用 4 个独立探针脚本压测并发 / 崩溃 / 协议边界，发现 4 个缺陷 —— **原有 21 个用例全绿，一条都没覆盖到**。修复详情与证据见 README §11，此处只记**与 PLAN 的偏离**：

| # | PLAN 原先的口径 | 修复后的口径 | 为什么改 |
|---|---|---|---|
| 6.1 | §4.3 步骤 4 ④「其余 ⇒ 新建 Approval」 | 新增 **③.5**：同 `call_id`+同工具+同 `argument_hash` 且**未决策未过期** ⇒ **复用**原记录 | PLAN ④ 的"其余"把"未决的重发"也归进新建。实测后果：同一逻辑调用出现并列的多条待确认记录，用户并发确认其中两条时两条都通过"未使用"检查 ⇒ **工具真的执行两次**（outbox 两封邮件）。这直接违反题面测试第 3 项 |
| 6.2 | §4.7「`used = true` 必须写在任何 `await` 之前（Node 单线程保证原子）」 | 同上，**外加"立刻 `persistState()`"** | PLAN 只说"同步置位"，没说置到哪。实现理解成了内存 ⇒ 执行期间（默认 timeout 5s）进程被杀，重启后确认带着 `used:false` 复活（实测磁盘上就是 false）。原子性必须同时覆盖内存与磁盘 |
| 6.3 | §4.10 / §2.3（本文件）「非幂等超时 ⇒ 转人工确认，用户确认后 `allowAfterTimeout` 放行一次」 | 放行**仍保留**，但新增 executor 的 `inFlight` 集合：**同键非幂等调用正在执行时，即使 `allowAfterTimeout` 也拒绝** | `allowAfterTimeout` 是"这次确认"的豁免，被实现成了"整个 run 的豁免"。于是"查记录 → 写 started → await 工具"这段窗口内，第二个请求看到的最新记录是 `started`，带着豁免就冲过去了 ⇒ 并发重复副作用。豁免必须限定在"人工对**已结束的**不确定结果重新确认"，而不是"和正在跑的那次并行" |
| 6.4 | PLAN §7/§9：`server/mcp/server.ts` 从 stdin 读、从 stdout 写 | 同上，**外加"审计终端镜像走 stderr"** | PLAN 只写了 stdout 是响应通道，没提审计也要打印。`appendAudit` 的 `console.log` 会把 `[audit] ...` 写进 stdout ⇒ 破坏 JSON-RPC 流（实测 stdout 混入审计行） |
| 6.5 | PLAN 未规定 MCP 的 `GatewayService` 生命周期 | `startStdioServer` **全程一个实例**；`handleDecision` 内存未命中时 **`reloadState()`** 再查一次 | 题面要求"MCP 请求经过**同一个** Gateway"。改前每条消息 `new GatewayService()`，且 HTTP 进程只在构造时 `loadState()` ⇒ MCP 写的确认，HTTP 端点看不见，两阶段确认回 409"未找到待确认记录"（实测） |

**新增回归用例**：`tests/advanced.test.ts` 的 **R1–R6**（27 个用例总数，`# fail 0`）。

> 修复 6.1/6.2 的作用域是**单进程**；多进程并发的**写**仍会互相覆盖，README「未实现」第 2 条已如实收窄措辞（由"单进程模型"改为"跨进程可读、但并发写不安全"）。
