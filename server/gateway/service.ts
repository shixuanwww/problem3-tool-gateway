// ============================================================================
// server/gateway/service.ts —— GatewayService
//
// 题面原文（本题核心论点）：**Agent 只负责提出调用，真正的权限判断和工具执行必须由 Gateway 完成。**
//
// §4.3 五步（顺序不可乱）：
//   1 查工具 → 2 校验参数 → 3 检查资源范围 → 4 按服务端策略决定 → 5 记录本次决定
// 🔴 决策优先级（不可调换）：未知工具 → 参数非法 → 越界 → 需确认 → 执行。
//    理由：题面场景 3 要求 delete_note("../../config.json") 必须是 deny，
//    不能被"销毁性操作需要确认"掩盖。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { hashOfCall } from './canonical.ts';
import { validateSchema } from './validate.ts';
import { REPO_ROOT, resolveInSandbox } from './sandbox.ts';
import { defaultRegistry, ToolRegistry } from './registry.ts';
import { DEFAULT_TIMEOUT_MS, EXEC_FILE, Executor } from './executor.ts';
import { appendAudit, AUDIT_FILE, readJsonl } from './audit.ts';
import {
  APPROVALS_FILE,
  mergeApproval,
  readStateSnapshot,
  withStateLock,
  writeApprovalsFile,
} from './persist.ts';
import { loadOrCreateApprovalSecret, secretMatches } from './secret.ts';
import type {
  Approval,
  AuditEntry,
  PersistedState,
  ToolCall,
  ToolCallResponse,
  ToolImpl,
} from './types.ts';

/** 兼容旧引用：真实定义在 persist.ts（唯一写入口） */
export const APPROVAL_FILE = APPROVALS_FILE;
/** 确认有效期 300 秒（§11） */
export const APPROVAL_TTL_MS = 300_000;

/** 请求体里出现这些字段一律忽略（Agent 不能自行修改策略，§4.1 / 用例 16） */
const CLIENT_POLICY_FIELDS = [
  'risk',
  'requiresApproval',
  'requires_approval',
  'inputSchema',
  'input_schema',
  'tool_schema',
  'schema',
  'idempotency',
  'allowedRoot',
  'allowed_root',
];

const APPROVAL_REASONS: Record<string, string> = {
  send_email: 'send_email 会向外部收件人发送内容',
  delete_note: 'delete_note 会删除沙箱内的文件（销毁性操作）',
};

export interface GatewayOptions {
  registry?: ToolRegistry;
  timeoutMs?: number;
  /** 可注入的工具替身（用例 19 的超时桩） */
  tools?: Record<string, ToolImpl>;
  now?: () => number;
  /**
   * 用户确认通道的会话令牌（P1）。不传则从 server/data/approval-secret 载入或生成。
   * 测试注入固定值以便直接断言；HTTP / MCP 入口一律用 Gateway 生成的那个。
   */
  approvalSecret?: string;
}

export interface HttpResult {
  http: number;
  body: ToolCallResponse | Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class GatewayService {
  private readonly registry: ToolRegistry;
  private readonly executor: Executor;
  private readonly now: () => number;
  private readonly approvals = new Map<string, Approval>();
  private seq = { approval: 0, mail: 0 };
  /** 确认接口必须携带的用户会话令牌（P1）。绝不回传给 Agent。 */
  readonly approvalSecret: string;

  constructor(opts: GatewayOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.now = opts.now ?? (() => Date.now());
    this.approvalSecret = opts.approvalSecret ?? loadOrCreateApprovalSecret();
    this.executor = new Executor({
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      tools: opts.tools,
      now: this.now,
    });
    this.loadState();
    this.reportCorruptJsonl();
  }

  // ---------------- 状态持久化 ----------------

  /**
   * PLAN §11 要求：`*.jsonl`（audit / executions）逐行解析、跳过并**计数**损坏行，
   * 计数要写进启动日志。readJsonl() 本来就返回 corrupt，但改前没有任何调用方消费它
   * ⇒ 一行坏掉会静默丢失。这里在构造时（= 进程启动）报一次。
   */
  private reportCorruptJsonl(): void {
    for (const [label, file] of [
      ['audit.jsonl', AUDIT_FILE],
      ['executions.jsonl', EXEC_FILE],
    ] as Array<[string, string]>) {
      const { corrupt } = readJsonl(file);
      if (corrupt > 0) {
        console.error(
          `[gateway] 警告：${label} 有 ${corrupt} 行无法解析，已跳过 —— 审计/执行记录可能不完整`,
        );
      }
    }
  }

  private loadState(): void {
    let text: string;
    try {
      text = fs.readFileSync(APPROVAL_FILE, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // 首次运行
      throw e;
    }
    try {
      const parsed = JSON.parse(text) as PersistedState;
      if (!parsed || !Array.isArray(parsed.approvals)) throw new Error('结构不符');
      for (const a of parsed.approvals) this.approvals.set(a.approval_id, a);
      if (parsed.seq) {
        this.seq = { approval: parsed.seq.approval ?? 0, mail: parsed.seq.mail ?? 0 };
      }
    } catch {
      // 🔴 不静默重置：改名保留现场 + 打印告警（§11 启动载入与损坏恢复）
      const broken = `${APPROVAL_FILE}.corrupt-${this.now()}`;
      try {
        fs.renameSync(APPROVAL_FILE, broken);
      } catch {
        /* 改名失败也不阻塞启动 */
      }
      console.warn(
        `[gateway] approvals.json 解析失败 —— 已改名保留为 ${path.basename(broken)}，以空表启动`,
      );
    }
  }

  /**
   * 把磁盘状态与内存状态**单调合并**进内存（必须在 withStateLock 内调用）。
   *
   * 合并规则见 persist.ts 的 mergeApproval()：used 只增不减、decided 一旦
   * 落盘不被覆盖。这样别的进程刚写下的 `used=true` 不会被本进程的旧快照擦掉。
   * 同时把别的进程新写的记录并入内存 —— 跨进程两阶段确认因此天然可见。
   */
  private mergeFromDiskLocked(): void {
    const disk = readStateSnapshot();
    if (!disk) return;
    for (const a of disk.approvals) {
      const mem = this.approvals.get(a.approval_id);
      this.approvals.set(a.approval_id, mem ? mergeApproval(a, mem) : a);
    }
    this.seq = {
      approval: Math.max(this.seq.approval, disk.seq.approval),
      mail: Math.max(this.seq.mail, disk.seq.mail),
    };
  }

  /** 必须在 withStateLock 内调用（否则会有读-改-写竞争） */
  private persistStateLocked(): void {
    this.mergeFromDiskLocked();
    const payload: PersistedState = { seq: this.seq, approvals: [...this.approvals.values()] };
    writeApprovalsFile(payload);
  }

  private persistState(): void {
    withStateLock(() => this.persistStateLocked());
  }

  /**
   * 分配 approval_id。必须在锁内把磁盘 seq 也读进来再 +1，
   * 否则两个进程各自从 seq=0 起算会生成同一个 approval_id。
   */
  private nextApprovalId(): string {
    return withStateLock(() => {
      const disk = readStateSnapshot();
      this.seq.approval = Math.max(this.seq.approval, disk?.seq.approval ?? 0) + 1;
      this.persistStateLocked();
      return `approval_${String(this.seq.approval).padStart(3, '0')}`;
    });
  }

  private nextMailId(): string {
    return withStateLock(() => {
      const disk = readStateSnapshot();
      this.seq.mail = Math.max(this.seq.mail, disk?.seq.mail ?? 0) + 1;
      this.persistStateLocked();
      return `mail_${String(this.seq.mail).padStart(3, '0')}`;
    });
  }

  private toolCtx() {
    return { repoRoot: REPO_ROOT, nextMailId: () => this.nextMailId() };
  }

  // ---------------- 审计 ----------------

  private audit(
    base: { ts: string; user_id: string; call_id: string; tool_name: string },
    fields: {
      decision: AuditEntry['decision'];
      approval_result: AuditEntry['approval_result'];
      execution_result: AuditEntry['execution_result'];
      approval_id?: string;
      argument_hash?: string;
      deny_reason?: string;
      detail?: string;
    },
  ): void {
    const entry: AuditEntry = {
      ts: base.ts,
      user_id: base.user_id,
      call_id: base.call_id,
      tool_name: base.tool_name,
      decision: fields.decision,
      approval_result: fields.approval_result,
      execution_result: fields.execution_result,
      ...(fields.approval_id ? { approval_id: fields.approval_id } : {}),
      ...(fields.argument_hash ? { argument_hash: fields.argument_hash } : {}),
      ...(fields.deny_reason ? { deny_reason: fields.deny_reason } : {}),
      ...(fields.detail ? { detail: fields.detail } : {}),
    };
    appendAudit(entry);
  }

  private detectInjectedPolicy(rawBody?: Record<string, unknown>): string | undefined {
    if (!rawBody) return undefined;
    const hit = Object.keys(rawBody).filter((k) => CLIENT_POLICY_FIELDS.includes(k));
    return hit.length > 0
      ? `ignored client-supplied policy: ${hit.join(', ')}`
      : undefined;
  }

  // ============================================================
  // POST /tool-calls
  // ============================================================

  async handleToolCall(
    call: ToolCall,
    ctx: { user_id: string; rawBody?: Record<string, unknown> },
  ): Promise<HttpResult> {
    const ts = new Date(this.now()).toISOString();
    const user_id = ctx.user_id;
    // 🔴 审计的 7 个必需字段要求非空：畸形请求（缺 call_id / tool_name）也要留痕，
    //    所以这里用占位符而不是空串 —— 否则审计里会出现 call_id="" 这种无法对账的行。
    const call_id =
      typeof call?.call_id === 'string' && call.call_id.length > 0 ? call.call_id : '(missing)';
    const tool_name =
      typeof call?.tool_name === 'string' && call.tool_name.length > 0
        ? call.tool_name
        : '(missing)';
    const args = isPlainObject(call?.arguments) ? call.arguments : {};
    const base = { ts, user_id, call_id, tool_name };
    const policyNote = this.detectInjectedPolicy(ctx.rawBody);

    const deny = (
      http: number,
      reason: string,
      extra: Partial<{
        approval_result: AuditEntry['approval_result'];
        approval_id: string;
        argument_hash: string;
        deny_reason: string;
      }> = {},
    ): HttpResult => {
      this.audit(base, {
        decision: 'deny',
        approval_result: extra.approval_result ?? 'n/a',
        execution_result: 'skipped',
        ...(extra.approval_id ? { approval_id: extra.approval_id } : {}),
        ...(extra.argument_hash ? { argument_hash: extra.argument_hash } : {}),
        ...(extra.deny_reason ? { deny_reason: extra.deny_reason } : {}),
        ...(policyNote ? { detail: policyNote } : {}),
      });
      return {
        http,
        body: { call_id, decision: 'deny', status: 'denied', reason },
      };
    };

    // ---------------- 步骤 1：查工具 ----------------
    const def = this.registry.get(tool_name);
    if (!def) {
      return deny(400, `未知工具: ${tool_name}`);
    }

    // ---------------- 步骤 2：参数校验 ----------------
    const v = validateSchema(args, def.inputSchema);
    if (!v.ok) {
      return deny(400, `参数非法: ${v.error}`);
    }

    // ---------------- 步骤 3：资源范围检查 ----------------
    if (def.allowedRoot) {
      const raw = args['path'];
      const p =
        typeof raw === 'string'
          ? resolveInSandbox(def.allowedRoot, raw)
          : { ok: false as const, reason: '缺少 path' };
      if (!p.ok) {
        // 对外：题面示例的原话措辞；审计里：留具体闸门原因（deny_reason），可事后举证
        return deny(400, `目标路径超出 ${def.allowedRoot}`, { deny_reason: p.reason });
      }
    }

    const hash = hashOfCall(def.name, args);

    // ---------------- 步骤 4：服务端策略 ----------------

    // 4a) 不需要确认 ⇒ allow，直接执行
    if (!def.requiresApproval) {
      const out = await this.executor.run(call_id, def, args, this.toolCtx());
      if (out.kind === 'success') {
        this.audit(base, {
          decision: 'allow',
          approval_result: 'not_required',
          execution_result: 'success',
          argument_hash: hash,
          ...(policyNote ? { detail: policyNote } : {}),
        });
        return {
          http: 200,
          body: { call_id, decision: 'allow', status: 'executed', result: out.result },
        };
      }
      const execResult: AuditEntry['execution_result'] =
        out.kind === 'timeout' ? 'timeout' : 'error';
      this.audit(base, {
        decision: 'allow',
        approval_result: 'not_required',
        execution_result: execResult,
        argument_hash: hash,
        detail:
          out.kind === 'timeout'
            ? '工具执行超时（不自动重试；幂等工具可安全重试，§4.10）'
            : out.kind === 'error'
              ? `执行出错: ${out.message}`
              : out.reason,
      });
      return {
        http: 200,
        body: {
          call_id,
          decision: 'allow',
          status: 'failed',
          reason:
            out.kind === 'timeout'
              ? `工具执行超时（>${this.executor.timeoutMs}ms）`
              : out.kind === 'error'
                ? `工具执行失败: ${out.message}`
                : out.reason,
        },
      };
    }

    // 4b) 需要确认 —— 先查执行记录（§4.10：同 call_id + 同 argument_hash）
    const lastExec = this.executor.lastRecordByHash(call_id, hash);
    if (lastExec && lastExec.status === 'success') {
      this.audit(base, {
        decision: 'allow',
        approval_result: 'approved',
        execution_result: 'success',
        argument_hash: hash,
        detail: '命中已完成的执行记录（§4.10）：不重跑，返回已存结果',
      });
      return {
        http: 200,
        body: {
          call_id,
          decision: 'allow',
          status: 'executed',
          reason: '该调用此前已获用户确认并执行完毕，按 §4.10 返回已存结果（不重跑）',
          result: lastExec.result,
        },
      };
    }

    // 4c) 再查待确认记录（同一 call_id）
    // 🔴 例外：非幂等工具**此前执行过但没取得成功结果**（超时 / 响应丢失）⇒ 既不自动重试，
    //    也不复用旧确认，直接新建 Approval 让人工重新确认（§4.10 / 用例 19）。
    const nonIdempotentAfterTimeout =
      Boolean(lastExec) &&
      (lastExec as { status: string }).status !== 'success' &&
      def.idempotency === 'non_idempotent';
    const mine = nonIdempotentAfterTimeout
      ? []
      : [...this.approvals.values()].filter(
          (a) => a.call_id === call_id && a.user_id === user_id,
        );
    const exact = mine
      .filter((a) => a.tool_name === tool_name && a.argument_hash === hash)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]; // created_at 最大的一条

    // ① 已批准且已执行 ⇒ 返回已存结果，不重跑
    if (exact && exact.decided === 'approve' && exact.used && exact.result !== undefined) {
      this.audit(base, {
        decision: 'allow',
        approval_result: 'approved',
        execution_result: 'success',
        approval_id: exact.approval_id,
        argument_hash: hash,
        detail: '命中已批准且已执行的同一调用：不重跑',
      });
      return {
        http: 200,
        body: {
          call_id,
          decision: 'allow',
          status: 'executed',
          reason: '该调用已获用户确认并执行完毕，返回已存结果（不重跑）',
          result: exact.result,
        },
      };
    }

    // ② 已拒绝 ⇒ 沿用结论，不新建 Approval
    if (exact && exact.decided === 'deny') {
      return deny(409, '用户已拒绝该调用', { approval_id: exact.approval_id });
    }

    // ③ 同 call_id 已有记录，但工具或参数变了 ⇒ 直接 deny（题面明确要求拒绝）
    if (!exact && mine.length > 0) {
      const prev = mine.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
      return deny(409, '工具或参数发生变化', {
        approval_id: prev?.approval_id,
        argument_hash: hash,
      });
    }

    // ③.5 同 call_id + 同工具 + 同参数，且**尚未决策、尚未过期** ⇒ 复用这条待确认记录。
    //      🔴 不这么做会有两个后果（均已实测）：
    //        ① 同一个逻辑调用每重发一次就多一条并列的待确认记录，`approval_id` 不稳定；
    //        ② 用户并发确认其中两条时，两条都能通过"未使用"检查（各自的 used 都是 false），
    //           于是工具被真正执行两次 —— outbox/ 里出现两封邮件，重复副作用。
    //      注意只复用"未决策"的记录：已批准但执行失败的记录必须走 ④ 新建
    //      （超时后人工重新确认的路径，用例 19 明确断言 approval_id 必须变）。
    if (exact && exact.decided === undefined && this.now() < Date.parse(exact.expires_at)) {
      this.audit(base, {
        decision: 'require_approval',
        approval_result: 'n/a',
        execution_result: 'skipped',
        approval_id: exact.approval_id,
        argument_hash: hash,
        detail: policyNote
          ? `同一调用的重发：复用已有的待确认记录，不新建；${policyNote}`
          : '同一调用的重发：复用已有的待确认记录，不新建',
      });
      return {
        http: 200,
        body: {
          call_id,
          decision: 'require_approval',
          status: 'pending',
          reason: APPROVAL_REASONS[tool_name] ?? `${tool_name} 的操作可能存在外部副作用`,
          approval_id: exact.approval_id,
        },
      };
    }

    // ④ 其余（无命中 / 已有记录但已过期或已执行失败）⇒ 新建 Approval，返回 require_approval
    const createdAt = new Date(this.now()).toISOString();
    const approval: Approval = {
      approval_id: this.nextApprovalId(),
      call_id,
      user_id,
      tool_name,
      argument_hash: hash,
      // 深拷贝快照：确认后一律按快照执行（防 TOCTOU）。浅拷贝会让嵌套对象与
      // 调用方共享引用，理论上可被调用方在"提交 → 确认"之间改掉。
      arguments_snapshot: structuredClone(args),
      created_at: createdAt,
      expires_at: new Date(this.now() + APPROVAL_TTL_MS).toISOString(),
      used: false,
    };
    this.approvals.set(approval.approval_id, approval);
    this.persistState();

    const pendingReason = nonIdempotentAfterTimeout
      ? `${tool_name} 是**非幂等**操作，此前一次执行未取得成功结果（可能是超时或响应丢失）；` +
        `重复执行会产生第二次副作用 ⇒ **不自动重试**，请人工确认后再发一次。`
      : (APPROVAL_REASONS[tool_name] ?? `${tool_name} 的操作可能存在外部副作用`);

    this.audit(base, {
      decision: 'require_approval',
      approval_result: 'n/a',
      execution_result: 'skipped',
      approval_id: approval.approval_id,
      argument_hash: hash,
      ...(policyNote ? { detail: policyNote } : {}),
    });

    return {
      http: 200,
      body: {
        call_id,
        decision: 'require_approval',
        status: 'pending',
        reason: pendingReason,
        approval_id: approval.approval_id,
      },
    };
  }

  // ============================================================
  // POST /approvals/{approval_id}/decision
  // ============================================================

  async handleDecision(
    approvalId: string,
    body: { action?: string; user_id?: string; approval_secret?: string },
  ): Promise<HttpResult> {
    const ts = new Date(this.now()).toISOString();
    const action = body?.action;
    const userId = body?.user_id;

    const rejectWith = (
      http: number,
      reason: string,
      a?: Approval,
      approvalResult: AuditEntry['approval_result'] = 'n/a',
    ): HttpResult => {
      this.audit(
        { ts, user_id: userId ?? 'unknown', call_id: a?.call_id ?? '', tool_name: a?.tool_name ?? '' },
        {
          decision: 'deny',
          approval_result: approvalResult,
          execution_result: 'skipped',
          ...(a ? { approval_id: a.approval_id, argument_hash: a.argument_hash } : {}),
          detail: reason,
        },
      );
      return { http, body: { approval_id: approvalId, status: 'denied', reason } };
    };

    // ---------------- 0 用户通道认证（P1 修复）----------------
    // 🔴 题面：「该请求只能由 Client 根据用户的实际操作发起，Agent 无权替用户作出决定。」
    //    确认接口必须携带**用户会话令牌**；Agent 通道 POST /tool-calls 拿不到它，
    //    所以模型（或被网页注入的调用）无法自己 approve 自己。
    //    先认证再看记录，避免未认证请求拿 approval_id 探测记录是否存在。
    if (!secretMatches(this.approvalSecret, body?.approval_secret)) {
      return rejectWith(
        401,
        '确认请求未通过用户通道认证：缺少或错误的用户会话令牌',
        this.lookupForAudit(approvalId),
      );
    }

    // ---------------- 1~6 查记录 / 六条拒绝 / 一次性置位（全部在文件锁内，P2 修复）----------------
    //   🔴 跨进程并发确认同一个 approval_id 时，只有抢到锁的那个能通过"未使用"检查，
    //      另一个必然读到 used=true 被拒 ⇒ 单机多进程（HTTP + MCP）也只会执行一次。
    const claim = this.claimDecision(approvalId, action, userId);
    if (!claim.ok) {
      return rejectWith(claim.http, claim.reason, claim.approval, claim.approvalResult);
    }
    const a = claim.approval;

    // ---------------- 通过 ----------------

    if (claim.effect === 'deny') {
      this.audit(
        { ts, user_id: a.user_id, call_id: a.call_id, tool_name: a.tool_name },
        {
          decision: 'deny',
          approval_result: 'denied',
          execution_result: 'skipped',
          approval_id: a.approval_id,
          argument_hash: a.argument_hash,
          detail: '用户拒绝该调用，不执行工具',
        },
      );
      return {
        http: 200,
        body: { call_id: a.call_id, approval_id: a.approval_id, status: 'denied' },
      };
    }

    // approve：used=true / decided=approve 已在 claimDecision 的锁内**同步落盘**，
    // 此后才做异步工作（执行工具）。执行最长可能耗时一个 timeout，若这期间进程被杀，
    // 重启后这条确认不会带着 used=false 复活。

    const def = this.registry.get(a.tool_name);
    if (!def) {
      this.persistState();
      this.audit(
        { ts, user_id: a.user_id, call_id: a.call_id, tool_name: a.tool_name },
        {
          decision: 'deny',
          approval_result: 'approved',
          execution_result: 'error',
          approval_id: a.approval_id,
          detail: '确认对应的工具已不存在',
        },
      );
      return {
        http: 409,
        body: { call_id: a.call_id, status: 'failed', reason: '该确认对应的工具已不存在' },
      };
    }

    // 用**快照参数**执行，不用请求参数（防 TOCTOU，用例 11）
    // allowAfterTimeout：人工已显式确认 ⇒ 允许越过"非幂等超时不自动重试"的闸门一次
    const out = await this.executor.run(
      a.call_id,
      def,
      a.arguments_snapshot,
      this.toolCtx(),
      { allowAfterTimeout: true },
    );

    const auditBase = { ts, user_id: a.user_id, call_id: a.call_id, tool_name: a.tool_name };

    // 🔴 用户**已经确认**，Gateway 仍然拒绝执行 —— 这恰恰是本题的论点：
    //    权限判断与执行由 Gateway 说了算。一次确认只授权"执行一次"，
    //    不授权"和正在跑的那次并行再跑一次"（否则重复副作用）。
    if (out.kind === 'blocked_in_flight' || out.kind === 'blocked_non_idempotent') {
      this.audit(auditBase, {
        decision: 'deny',
        approval_result: 'approved',
        execution_result: 'skipped',
        approval_id: a.approval_id,
        argument_hash: a.argument_hash,
        detail: `Gateway 拒绝执行（用户已确认）：${out.reason}`,
      });
      return {
        http: 409,
        body: {
          call_id: a.call_id,
          approval_id: a.approval_id,
          status: 'denied',
          reason: out.reason,
        },
      };
    }

    a.executed_at = new Date(this.now()).toISOString();
    if (out.kind === 'success') a.result = out.result;
    this.persistState();

    if (out.kind === 'success') {
      this.audit(auditBase, {
        decision: 'allow',
        approval_result: 'approved',
        execution_result: 'success',
        approval_id: a.approval_id,
        argument_hash: a.argument_hash,
        detail: '用户确认后执行成功',
      });
      return {
        http: 200,
        body: { call_id: a.call_id, approval_id: a.approval_id, status: 'executed', result: out.result },
      };
    }

    const execution_result: AuditEntry['execution_result'] =
      out.kind === 'timeout' ? 'timeout' : 'error';
    this.audit(auditBase, {
      decision: 'allow',
      approval_result: 'approved',
      execution_result,
      approval_id: a.approval_id,
      argument_hash: a.argument_hash,
      detail: out.kind === 'timeout' ? '确认后执行超时' : `确认后执行出错: ${out.message}`,
    });
    return {
      http: 200,
      body: {
        call_id: a.call_id,
        approval_id: a.approval_id,
        status: 'failed',
        reason: out.kind === 'timeout' ? '确认后执行超时' : `确认后执行失败: ${out.message}`,
      },
    };
  }

  /**
   * 只读查找（内存 → 磁盘），用于**认证失败时的审计上下文**。
   * 不写任何状态；返回的记录不会回传给调用方，只进审计日志。
   */
  private lookupForAudit(approvalId: string): Approval | undefined {
    const mem = this.approvals.get(approvalId);
    if (mem) return mem;
    return readStateSnapshot()?.approvals.find((x) => x.approval_id === approvalId);
  }

  /**
   * 在一个**文件锁临界区**内完成「查记录 → 六条拒绝条件 → 一次性置位 → 落盘」。
   *
   * 为什么要放进锁里（P2）：改前这段是"先读内存、再改内存、然后异步执行"，
   * 单进程靠事件循环串行没问题，但 HTTP 与 MCP 是两个进程，两边都能通过
   * "未使用"检查 ⇒ 同一个 approval_id 被执行两次。现在：
   *   · 进入锁后先 mergeFromDiskLocked()，拿到的是磁盘上的最新状态；
   *   · approve 时 `used = true` 与 `decided = 'approve'` 在同一临界区内写盘；
   *   · 另一个进程随后进锁时读到 used=true，只能得到 409「确认已使用」。
   * 锁的粒度只覆盖同步的文件 I/O，工具执行在锁外，不会阻塞其它确认。
   */
  private claimDecision(
    approvalId: string,
    action: string | undefined,
    userId: string | undefined,
  ):
    | { ok: true; effect: 'approve' | 'deny'; approval: Approval }
    | {
        ok: false;
        http: number;
        reason: string;
        approval?: Approval;
        approvalResult: AuditEntry['approval_result'];
      } {
    return withStateLock(() => {
      this.mergeFromDiskLocked();
      const a = this.approvals.get(approvalId);
      if (!a) return { ok: false as const, http: 409, reason: '未找到待确认记录', approvalResult: 'n/a' as const };

      // action 合法？
      if (action !== 'approve' && action !== 'deny') {
        return { ok: false as const, http: 400, reason: 'action 非法（只接受 approve / deny）', approval: a, approvalResult: 'n/a' as const };
      }
      // 未过期？
      if (!(this.now() < Date.parse(a.expires_at))) {
        return { ok: false as const, http: 409, reason: '确认已过期', approval: a, approvalResult: 'n/a' as const };
      }
      // 未使用？
      if (a.used) return { ok: false as const, http: 409, reason: '确认已使用', approval: a, approvalResult: 'n/a' as const };
      // 同一用户？
      if (userId !== a.user_id) {
        return { ok: false as const, http: 409, reason: '确认者不是原用户', approval: a, approvalResult: 'n/a' as const };
      }
      // 未被拒绝过？
      // 🔴 decided === undefined（尚未决策）是新建记录的正常状态，必须放行。
      if (a.decided === 'deny') {
        return { ok: false as const, http: 409, reason: '用户已拒绝该调用', approval: a, approvalResult: 'denied' as const };
      }

      if (action === 'deny') {
        a.decided = 'deny';
        this.persistStateLocked();
        return { ok: true as const, effect: 'deny' as const, approval: a };
      }

      // 🔴 一次性 + 并发：check 与 set 之间不得出现 await，且整段在文件锁内。
      a.used = true;
      a.decided = 'approve';
      this.persistStateLocked();
      return { ok: true as const, effect: 'approve' as const, approval: a };
    });
  }

  // ---------------- 供测试 / 演示 / MCP 使用 ----------------

  getApproval(id: string): Approval | undefined {
    return this.approvals.get(id);
  }

  listApprovals(): Approval[] {
    return [...this.approvals.values()];
  }

  getToolDef(name: string) {
    return this.registry.get(name);
  }

  listToolDefs() {
    return this.registry.list();
  }
}
