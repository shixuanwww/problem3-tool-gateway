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
node --experimental-strip-types --test --test-concurrency=1 tests/sandbox.test.ts tests/basic.test.ts tests/advanced.test.ts tests/challenge.test.ts
```

> 🔴 **测试必须带 `--test-concurrency=1`**：三个测试文件共用同一份 `sandbox/` 与 `server/data/`，`node --test` 默认**并行跑文件**会让"恰好 1 个文件"这类断言互相污染。文件内用例是顺序执行的。
>
> 🔴 **零第三方依赖**：没有 `npm install` 这一步，评审机上"一条命令就能跑"。`package.json` 里没有任何 `dependencies`。
>
> 🔴 **用户确认通道令牌（P1）**：Gateway 启动时会生成 `server/data/approval-secret`
> 并打印在服务端终端；`client/` 会自动读取它，所以**演示命令不用改**。手工调
> `POST /approvals/{id}/decision` 时必须带 `x-approval-secret`（或
> `--approval-secret <token>` 给 Client），否则一律 `401`。

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
        │   gateway/sandbox.ts    四道闸门               │
        │   gateway/service.ts    五步决策 / 确认 / 一次性│
        │   gateway/executor.ts   执行 + 超时 + 幂等判定  │
        │   gateway/audit.ts      审计（JSONL）          │
        │   gateway/persist.ts    文件锁 + 单调合并持久化 │
        │   gateway/secret.ts     用户通道令牌（P1）      │
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

**HTTP 状态码**：业务拒绝仍是 `400`（未知工具/参数非法/越界/action 非法）与 `409`（确认类状态冲突）；
`401` 专用于**用户通道没带对令牌**（`POST /approvals/{id}/decision`、`GET /audit`）；
`413` 用于请求体超过 1MB；`503` 是持久化锁竞争/磁盘错误的兜底（不是策略决定，不写业务审计）。

## 4. 沙箱：四道闸门（缺一不可）

`read_note` / `delete_note` 只能访问 `sandbox/notes/`，`read_webpage` 只能访问 `sandbox/web/`。题面点名三种绕过方式；另外为了不出现"策略说 allow、执行才报错"的灰区，第三轮又补了一条：

0. **拒绝控制字符（含 NUL）** —— JSON 里的 `\u0000` 不会被 `path.resolve` 拆掉，会一路走到 `fs` 层才抛错（表现成 `decision=allow / status=failed`），所以必须在策略阶段就 deny
1. **拒绝绝对路径** —— `path.isAbsolute` + Windows 盘符 `^[A-Za-z]:` + UNC `\\server\share` + 前导 `/` `\`
2. **按段拒绝穿越形态**（在归一化**之前**切段）—— ① 只由点/空格组成的段（`..` / `.. ` / `...` / `....`，`.` 放行所以 `./todo.md` 仍可用）；② 段内出现 `:`（Windows ADS，`todo.md::$DATA`）。所以 `a/../../b` 也拦得住（只看开头是不够的）
3. **归一化 + realpath + 前缀比对** —— 字符串前缀先挡一遍，再做 `fs.realpathSync`
   - 🔴 **为什么第 3 步不能省**：`sandbox/notes/link` 是指向 `../../config.json` 的**符号链接**时，前几道闸门**全过**（路径里没有 `..`，也不是绝对路径），只有 realpath 能挡。

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

补充字段：`approval_id?` / `argument_hash?` / `deny_reason?` / `detail?`

- `approval_result` ∈ `approved | denied | not_required | n/a`
- `execution_result` ∈ `success | error | skipped | timeout`
- `deny_reason`：**沙箱/校验拒绝时的具体原因**（如「路径包含控制字符」「路径段包含非法字符 ':'」「realpath 后越出白名单目录 …」）。对外 HTTP 响应仍是统一文案「目标路径超出 …」，具体原因只进审计 —— 这样"哪道闸门拦的"可被事后举证，而不把内部路径信息泄露给调用方
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
- **进阶**：确认精确绑定 `argument_hash`（规范化 JSON → sha256）、一次性 + 并发安全、六条拒绝条件、沙箱四道闸门、7 字段审计、落盘 + 重启恢复（原子写 + 损坏改名保留）
- **重复副作用的三道防线**（2026-10-11 审核后补强，见 §11）：① 同一调用**重发复用**同一条待确认记录（不再产生并列的多条）；② `used` 在 `await` **之前同步落盘**（进程被杀也不复活）；③ executor 维护"正在执行中"集合，**同键的非幂等调用并发执行一律拒绝**（用户已确认也拒 —— Gateway 说了算）
- **用户通道认证（P1，2026-10-11 第二轮审核后补强；第四轮收紧为只认请求头）**：`POST /approvals/{id}/decision` 必须携带 Gateway 生成、只交给用户侧 Client 的**用户会话令牌**（**只认 `x-approval-secret` 请求头**，值见文件 `server/data/approval-secret`；请求体里的 `approval_secret` 一律忽略 —— 请求体是 Agent 唯一能自由构造的地方，令牌躺进去就会跟着进日志/抓包/回放）。`POST /tool-calls`（Agent 通道）不要求、也拿不到它 ⇒ 模型或被提示词注入的调用**无法自己 approve 自己**。令牌比较用 `timingSafeEqual`，且**绝不出现在任何 `/tool-calls` 响应里**；HTTP 只绑回环地址
- **同机多进程持久化安全（P2，同上）**：`gateway/persist.ts` 用**同目录锁文件**包住"读磁盘 → 单调合并 → 写磁盘"，临时文件带 pid+随机数。合并规则是 `used` 只增不减、`decided` 一旦落盘不被覆盖、`seq` 取最大值 ⇒ 修好了"跨进程把 `used=true` 擦回 `false`"与"两个进程撞同一个 approval_id"
- **HTTP 兜底与边界收紧（第三轮，见 §11.3）**：请求处理整体 try/catch（持久化锁超时 → `503`，不再挂死/打挂进程）；超 1MB 请求体回 `413` 而不是掐连接；沙箱补"点/空格段 + ADS + NUL"三条拒绝；畸形请求的审计字段用 `(missing)` 占位而不是空串；启动时报告 `*.jsonl` 损坏行数；`GET /audit` 也走用户通道令牌
- **Challenge**：MCP（手写 stdio JSON-RPC 2.0，**整个 stdio 会话共用一个 `GatewayService` 实例**）、`read_webpage` + 间接提示词注入演示、超时安全重试判定
- **测试**：42 个用例，覆盖题面要求的 8 项 + 我们自加的部分（含 `resolveInSandbox` 四道闸门直测、HTTP 端到端、并发、重启恢复、MCP、注入、超时、以及 R1–R9 九条回归与第三轮的 413/503/审计占位）

### ❌ 未实现（如实声明）

1. 🟠 **用户通道认证是"本机 control token"级别，不是真正的多用户鉴权**。已修：确认接口必须带 Gateway 签发的令牌，Agent 通道拿不到它 ⇒ 单靠自报 `user_id` 的伪造已被挡住（回归用例 R7，无令牌 / 错令牌都回 `401` 且无副作用）。**未修**：能读到 `server/data/approval-secret` 的本机进程仍可冒充用户；`user_id` 仍固定为 `user_default`、不是从凭证推导。真实系统应由 **OS 会话 / OAuth 令牌**确定身份，并给每个用户独立身份与授权范围。
2. 🟠 **多进程只在"同一台机器"上是安全的**：`gateway/persist.ts` 的文件锁 + 单调合并修好了同机多进程（HTTP + MCP stdio）的并发写与 `used` 复活（回归用例 R8/R9，另有 4 进程并发实测：无撞号、无丢记录、同一个 approval 只有一个执行成功）。**未修**：跨机器 / 多副本仍不是分布式安全 —— 必须要数据库唯一约束（如 `UPDATE ... WHERE used = 0` 的原子 SQL）或分布式锁。本实现**不宣称**自己是分布式安全的。
3. **重试判据只依赖进程内执行记录**（同 Q5 的诚实边界）。
4. **`send_email` 不连真实邮件服务**（题面明确允许）：只写 `sandbox/outbox/<message_id>.json`。
5. **不接真实大模型**（题面 Basic 明确允许"使用固定 JSON 模拟 Agent 输出"）：Client 读 `client/scripts/*.json`。
6. **无 TLS / 无多用户隔离**：HTTP 已改为只绑 `127.0.0.1`（改前 `listen(port)` 会监听所有网卡），但仍没有 TLS、没有多用户隔离，`user_default` 是唯一的真实用户。
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
└── tests/{helpers,sandbox,basic,advanced,challenge}.test.ts
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

> 诚实边界（第一轮）：上面 1/3 的修复针对的是**单进程内**的并发与崩溃 —— 多进程写的覆盖问题在第一轮之后仍然存在，已在第二轮（下节）修掉。

### 11.2 第二轮审核修复（2026-10-11，P1 / P2）

第二轮审计逐条对照题面，实测复现了两个**题面级别**的问题，并修掉：

| # | 缺陷（实测） | 修法 | 回归 |
|---|---|---|---|
| P1 | **确认端点只信请求体自报的 `user_id`** ⇒ 任何人都能 `POST /approvals/{id}/decision {"action":"approve","user_id":"user_default"}` 让 `send_email` 真执行。题面明说"该请求只能由 Client 根据用户的实际操作发起，Agent 无权替用户作出决定" | 新增 `gateway/secret.ts`：Gateway 生成**用户会话令牌**（落 `server/data/approval-secret`、启动时打印一次），确认端点必须带 `x-approval-secret`（或 body `approval_secret`），用 `timingSafeEqual` 比较；**令牌从不出现在 `/tool-calls` 响应里**。Agent 通道不需要令牌（Agent 只负责提出调用）。顺带把 HTTP 从"监听所有网卡"改成只绑 `127.0.0.1` | R7 |
| P2 | **跨进程持久化有数据竞争**：① 固定临时名 `approvals.json.tmp` 并发写会抛 `ENOENT: rename`（实测 `node --test` 不带 `--test-concurrency=1` 时 8 个用例因此报错）；② `persistState()` 把本进程内存**全量覆盖**磁盘 ⇒ 会把别的进程刚写下的 `used=true` 擦回 `false`（确认复活 ⇒ 重复副作用）；③ 两个进程各自从 `seq=0` 起算 ⇒ **同一个 approval_id** | 新增 `gateway/persist.ts`：同目录**锁文件**（`open('wx')`，带超时与 15s 僵尸锁抢占）包住"读磁盘 → 单调合并 → 写磁盘"；临时文件带 pid+随机数；`mergeApproval()` 对 `used` 取或、`decided` 磁盘优先、`seq` 取最大。确认的"查 `used` → 置 `used`"整段也挪进锁内 ⇒ 同机多进程也只有一个赢家 | R8、R9 |

**实测证据**（探针脚本见 `D:\aoce\_probe\t3-p2-writer.mts` / `t3-p2-approver.mts`）：

- 4 个真实进程在同一份状态上并发创建：拿到 `approval_001..004` **四个不同 id**，磁盘 4 条记录一条不丢；
- 2 个真实进程同时确认**同一个** `approval_id`：一个 `200 executed`、一个 `409 确认已使用`，`sandbox/outbox/` **恰好 1 封邮件**；
- HTTP 端到端：无令牌 → `401` 且 outbox 为空；错令牌 → `401`；正确令牌 → `executed`，重复确认 → `409 确认已使用`。

> 残余诚实边界：① 令牌是**本机文件级**能力（同机能读到该文件的进程可冒充用户），真正的多用户鉴权要由 OS 会话 / OAuth 派生；② 文件锁只解决**同一台机器**的多进程，跨机器/多副本仍需数据库唯一约束；③ 三个测试文件仍共用同一份 `sandbox/`，所以测试**必须**用 `npm test`（已内置 `--test-concurrency=1`），并行跑文件会因夹具互相覆盖而出现计数类断言失败 —— 这是测试夹具共享问题，不是运行时数据竞争。

### 11.3 第三轮审计修复（2026-10-11，健壮性与边界）

第二轮把 P1/P2 修完之后，审计又逐条复验了"还没修的加固项"，并发现一个**由 P2 引入的新缺陷**（锁会抛异常，而 HTTP 层没接住）。逐条修掉，各留回归：

| # | 问题（实测） | 修法 | 回归 |
|---|---|---|---|
| A | **锁超时异常穿透 HTTP 层**：`createHttpServer` 的 async handler 没有 try/catch，`withStateLock` 抛错后请求**永久挂起**（客户端只能自己超时），并产生 unhandledRejection（Node 默认策略会**打挂进程**）。实测：客户端 9.0s 无响应 | 处理函数抽成 `handleRequest()`，`createHttpServer` 统一 `.catch()` → `503` + stderr 日志；锁等待从 5s 收到 **1.5s**（等待期间是同步阻塞，不能长） | 用例 21（实测 1.5s 回 503、无 unhandled） |
| B | **>1MB 请求体被掐连接**：`readBody` 超限时先 `req.destroy()`，客户端只拿到 `fetch failed`，收不到承诺的 400 | 不再 destroy：把 `tooLarge` 结果交回上层，响应 `413`（剩余 body 由已挂的 `data` 监听器自然丢弃） | 用例 20（实测 HTTP 413） |
| C | **沙箱对"解析不了的路径形态"放行**：`.. /web/promo.html`、`....//config.json`、含 NUL 的路径都返回 `decision=allow / status=failed`；`todo.md::$DATA` 甚至 `allow / executed` | 闸门 0 拒绝控制字符；闸门 2 改为"只由点/空格组成的段（`.` 除外）一律拒" + "段内含 `:` 一律拒"。正常写法 `./todo.md`、`my note.md` 仍放行 | 用例 6（扩到 7 个路径 + 符号链接/junction） |
| D | **畸形请求的审计字段是空串**：`call_id="" / tool_name=""`，与"必需字段非空"口径不符 | `handleToolCall` 用 `(missing)` 占位，畸形请求也留痕 | 用例 22 |
| E | **`*.jsonl` 损坏行只计数、从不输出**（PLAN §11 要求写进启动日志） | 构造服务时读一次 audit/executions，`corrupt > 0` 就打 stderr 警告 | 手工验证（输出`警告：audit.jsonl 有 1 行无法解析`） |
| F | **`GET /audit` 无认证**，Agent 能读到别人的调用记录 | 复用用户通道令牌：没带 / 带错 → `401`；Client 自动带上 | 端到端用例（401 → 200） |
| G | 死代码：`secret.ts` 的 `secretFingerprint`、`executor.ts` 的 `export { argumentHash }` | 删除 | — |

### 11.4 第四轮修正（2026-10-11，可证明性 / 口径一致）

第四轮独立复核聚焦"改了但证明不了 / 文档与实现不一致"两类问题：

| # | 问题 | 修法 | 回归 |
|---|---|---|---|
| A | **令牌能从请求体传**：第二轮的 P1 修复同时接受 `x-approval-secret` 头与 body `approval_secret`（README 只声明了头）⇒ 用户通道边界被不必要地放宽，且令牌会随请求体进日志/抓包/回放 | `server/index.ts` 的 `approvalSecretOf()` **只认请求头**，body 里的 `approval_secret` 一律忽略（与 §4.1「忽略客户端提交的策略字段」同源）；README 同步改口径 | `sandbox.test.ts` + HTTP 探针（body 传令牌 → `401`） |
| B | **闸门生效"无从观测"**：`resolveInSandbox` 返回的具体 reason 在 `service.ts` 被丢弃、统一成「目标路径超出 …」，审计行里也没有原因字段 ⇒ 被追问"NUL / ADS 闸门真的生效了吗"拿不出运行时证据 | 审计新增 `deny_reason` 字段：对外响应保持统一文案，**具体闸门原因只进审计**（不向调用方泄露内部路径信息）；终端镜像同步打印 | 用例 6 系列扩展：审计断言 `deny_reason` |
| C | **测试区分不出是哪道闸门**：四条闸门全靠统一文案间接断言，直接调 `resolveInSandbox` 的单测为零 ⇒ 删掉闸门 0 / 闸门 2 测试照样绿 | 新增 `tests/sandbox.test.ts`：**直接调用 `resolveInSandbox`**，逐道闸门断言具体 reason（NUL / 盘符 / UNC / 点空格段 / ADS 冒号 / `../` 前缀 / junction-realpath / `./todo.md` 放行）—— 删掉任何一道闸门必红 | `tests/sandbox.test.ts`（9 条） |
| D | **口径自相矛盾**：§4 已是「四道闸门」，另有 4 处残留「三道」 | README 架构图 / §7、`docs/defense/README.md` 索引表、`sandbox.ts` 文件头注释统一为「四道」 | — |
