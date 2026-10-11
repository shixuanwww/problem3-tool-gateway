// ============================================================================
// server/gateway/audit.ts —— 审计日志（JSONL，追加写）
//
// 口径（§11）：
//   一次 HTTP 请求**恰好写一条** AuditEntry；/approvals/{id}/decision 是独立请求、另写一条。
//   超时**不新增条目** —— 执行结果在同一个请求内就知道，所以那一条自带 execution_result='timeout'。
// 🔴 detail 里**禁止**出现邮件正文或文件内容原文（§11 / 附二 5）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './sandbox.ts';
import type { AuditEntry } from './types.ts';

export const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');

/** 通用：逐行读 JSONL，跳过并计数损坏行（不因一行坏掉整个文件失败，§11） */
export function readJsonl<T>(file: string): { rows: T[]; corrupt: number } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { rows: [], corrupt: 0 };
  }
  const rows: T[] = [];
  let corrupt = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      corrupt++;
    }
  }
  return { rows, corrupt };
}

export function appendJsonl(file: string, row: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
}

function fmt(entry: AuditEntry): string {
  const parts = [
    `call_id=${entry.call_id}`,
    `tool_name=${entry.tool_name}`,
    `decision=${entry.decision}`,
    `approval_id=${entry.approval_id ?? '-'}`,
    `approval_result=${entry.approval_result}`,
    `execution_result=${entry.execution_result}`,
  ];
  const extra = [
    entry.deny_reason ? `deny_reason=${entry.deny_reason}` : '',
    entry.detail ? `detail=${entry.detail}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `[audit] user=${entry.user_id} ${parts.join(' ')}${extra ? ' ' + extra : ''}`;
}

/**
 * 写盘 + 同时打印到终端（题面：「日志（terminal显示或者写进log）」）。
 *
 * 🔴 终端镜像必须走 **stderr**，不能走 `console.log`（stdout）：
 *    `server/mcp/server.ts` 用 **stdio** 跑 JSON-RPC —— stdout 是**协议通道**，
 *    任何非 JSON-RPC 的行（如 `[audit] ...`）都会把 MCP Client 的解析弄坏。
 *    stderr 同样是"terminal 显示"，却不会污染协议流（实测：改前 stdout 混入审计行）。
 */
export function appendAudit(entry: AuditEntry): void {
  appendJsonl(AUDIT_FILE, entry);
  console.error(fmt(entry));
}

/** 供 GET /audit 与测试使用 */
export function readAudit(callId?: string): AuditEntry[] {
  const { rows } = readJsonl<AuditEntry>(AUDIT_FILE);
  return callId ? rows.filter((r) => r.call_id === callId) : rows;
}
