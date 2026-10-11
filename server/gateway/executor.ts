// ============================================================================
// server/gateway/executor.ts —— 工具执行 + 超时 + 幂等判定（§4.9 / §4.10）
//
// 超时与安全重试（README 第 5 问的落地机制）：
//   执行**前**写一条"意图记录"（started），成功后追加"终态记录"（success），超时追加 timeout。
//   同一 call_id + 同一 argument_hash 有多条记录时，取 started_at 最大的一条判状态。
//   ⇒ 于是"超时后能否安全重试"有了判据：
//     · 已有 success          → 副作用已经发生，**不重试**，直接返回已存结果
//     · 无 success 且幂等     → 可安全重试（read_note 天然幂等；delete_note 目标状态一致）
//     · 无 success 且非幂等   → **不自动重试**（send_email 会产生第二封），转人工确认
// ============================================================================

import path from 'node:path';
import { DATA_DIR } from './sandbox.ts';
import { argumentHash, hashOfCall } from './canonical.ts';
import { appendJsonl, readJsonl } from './audit.ts';
import { builtinTools } from '../tools/index.ts';
import type { ExecutionRecord, ToolContext, ToolDef, ToolImpl } from './types.ts';

export const EXEC_FILE = path.join(DATA_DIR, 'executions.jsonl');
export const DEFAULT_TIMEOUT_MS = 5000;

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`工具执行超过 ${ms}ms 未返回`);
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export type ExecOutcome =
  | { kind: 'success'; result: unknown; reused: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'blocked_non_idempotent'; reason: string }
  | { kind: 'blocked_in_flight'; reason: string };

export interface ExecutorOptions {
  timeoutMs?: number;
  /** 可注入的工具实现表（用例 19 的超时桩就靠它 —— 不用环境变量，§11） */
  tools?: Record<string, ToolImpl>;
  now?: () => number;
}

export class Executor {
  readonly timeoutMs: number;
  private readonly tools: Record<string, ToolImpl>;
  private readonly now: () => number;
  /**
   * 🔴 「正在执行中」的非幂等调用集合，键 = `call_id \0 argument_hash`。
   *
   * 为什么必须有它：只靠 `executions.jsonl` 判重是不够的。落盘的 `started` 记录
   * 要等本次执行**结束**才有终态，而"查记录 → 写 started → await 工具"这段里，
   * 第二个请求看到的最新记录就是那条 `started`。若它带着 `allowAfterTimeout`
   * （用户确认路径一律带），非幂等闸门被绕过 ⇒ 同一次调用被执行两次（实测两封邮件）。
   * 单线程事件循环下，这个同步 Set 就是"同一时刻只允许一个同键执行"的原子判据。
   */
  private readonly inFlight = new Set<string>();

  constructor(opts: ExecutorOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tools = opts.tools ?? builtinTools;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 取某次调用最近的一条执行记录（started_at 最大者） */
  lastRecord(callId: string, toolName: string, args: Record<string, unknown>): ExecutionRecord | undefined {
    const hash = hashOfCall(toolName, args);
    return this.lastRecordByHash(callId, hash);
  }

  lastRecordByHash(callId: string, hash: string): ExecutionRecord | undefined {
    const { rows } = readJsonl<ExecutionRecord>(EXEC_FILE);
    const mine = rows.filter((r) => r.call_id === callId && r.argument_hash === hash);
    if (mine.length === 0) return undefined;
    mine.sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0));
    return mine[mine.length - 1];
  }

  /**
   * @param callId   用于执行记录的键
   * @param def      工具定义（幂等性在这里生效）
   * @param args     参数
   * @param ctx      工具上下文
   * @param opts.allowAfterTimeout
   *        仅由 `/approvals/{id}/decision` 传入：用户**显式确认**后，允许越过
   *        "非幂等工具超时不自动重试"的闸门**一次**。
   *        没有这条，§4.10 的"转 require_approval 让人工确认"就会变成死锁 ——
   *        用户确认了却怎么也执行不了。
   */
  async run(
    callId: string,
    def: ToolDef,
    args: Record<string, unknown>,
    ctx: ToolContext,
    opts: { allowAfterTimeout?: boolean } = {},
  ): Promise<ExecOutcome> {
    const hash = hashOfCall(def.name, args);
    const last = this.lastRecordByHash(callId, hash);

    // ① 已有 success ⇒ 副作用已发生，绝不重跑（这条**任何情况都不放宽**）
    if (last && last.status === 'success') {
      return { kind: 'success', result: last.result, reused: true };
    }

    // ② 同键的非幂等调用**此刻正在执行** ⇒ 立即拒绝。
    //    🔴 这一条**不受 `allowAfterTimeout` 影响**：用户的一次确认只授权"再执行一次"，
    //       不授权"和正在跑的那次并行再跑一次"。缺了它，并发路径会重复副作用（实测）。
    const flightKey = `${callId}\u0000${hash}`;
    if (def.idempotency === 'non_idempotent' && this.inFlight.has(flightKey)) {
      return {
        kind: 'blocked_in_flight',
        reason:
          '同一调用的上一次执行仍在进行中；重复执行会产生第二次副作用 ⇒ Gateway 拒绝并发执行。' +
          '请等上一次执行结束后再确认（若上一次已成功，重发会直接返回已存结果）。',
      };
    }

    // ③ 已有 started / timeout 且工具非幂等 ⇒ 不自动重试
    if (
      last &&
      last.status !== 'success' &&
      def.idempotency === 'non_idempotent' &&
      !opts.allowAfterTimeout
    ) {
      return {
        kind: 'blocked_non_idempotent',
        reason:
          '该非幂等调用此前已执行过但未取得成功结果（可能是超时或响应丢失），' +
          '重复执行会产生第二次副作用 ⇒ 不自动重试，须由用户重新确认。',
      };
    }

    const impl = this.tools[def.name];
    if (!impl) return { kind: 'error', message: `未注册的工具实现: ${def.name}` };

    // ④ 占位（同步，无 await）→ 写意图记录 → 执行 → 追加终态记录
    //    inFlight 的 add/delete 必须夹住整段执行，且 add 必须在任何 await 之前。
    this.inFlight.add(flightKey);
    const startedAt = new Date(this.now()).toISOString();
    appendJsonl(EXEC_FILE, {
      call_id: callId,
      tool_name: def.name,
      argument_hash: hash,
      status: 'started',
      started_at: startedAt,
    } satisfies ExecutionRecord);

    try {
      const result = await withTimeout(impl(args, ctx), this.timeoutMs);
      appendJsonl(EXEC_FILE, {
        call_id: callId,
        tool_name: def.name,
        argument_hash: hash,
        status: 'success',
        started_at: startedAt,
        finished_at: new Date(this.now()).toISOString(),
        result,
      } satisfies ExecutionRecord);
      return { kind: 'success', result, reused: false };
    } catch (e) {
      if (e instanceof TimeoutError) {
        appendJsonl(EXEC_FILE, {
          call_id: callId,
          tool_name: def.name,
          argument_hash: hash,
          status: 'timeout',
          started_at: startedAt,
          finished_at: new Date(this.now()).toISOString(),
        } satisfies ExecutionRecord);
        return { kind: 'timeout' };
      }
      // 其它错误不写终态记录 ⇒ 该次调用保持 "started" ⇒ 后续按"可能已执行"保守处理
      return { kind: 'error', message: (e as Error).message };
    } finally {
      this.inFlight.delete(flightKey);
    }
  }
}

export { argumentHash };
