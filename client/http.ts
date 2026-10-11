// client/http.ts —— 调 Gateway 的两个端点
//
// 🔴 必须「先解析响应体、再看状态码」：deny 走 400、确认类冲突走 409，
//    但响应体仍是完整的 ToolCallResponse。写成 `if (!res.ok) throw` 会把
//    deny 的 reason 全部丢掉，场景 3 就演示不出"为什么被拒"。
import type { ToolCall, ToolCallResponse } from './types.ts';

export interface HttpReply {
  status: number;
  body: Partial<ToolCallResponse> & Record<string, unknown>;
}

async function request(
  baseUrl: string,
  path: string,
  init: RequestInit,
): Promise<HttpReply> {
  const res = await fetch(baseUrl + path, init);
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { error: text };
  }
  return { status: res.status, body };
}

export function submitToolCall(baseUrl: string, call: ToolCall): Promise<HttpReply> {
  return request(baseUrl, '/tool-calls', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(call),
  });
}

export function submitDecision(
  baseUrl: string,
  approvalId: string,
  action: 'approve' | 'deny',
  userId: string,
  approvalSecret: string,
): Promise<HttpReply> {
  return request(baseUrl, `/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // 🔴 用户通道令牌：Agent 的 ToolCall 里没有它，也拿不到它。
      'x-approval-secret': approvalSecret,
    },
    body: JSON.stringify({ action, user_id: userId }),
  });
}

export function fetchAudit(
  baseUrl: string,
  callId?: string,
  approvalSecret?: string,
): Promise<HttpReply> {
  const q = callId ? `?call_id=${encodeURIComponent(callId)}` : '';
  return request(baseUrl, `/audit${q}`, {
    method: 'GET',
    // /audit 也走用户通道（审计里有别人的调用记录，不该给 Agent 看）
    ...(approvalSecret ? { headers: { 'x-approval-secret': approvalSecret } } : {}),
  });
}
