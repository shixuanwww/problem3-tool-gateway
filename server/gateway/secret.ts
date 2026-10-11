// ============================================================================
// server/gateway/secret.ts —— 用户确认通道的会话令牌（P1 修复）
//
// 题面原话：「用户确认或拒绝时，Client 统一发送 POST /approvals/{id}/decision …
// 该请求只能由 Client 根据用户的实际操作发起，Agent 无权替用户作出决定。」
//
// 改前的问题：确认接口只信任**请求体里自报的 `user_id`**，任何人（包括被提示词
// 注入的 Agent）只要 POST `{"action":"approve","user_id":"user_default"}` 就能
// 让高风险工具执行 —— 实测确实能把邮件写进 sandbox/outbox。
//
// 修复思路：把「Agent 通道」与「用户通道」分开认证。
//   · POST /tool-calls（Agent 通道）**不需要**令牌 —— Agent 本来就只负责提出调用；
//   · POST /approvals/{id}/decision（用户通道）**必须**携带用户会话令牌；
//   · 令牌由 Gateway 启动时随机生成，落在 server/data/approval-secret，并在服务端
//     终端打印一次，只有用户侧的 Client（读文件 / --approval-secret）持有它；
//   · 它**不会**出现在任何 /tool-calls 响应里，所以模型/被注入的调用拿不到。
//
// ⚠️ 诚实边界：这是“本机 control token”级别的边界，不是真正的多用户鉴权。
//    能读到 server/data/approval-secret 的本机进程仍可冒充用户；生产环境应由
//    OS 会话 / OAuth 令牌推导身份（README 已声明）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DATA_DIR } from './sandbox.ts';

export const APPROVAL_SECRET_FILE = path.join(DATA_DIR, 'approval-secret');
const SECRET_RE = /^[0-9a-f]{32,}$/;

function readSecretFile(): string | undefined {
  try {
    const text = fs.readFileSync(APPROVAL_SECRET_FILE, 'utf8').trim();
    return SECRET_RE.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 加载已有令牌；不存在（或格式非法）就生成一个并原子落盘。
 * 用 `flag: 'wx'` 创建：并发启动时只有一个进程能写，其它进程回读同一个值。
 */
export function loadOrCreateApprovalSecret(): string {
  const existing = readSecretFile();
  if (existing) return existing;

  const generated = randomBytes(32).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    fs.writeFileSync(APPROVAL_SECRET_FILE, `${generated}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return generated;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const raced = readSecretFile();
    if (raced) return raced;
    // 文件存在但不是合法令牌 —— 覆盖成新令牌（例如被手工清空过）
    fs.writeFileSync(APPROVAL_SECRET_FILE, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
    return generated;
  }
}

/** 定长常量时间比较，避免通过响应时间逐字节猜令牌 */
export function secretMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
