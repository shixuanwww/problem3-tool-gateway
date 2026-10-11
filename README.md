# Agent 工具调用安全网关（题 3 交付说明）

> **一句话**：把「Agent 想做什么」与「用户授权了什么」彻底分开 ——
> **Agent 只负责提出调用，真正的权限判断和工具执行必须由 Gateway 完成。**
>
> 本 README 面向**快速评审**：完成度 → 怎么用 → 怎么检查 → 代码导读。
> 完整设计细节（五步流程 / 沙箱四道闸 / 审计字段 / 审核修复记录）见 **`docs/README-设计详版.md`**；
> 每个模块的《答辩问答》在 **`docs/defense/`**。

---

## 1. 完成度（对照题面三档）

| 档位 | 题面要求 | 状态 |
|---|---|---|
| **Basic（阶段 A）** | Client + Gateway、三个工具（send_email / read_note / delete_note）、JSON Schema 校验、确认展示、三个基础场景（allow / require_approval / deny） | ✅ 全做 |
| **进阶（阶段 B）** | 确认精确绑定参数（改参数即失效）、一次性使用 + 并发安全、沙箱路径约束、审计日志、持久化与重启恢复 | ✅ 全做：`argument_hash`（规范化 JSON→sha256）绑定、一次性令牌同步落盘、沙箱四道闸门、7 字段审计、原子写 + 损坏改名保留 |
| **Challenge（加分）** | MCP 接入、提示词注入演示、超时安全重试判定 | ✅ 手写 stdio JSON-RPC 2.0 MCP、间接注入链路演示、同 `call_id` 两阶段重试 |

**测试**：42 条用例 **42 pass / 0 fail**（约 65s，2026-10-11 实测），覆盖题面要求的 8 项安全检查 + 自加用例（HTTP 端到端 / 并发 / 重启恢复 / 注入 / 超时 / 九条审计回归）。
**如实声明**（详版 §7 有完整清单）：不接真实大模型（题面 Basic 允许固定 JSON 模拟）、`send_email` 只写 outbox 文件（题面允许）、用户通道令牌是"本机 control token"级别（Agent 无法自批自执行，但能读本机 secret 文件的进程除外）、非分布式安全。

---

## 2. 怎么使用

**环境**：Node ≥ 22.6（`node -v` 自检）。**零第三方依赖**——没有 `npm install` 这一步，一条命令就能跑。

```bash
# 第 0 步（每次演示/测试前必做）：重置落盘状态与沙箱夹具
npm run reset        # = node --experimental-strip-types scripts/reset.ts

# 终端 1：起 Gateway（默认 :8787）
npm run server

# 终端 2：跑题面要求的三个基础场景
npm run client       # = client/index.ts --scenario all
```

其他入口：`--scenario injection`（提示词注入演示）、`server/mcp/server.ts`（MCP stdio）、
`--scenario 1` 单跑某场景。用户确认通道令牌由 Gateway 自动生成，Client 自动读取，演示命令不用改。

---

## 3. 怎么检查（3 分钟验收清单）

```bash
npm run reset
# A. 全量用例（--test-concurrency=1 是必须的：三个测试文件共用同一份沙箱与落盘状态）
npm test

# B. 三个基础场景肉眼验证
npm run server          # 终端 1
npm run client          # 终端 2
```

**预期看点**（`--scenario all` 依次输出）：
1. **场景 1** `read_note("todo.md")` → `allow` + 文件内容 `buy milk`；
2. **场景 2** `send_email(...)` → `require_approval` + **完整确认展示块**（工具/收件人/标题/正文）→ 先列 `sandbox/outbox/`（**为空**）→ 确认 → 再列（**出现 mail_001.json**）——"确认前无副作用、确认后才有"是本题核心；
3. **场景 3** `delete_note("../../config.json")` → `deny`（越出沙箱）+ 沙箱外 `config.json` 指纹前后一致（**字节未变**）；
4. **收尾**：审计尾部（时间/用户/工具/决定/原因等字段）。

再深一步：`--scenario injection` 演示提示词注入被挡；把已确认的调用**重发一次** → 直接返回已存结果不重跑（一次性语义）。

---

## 4. 代码导读

```
server/
  index.ts        HTTP 服务（仅绑 127.0.0.1）+ 路由 + 请求兜底（413/503）
  gateway/
    service.ts    ★核心：五步校验流程 / 三种决定 / 一次性 / 两阶段确认
    registry.ts   工具注册表 + JSON Schema 参数校验
    sandbox.ts    沙箱四道闸门（路径归一 / 越界 / 符号链接 / 特殊段）
    persist.ts    落盘 + 同目录文件锁（同机多进程安全：used 只增不减）
  mcp/server.ts   MCP stdio 适配（JSON-RPC 2.0，整会话共用一个 GatewayService）
  data/           approvals / executions / audit（落盘，reset.ts 重置）
client/index.ts   模拟 Agent：读 client/scripts/*.json 的固定场景发请求
sandbox/          沙箱根：notes/（夹具 todo.md、draft.txt）+ outbox/（邮件产物）
tests/            basic / advanced / challenge 三组 42 用例
scripts/reset.ts  唯一重置入口（清落盘状态 + 重建沙箱夹具）
```

**主要设计（答辩深挖入口）**：
1. **五步校验流程**：注册检查 → Schema 校验 → 沙箱判定 → 确认绑定检查（`call_id ↔ (tool, argument_hash)` 一一对应，改参数必须换新 id）→ 一次性检查；
2. **确认 = 独立用户通道**：approve 接口必须带 Gateway 签发的会话令牌（`x-approval-secret`，`timingSafeEqual` 比较），Agent 通道拿不到 ⇒ **模型无法自己批准自己**；
3. **重复副作用三道防线**：重发复用同一条待确认记录、`used` 在 await 前同步落盘、执行中集合拒绝同键并发；
4. **审计可追溯**：每次调用 7 字段落盘，重启不丢；损坏文件改名保留而非静默删除；
5. **零依赖**：HTTP / 加密 / 测试全用 Node 内置能力，评审机无需联网装包。
