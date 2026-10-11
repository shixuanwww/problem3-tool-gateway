// ============================================================================
// server/gateway/types.ts —— 全项目数据契约（唯一事实来源）
// 对应 PLAN.md §3。**所有模块都从这里取类型，不要各写一份。**
// 运行方式：node --experimental-strip-types（只做类型擦除）⇒ 本文件里的
// `enum` / `namespace` / 装饰器 一律禁用，已改用 `const` 对象 + union type。
// ============================================================================

// ---------- 工具定义（Server 侧可信配置）----------

export type Risk = 'read_only' | 'external_side_effect' | 'destructive';
export type Idempotency = 'idempotent' | 'non_idempotent';

/** JSON Schema 的**最小子集**（见本文件末尾 JsonSchema 定义） */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: Risk;
  /** README 第 5 问的关键：超时后能否自动重试，取决于这个字段 */
  idempotency: Idempotency;
  /** 由 risk 决定，但显式写出来便于审计与演示 */
  requiresApproval: boolean;
  /** 仅 read_note / delete_note / read_webpage：相对仓库根，如 "sandbox/notes" */
  allowedRoot?: string;
}

// ---------- 调用 ----------

export interface ToolCall {
  call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  /**
   * 缺省 "user_default"。
   * 🔴 由 **Client 注入**；请求体里带的这个字段会被 Server 忽略（§4.1 / §4.11）。
   */
  user_id?: string;
}

export type Decision = 'allow' | 'require_approval' | 'deny';

export interface ToolCallResponse {
  call_id: string;
  decision: Decision;
  status: 'executed' | 'pending' | 'denied' | 'failed';
  reason?: string;
  approval_id?: string;
  result?: unknown;
}

// ---------- 待确认记录 ----------

export interface Approval {
  approval_id: string;
  call_id: string;
  /** 发起确认的那个用户；换用户必须拒绝（§4.6 第 5 条） */
  user_id: string;
  tool_name: string;
  /** §4.5 规范化摘要：sha256: + 递归键排序后的紧凑 JSON */
  argument_hash: string;
  /** 确认后**按快照原样执行**（防 TOCTOU，§4.6 / 用例 11） */
  arguments_snapshot: Record<string, unknown>;
  created_at: string; // ISO8601
  expires_at: string; // created_at + 300s（§11 默认值）
  /** 🔴 一次性标志；必须在任何 await 之前同步置位（§4.7） */
  used: boolean;
  /** 用户已做的决定（`undefined` = 尚未决策，是新建记录的正常状态） */
  decided?: 'approve' | 'deny';
  executed_at?: string;
  result?: unknown;
}

// ---------- 审计 ----------

export interface AuditEntry {
  ts: string; // 发生时间（ISO8601）
  user_id: string; // 用户
  call_id: string; // call_id
  tool_name: string; // 工具名称
  decision: Decision; // Gateway 决定
  approval_result: 'approved' | 'denied' | 'not_required' | 'n/a'; // 用户确认/拒绝结果
  execution_result: 'success' | 'error' | 'skipped' | 'timeout'; // 工具执行结果
  // ↓ 便于追查的补充字段（题面说"至少包含"，允许多写）
  approval_id?: string;
  argument_hash?: string;
  /** 沙箱/校验拒绝时的具体原因（第四轮：让"哪道闸门拦的"可被审计证明）。对外响应仍是统一文案 */
  deny_reason?: string;
  /** 🔴 禁止写入邮件正文 / 文件内容原文（§11 / 附二 5） */
  detail?: string;
}

// ---------- 执行记录（超时与安全重试的判据，§4.10）----------

export type ExecutionStatus = 'started' | 'success' | 'timeout';

export interface ExecutionRecord {
  call_id: string;
  tool_name: string;
  argument_hash: string;
  status: ExecutionStatus;
  started_at: string;
  finished_at?: string;
  result?: unknown;
}

// ---------- MCP ----------

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

// ---------- JSON Schema 最小子集（§4.2 校验器只需支持这些）----------

export type JsonSchema =
  | {
      type: 'object';
      properties?: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: boolean;
    }
  | {
      type: 'string';
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      enum?: string[];
    }
  | { type: 'integer'; minimum?: number; maximum?: number }
  | { type: 'number'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | {
      type: 'array';
      items?: JsonSchema;
      minItems?: number;
      maxItems?: number;
    };

// ---------- 工具实现（Server 侧）----------

export interface ToolContext {
  /** 仓库根（由 sandbox.ts 的 REPO_ROOT 提供） */
  repoRoot: string;
  /** 单调序号，重启后不回退 */
  nextMailId: () => string;
}

export type ToolImpl = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<unknown>;

// ---------- 持久化载体（server/data/approvals.json）----------

export interface PersistedState {
  /** 单调序号，保证重启后 approval_id / message_id 不回退 */
  seq: { approval: number; mail: number };
  approvals: Approval[];
}
