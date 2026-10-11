// client/display.ts —— 确认展示
//
// 🔴 题面原文：「Client 不得只显示"是否继续"。」
//    必须向用户展示**工具名称**和**完整参数**，例如：
//      工具：send_email
//      收件人：mentor@example.com
//      标题：作业链接
//      正文：这是本次作业的文档链接。
import type { ToolCall, ToolCallResponse } from './types.ts';

/** 参数的「人话字段名」，未知字段回退成键名原文 */
const FIELD_LABELS: Record<string, string> = {
  path: '路径',
  to: '收件人',
  subject: '标题',
  body: '正文',
};

export function formatArguments(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '（无参数）';
  return keys
    .map((k) => `  ${FIELD_LABELS[k] ?? k}：${stringifyArg(args[k])}`)
    .join('\n');
}

function stringifyArg(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** 提交前的自述块：让用户看清"Agent 到底想干什么" */
export function renderToolCall(title: string, call: ToolCall): string {
  return [
    `── ${title} ──────────────────────────────`,
    `工具：${call.tool_name}`,
    formatArguments(call.arguments),
    `call_id：${call.call_id}`,
  ].join('\n');
}

/** 等待确认时展示的块（含 Gateway 给出的待确认理由） */
export function renderApprovalPrompt(call: ToolCall, resp: ToolCallResponse): string {
  return [
    '⚠️  该操作需要你确认后才能执行 —— Gateway **没有**提前执行它。',
    '',
    `工具：${call.tool_name}`,
    formatArguments(call.arguments),
    '',
    `理由：${resp.reason ?? '（Gateway 未给出理由）'}`,
    `approval_id：${resp.approval_id ?? '(缺失)'}`,
    `call_id：${call.call_id}`,
  ].join('\n');
}

export function renderDecisionResult(resp: ToolCallResponse): string {
  switch (resp.decision) {
    case 'allow':
      return `✅ 允许执行 —— 结果：\n${JSON.stringify(resp.result, null, 2)}`;
    case 'deny':
      return `⛔ 拒绝执行 —— 原因：${resp.reason ?? '(未给出)'}`;
    case 'require_approval':
      return `⏸  等待确认（approval_id=${resp.approval_id ?? '(缺失)'}）`;
    default:
      return `❓ 未知决定：${String(resp.decision)}`;
  }
}
