# 先别执行！—— Agent 工具调用安全网关

**一句话定位**：一个把「Agent 想做什么」与「用户授权了什么」彻底分开的网关 —— **Agent 只负责提出调用，真正的权限判断和工具执行必须由 Gateway 完成。**

题面原话（本题核心论点）：*Agent 只负责提出调用，真正的权限判断和工具执行必须由 Gateway 完成。*

---

## 0. 第 0 步（每次演示/测试前必做）

```bash
node --experimental-strip-types scripts/reset.ts
```

**为什么必做**：`server/data/approvals.json` 与 `executions.jsonl` 是**落盘**的，且 Gateway 规定"命中已批准且已执行的同一调用 → 直接返回已存结果、**不重跑**"。不重置就跑第二遍时，**场景 2 不会再进入"等待确认"，`sandbox/outbox/` 也不会新增文件** —— 而题面明确要求演示"确认前无邮件、确认后才出现邮件文件"的对比。

`scripts/reset.ts` 是**唯一**重置入口，它做三件事（**不触碰**仓库根 `config.json`）：

| 位置 | 动作 |
|---|---|
| `server/data/*.json` / `*.jsonl` / `*.tmp` / `*.corrupt-*` | 清空（approvals / audit / executions） |
| `sandbox/outbox/*.json` | 清空（保留 `.gitkeep`） |
| `sandbox/notes/*` | **恢复初始夹具**：`todo.md`（内容 `buy milk`）、`draft.txt`；保留 `.gitkeep`。这两个夹具**已入库**（题面目录树要求它们出现在交付物里，见 §10） |

> ⚠️ 只清不建会让场景 1 与用例 1 在重置后必红，所以夹具是**重建**不是清空。

## 1. 启动

```bash
# 运行环境自检（本实现要求 Node ≥ 22.6；本机实测 v22.14.0 / v22.22.2 均可）
node --version          # 必须 ≥ v22.6.0
# 下文所有命令都必须带 --experimental-strip-types（只做类型擦除，不做任何语法转换）

# 终端 1：起 Gateway（默认 :8787，可用 --port 覆盖）
node --experimental-strip-types server/index.ts

# 终端 2：跑 Client（题面要求的三个基础场景）
node --experimental-strip-types client/index.ts --scenario all
```

等价 npm 脚本：`npm run reset` / `npm run server` / `npm run client` / `npm run test`。

**其他入口**

```bash
node --experimental-strip-types client/index.ts --scenario 1          # 只跑场景 1
node --experimental-strip-types client/index.ts --scenario 3          # 越界删除
node --experimental-strip-types client/index.ts --scenario injection  # Challenge 2：提示词注入
node --experimental-strip-types client/index.ts --scenario 1 --url http://127.0.0.1:9001
node --experimental-strip-types server/mcp/server.ts                  # MCP（stdio）
node --experimental-strip-types --test --test-concurrency=1 tests/basic.test.ts tests/advanced.test.ts tests/challenge.test.ts
```

> 🔴 **测试必须带 `--test-concurrency=1`**：三个测试文件共用同一份 `sandbox/` 与 `server/data/`，`node --test` 默认**并行跑文件**会让"恰好 1 个文件"这类断言互相污染。文件内用例是顺序执行的。
>
> 🔴 **零第三方依赖**：没有 `npm install` 这一步，评审机上"一条命令就能跑"。`package.json` 里没有任何 `dependencies`。

## 2. 架构

```
        ┌──────────────────────────────────────────────┐
        │  client/  —— Agent 的代理（不判权限、不执行）  │
        │   获取 ToolCall（固定 JSON 模拟）              │
        │   提交 → 按决定处理 → 需要时展示完整参数并等用户 │
        └───────────────────┬──────────────────────────┘
                            │ HTTP（node:http，仅 2 个必需端点）
        ┌───────────────────▼──────────────────────────┐
        │  server/  —— Gateway（唯一的权限与执行权威）   │
        │   gateway/registry.ts   可信工具表 + 风险策略  │
        │   gateway/validate.ts   最小 JSON Schema 校验  │
        │   gateway/sandbox.ts    三道闸门               │
        │   gateway/service.ts    五步决策 / 确认 / 一次性│
        │   gateway/executor.ts   执行 + 超时 + 幂等判定  │
        │   gateway/audit.ts      审计（JSONL）          │
        │   mcp/server.ts         手写 stdio JSON-RPC    │
        └───────────────────┬──────────────────────────┘
                            │ 只能经此读写
        ┌───────────────────▼──────────────────────────┐
        │  sandbox/  只允许在指定范围内操作              │
        │   notes/{todo.md, draft.txt}   outbox/   web/  │
        └──────────────────────────────────────────────┘
               仓库根 config.json  ← 沙箱**外**（场景 3 的证物）
```

**职责边界（一句话）**：Client 是 Agent 的代理，只做"提交 + 跟用户交互"；Gateway 持有**可信**的工具定义与风险策略，是**唯一**能做权限判断和工具执行的组件。

## 3. 五步校验流程与决策优先级

`POST /tool-calls` 严格按序执行五步（题面给定的顺序，不可乱）：

| 步 | 动作 | 不过时的结果 |
|---|---|---|
| 1 | 根据 `tool_name` 查找**可信**工具定义 | `deny` 未知工具（HTTP 400） |
| 2 | 用工具的 `inputSchema` 校验参数 | `deny` 参数非法（HTTP 400） |
| 3 | 检查参数是否超出工具允许的资源范围（`allowedRoot`） | `deny` 目标路径超出 sandbox/xxx（HTTP 400） |
| 4 | 根据**服务端策略**作出决定 | `allow` 执行 / `require_approval` 建待确认记录 / `deny` 沿用旧结论（409） |
| 5 | 记录本次决定（**无论哪个分支都写一条审计**） | — |

🔴 **决策优先级（不可调换）**：**未知工具 → 参数非法 → 越界 → 需确认 → 执行**

理由：题面场景 3 要求 `delete_note(path="../../config.json")` 必须是 `deny`，**不能被"销毁性操作需要确认"掩盖**。所以步骤 1–3 的 `deny` **永远优先**于步骤 4 的 `require_approval`。`delete_note` 在 registry 里标了 `requiresApproval: true`（因为题面把 `delete_note(path="draft.txt")` 当作**用户确认**的例子），于是"合法路径走确认、越界路径先被拒"这两件事同时成立。

三种决定：

| 决定 | 何时 | 行为 |
|---|---|---|
| `allow` | 参数合法且工具允许自动执行 | 直接执行并返回结果 |
| `require_approval` | 操作存在外部副作用 | 生成待确认记录，**但绝不提前执行工具** |
| `deny` | 工具不存在 / 参数非法 / 目标越界 / 旧结论冲突 | 直接拒绝，带可读原因 |

## 4. 沙箱：三道闸门（缺一不可）

`read_note` / `delete_note` 只能访问 `sandbox/notes/`，`read_webpage` 只能访问 `sandbox/web/`。题面点名三种绕过方式，对应三道闸门：

1. **拒绝绝对路径** —— `path.isAbsolute` + Windows 盘符 `^[A-Za-z]:` + UNC `\\server\share` + 前导 `/` `\`
2. **拒绝任何含 `..` 的段** —— 在归一化**之前**按 `/` 与 `\` 切段判 `=== '..'`，所以 `a/../../b` 也拦得住（只看开头是不够的）
3. **归一化 + realpath + 前缀比对** —— 字符串前缀先挡一遍，再做 `fs.realpathSync`
   - 🔴 **为什么第 3 步不能省**：`sandbox/notes/link` 是指向 `../../config.json` 的**符号链接**时，前两道闸门**全过**（路径里没有 `..`，也不是绝对路径），只有 realpath 能挡。

**`REPO_ROOT` 的定义（全项目唯一）**：

```ts
// server/gateway/sandbox.ts 模块顶部
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// server/gateway/ + '../..' ⇒ 仓库根（写成 '../../..' 会得到仓库的父目录）
```

🔴 **禁止 `process.cwd()`**：从仓库根启动、从任意目录启动、被别的程序 import，都必须得到**同一个**仓库根，否则第 3 步的前缀比对直接失效。

## 5. 审计字段

`server/data/audit.jsonl`，一请求一行（JSONL），同时把同一行镜像到**终端（stderr）**。

> 🔴 **终端镜像必须走 stderr**，不能走 `console.log`（stdout）：`server/mcp/server.ts` 用 **stdio** 跑 JSON-RPC，**stdout 是协议通道** —— 混进一行 `[audit] ...` 就会把一个合规的 MCP Client 的解析弄坏（这是审核时实测到的缺陷，已修 + 回归用例 R5 锁死）。stderr 同样是"terminal 显示"，却不污染协议流。

**7 个必需字段**（题面「至少包含」）：`ts` / `user_id` / `call_id` / `tool_name` / `decision` / `approval_result` / `execution_result`

补充字段：`approval_id?` / `argument_hash?` / `detail?`

- `approval_result` ∈ `approved | denied | not_required | n/a`
- `execution_result` ∈ `success | error | skipped | timeout`
- **条数口径**：一次 HTTP 请求**恰好一条**；`POST /approvals/{id}/decision` 是独立请求、**另写一条**；超时**不新增条目**（那条自带的 `execution_result` 就是 `timeout`）
- 🔴 `detail` 里**禁止**出现邮件正文或文件内容原文（有测试断言）

## 6. README 必答的五个问题

**Q1. Client 和 Gateway Server 分别负责什么？**
Client 是**Agent 的代理**：获取 Agent 生成的 `ToolCall`、提交给 Gateway、根据返回的决定做后续交互，并在需要确认时**如实展示工具名与完整参数**、等用户选择。它**不判断权限、不执行工具**。Gateway 是**唯一的权限与执行权威**：持有可信的工具定义与风险策略，按"查工具 → 校验参数 → 检查资源范围 → 按服务端策略决定 → 记录"五步作出 `allow / require_approval / deny`，并**只有它**能真正执行工具。

**Q2. 为什么 Agent 输出不能被视为用户授权？**
因为 **Agent 的输出是"模型的一次生成结果"，不是"用户的意愿表达"**。模型可能理解错意图（把"整理文件"理解成"删除文件"），也可能被**间接提示词注入**污染 —— 网页、邮件或工具返回值里的一句话就能诱导它外发数据。用户从未对这个具体动作表示过同意。所以"模型想做什么"与"用户是否授权做"是**两个独立事实**，必须由 Gateway 在**服务端**用可信策略判定，并让**用户**对高风险动作显式确认。
一句话：**prompts are not security boundaries** —— 系统提示词里的"不要泄露数据"是模型级的建议，攻击者完全可以用一段网页内容覆盖它（本仓库 `sandbox/web/promo.html` 就是这段载荷）；只有**服务端的权限检查 + 用户确认**才是真边界。

**Q3. 为什么确认必须绑定具体参数，而不能只绑定工具名称？**
因为确认的对象**从来不是"工具"，而是"这一次具体操作"**。用户点"同意"时，他同意的是"把这份邮件发给 mentor@example.com"，而**不是**"允许调用 send_email"。如果只绑工具名，Agent 在拿到确认后可以把参数换成 `attacker@example.com` 或 `delete_note(path="report.txt")`，**确认就退化成了绕过权限的一把万能钥匙**（confused deputy）。所以待确认记录保存 `argument_hash`（规范化后完整参数的摘要），确认执行时**按快照参数原样执行**，并在复用确认时**同时校验 `tool_name` 与 `argument_hash`**（一致则返回已存结果、不一致则直接 `deny：工具或参数发生变化`）。

**Q4. 为什么工具的风险策略必须保存在 Gateway，而不能由 Agent 提交？**
因为**策略是信任边界的定义，不能由被约束的一方提供**。Agent 是**被约束对象**（它可能被注入、可能出错），如果它能提交或修改"我这个工具是不是危险"的声明，那它总能声明自己是安全的，策略等于不存在。策略必须保存在**服务端、不受请求影响的配置**里：请求体里若出现 `risk` / `requiresApproval` / `inputSchema` 等字段，**一律忽略**（用例 16 专门验证），并在审计里记一条 `detail:"ignored client-supplied policy"`。
同一个道理适用于 MCP 的 `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`：**它们只是"行为提示"，不构成权限依据** —— 演示时刻意把 `send_email` 标成 `readOnlyHint: true`，它**依然要求确认**（用例 17 / `server/mcp/server.ts --lie-annotations`）。

**Q5. 如果一次工具执行超时，系统如何判断它能否安全重试？**
判据是**幂等性 + 是否已产生副作用**，两者都要看：
1. **先查执行记录**：执行前写"意图记录"（`call_id` + `tool_name` + `argument_hash` + `started`），成功后追加 `success`。若已有**同 `call_id` + 同 `argument_hash` 的 success 记录**，说明副作用**已经发生** ⇒ **不重试**，直接返回已存结果（最重要的一条：避免重复副作用）。
2. **若没有 success 记录**，再看工具的幂等性：
   - **幂等**（`read_note` 只读；`delete_note` 目标状态一致、重复删等价 —— executor 把 `ENOENT` 视为成功）⇒ 可以安全重试。
   - **非幂等**（`send_email`：重试会产生第二封邮件）⇒ **不自动重试**，必须**转人工确认**（新建待确认记录；用户显式确认后才允许越过这道闸门一次，否则"转人工确认"会变成死锁）。
3. 关键前提：**超时本身不能说明"有没有执行"** —— 超时可能是"没跑"，也可能是"跑完了但响应丢了"。所以在没有可查询的执行记录时，**默认按"可能已执行"处理**，这才是保守而正确的选择。

> ⚠️ 诚实边界：本实现的重试判据依赖**进程内的执行记录**；跨进程 / 跨机时，应落到数据库的唯一约束或外部系统的幂等键（如邮件服务的 `Idempotency-Key`）。

## 7. 已实现 / 未实现

### ✅ 已实现

- **Basic**：Client + Gateway Server、三个工具（`send_email` / `read_note` / `delete_note`）、JSON Schema 参数校验、五步流程、三种决定、确认展示（工具名 + 完整参数）、题面三个基础场景
- **进阶**：确认精确绑定 `argument_hash`（规范化 JSON → sha256）、一次性 + 并发安全、六条拒绝条件、沙箱三道闸门、7 字段审计、落盘 + 重启恢复（原子写 + 损坏改名保留）
- **重复副作用的三道防线**（2026-10-11 审核后补强，见 §11）：① 同一调用**重发复用**同一条待确认记录（不再产生并列的多条）；② `used` 在 `await` **之前同步落盘**（进程被杀也不复活）；③ executor 维护"正在执行中"集合，**同键的非幂等调用并发执行一律拒绝**（用户已确认也拒 —— Gateway 说了算）
- **Challenge**：MCP（手写 stdio JSON-RPC 2.0，**整个 stdio 会话共用一个 `GatewayService` 实例**）、`read_webpage` + 间接提示词注入演示、超时安全重试判定
- **测试**：27 个用例，覆盖题面要求的 8 项 + 我们自加的 13 项（含 HTTP 端到端、并发、重启恢复、MCP、注入、超时、以及 R1–R6 六条回归）

### ❌ 未实现（如实声明）

1. 🔴 **`POST /approvals/{approval_id}/decision` 没有会话 / 令牌鉴权**。身份只按**请求体里的 `user_id`** 校验（六条拒绝条件里的第 5 条）。题面要求"该请求只能由 Client 根据用户的实际操作发起"，但本实现**无法从协议上阻止** Agent 自行 POST `{action:"approve", user_id:"user_default"}` 来伪造用户确认。真实系统必须由**会话或令牌**确定身份（`user_id` 从凭证推导，而不是请求体自报）。**这是已知的诚实边界，不假装已解决。**
2. 🟠 **多进程仍不是"分布式安全"**：`approvals` 是进程内的 `Map` + 一个 JSON 文件。已修的部分：`handleDecision` 在内存里查不到记录时会**重新合并一次磁盘状态**，所以"MCP 进程写下的确认、HTTP 进程来确认"这条跨进程链路能跑通（用例 R6）；`seq` 取两边的最大值。**未修的部分**：并发的**写**仍会互相覆盖（last-writer-wins），真要上多实例必须换**文件锁 / 数据库唯一约束**（如 `UPDATE ... WHERE used = 0` 的原子 SQL）。本实现**不宣称**自己是分布式安全的。
3. **重试判据只依赖进程内执行记录**（同 Q5 的诚实边界）。
4. **`send_email` 不连真实邮件服务**（题面明确允许）：只写 `sandbox/outbox/<message_id>.json`。
5. **不接真实大模型**（题面 Basic 明确允许"使用固定 JSON 模拟 Agent 输出"）：Client 读 `client/scripts/*.json`。
6. **无鉴权 / 无 TLS / 无多用户隔离**：仅绑定本机，`user_default` 是唯一的真实用户。
7. **MCP 只实现 `initialize` / `tools/list` / `tools/call`**，未实现 `resources` / `prompts` / 采样等其余能力。

## 8. 演示步骤

```bash
# 第 0 步（必做）
node --experimental-strip-types scripts/reset.ts

# 终端 1
node --experimental-strip-types server/index.ts

# 终端 2 —— 题面要求的三个基础场景
node --experimental-strip-types client/index.ts --scenario all
```

会依次打印：

1. **场景 1** `read_note(path="todo.md")` → `decision=allow` + 文件内容（`buy milk`）
2. **场景 2** `send_email(...)` → `require_approval` + **完整确认展示块**（工具 / 收件人 / 标题 / 正文）
   → **先打印 `outbox/` 现有文件列表（此时为空）** → 确认 → **再打印 `outbox/` 列表（此时出现 `mail_001.json`）**
3. **场景 3** `delete_note(path="../../config.json")` → `deny` + 原因"目标路径超出 sandbox/notes"
   → **再打印沙箱外 `config.json` 的指纹：前后一致 ⇒ 内容字节未变**
4. **收尾**：打印审计尾部（含题面要求的 5 个字段）

Challenge 2 的注入链路：

```bash
node --experimental-strip-types client/index.ts --scenario injection
```

MCP 手测（**stdio + 换行分隔 JSON**，不是 `Content-Length` 头）。
⚠️ stdout 只会出现 JSON-RPC，审计日志走 stderr —— 若把 stderr 也混进解析流，会误判为"协议脏了"。

```bash
# bash / Git Bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
              '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_note","arguments":{"path":"todo.md"}}}' \
| node --experimental-strip-types server/mcp/server.ts
```

```powershell
# Windows PowerShell（无 printf）
@(
  '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_note","arguments":{"path":"todo.md"}}}'
) | node --experimental-strip-types server/mcp/server.ts
```

完整的两阶段确认链路（`tools/call` → 需确认 → 用户确认 → 同一 `call_id` 重发取回结果）见
`server/mcp/server.ts` 的 `require_approval` 分支说明与 `docs/defense/09-mcp.md`。

## 9. 目录

```
problem3-tool-gateway/
├── README.md                ← 本文件
├── PLAN.md                  ← 实施计划书（规格，含默认值账本 §11）
├── docs/
│   ├── problem-statement.md ← 题面逐字原文
│   ├── notes-plan-conflicts.md
│   └── defense/             ← 🔴 每个模块的《答辩问答》
├── scripts/reset.ts         ← 唯一的重置入口
├── client/{index,display,http,types}.ts + scripts/*.json
├── server/
│   ├── index.ts             ← HTTP 入口
│   ├── gateway/{types,registry,validate,canonical,sandbox,service,executor,audit}.ts
│   ├── tools/{read_note,delete_note,send_email,read_webpage,index}.ts
│   ├── mcp/server.ts
│   └── data/                ← 运行时产物（gitignore）
├── sandbox/{notes,outbox,web}/
├── config.json              ← 沙箱**外**的证物
└── tests/{helpers,basic,advanced,challenge}.test.ts
```

## 10. 提交前清单（题面第 1 页的通用要求）

- **git 分阶段 commit**：按阶段（Basic → 进阶 → Challenge）提交，便于评审了解动态
- **留下 session**：与 AI 协作的对话记录 / 分享链接
- **`.gitignore`**（已就位）：`server/data/*`（运行时状态）、`sandbox/outbox/*.json`（模拟邮件）、`node_modules/`。
  🔴 **`sandbox/notes/{todo.md,draft.txt}` 不忽略、已入库** —— 它们是题面 §2.2 目录树明确列出的交付夹具，忽略掉会让新克隆的仓库里 `sandbox/notes/` 只剩一个 `.gitkeep`（题面要求的目录树不完整）。它们由 `scripts/reset.ts` 按固定内容确定性重建，所以入库不影响"可重置"这条性质
- **仓库根目录名**：题面目录树写的是 `agent-tool-gateway/` ⇒ 提交/打包时把本目录改名为 `agent-tool-gateway`；若沿用 `problem3-tool-gateway`，须在提交说明中明确**本题即该仓库**
- **`docs/defense/`《答辩问答》**（已就位）：题面说"会对项目细节深入提问，**如果答不出细节可能会被认为过度使用 AI**" —— 这是唯一的评分门
- **净室自检**：参考了开源项目的**设计思路**（如"一次性审批""evidence trail""prompts are not security boundaries"这类论证），**未复制任何代码文本**。交付前全局搜索参考项目专有标识符（`capfence` / `AegisGov` / `cordon` / `ipiguard` 等）**应为零命中**

## 11. 审核修复记录（2026-10-11）

一次外部审核用 4 个独立探针脚本压测了并发、崩溃与协议边界，发现 **4 个实质缺陷**（原有 21 个用例**全部是绿的** —— 它们都没覆盖到这些路径）。逐条已修，并各留一条回归用例锁死。

| # | 缺陷 | 触发方式（实测） | 修法 | 回归 |
|---|---|---|---|---|
| 1 | **同一调用重发会新建并列的待确认记录**，用户并发确认其中两条时，两条都通过"未使用"检查 ⇒ **工具被执行两次**（outbox 里出现两封邮件） | 同一 `call_id` 提交两次 → `approval_001` + `approval_002` → `Promise.all` 确认 → 邮件 0→**2** | ③.5 分支：同 `call_id`+同工具+同 `argument_hash` 且**未决策未过期** ⇒ **复用**原记录，不新建 | R1、R2 |
| 2 | **MCP stdio 把审计日志写进了 stdout** —— 而 stdout 是 JSON-RPC 的协议通道，`[audit] ...` 会弄坏任何合规 MCP Client 的解析 | `... \| node server/mcp/server.ts >out 2>err` ⇒ stdout 混入审计行 | `appendAudit` 的终端镜像改走 `console.error`（stderr） | R5 |
| 3 | **`used=true` 只在内存里置位**，`persistState()` 排在 `await` 之后 ⇒ 工具执行期间进程被杀，重启后该确认带着 `used:false` 复活 ⇒ 重复副作用 | 执行中（50ms）读磁盘：`"used": false` | `used`/`decided` 置位后**立刻同步落盘**，再进 `await` | R4 |
| 4 | **MCP 两阶段确认跨进程断裂**：`startStdioServer` 不传 service ⇒ 每条消息都新建 `GatewayService`，记录的进程 ≠ 确认的进程 ⇒ 确认端点回 409"未找到待确认记录"，而"重发"只会不断新建记录（死循环） | MCP `tools/call` → `approval_001` → HTTP 确认 → **409** | ① `startStdioServer` 全程共用一个 `GatewayService`；② `handleDecision` 内存查不到时**重新合并一次磁盘状态**；③ MCP 的提示文案改为指向真正的确认端点 | R6 |

**同时补强**：executor 新增 `inFlight` 集合 —— 同键的**非幂等**调用若正在执行，**即使已获用户确认也拒绝**（返回 409，审计记 `decision=deny / approval_result=approved / execution_result=skipped`）。这条不能由 `allowAfterTimeout` 放开：一次确认只授权"再执行一次"，不授权"和正在跑的那次并行再跑一次"（回归用例 R3）。

> 诚实边界：修复 1/3 针对的是**单进程内**的并发与崩溃；多进程并发的**写**仍会互相覆盖（§7「未实现」第 2 条）。
