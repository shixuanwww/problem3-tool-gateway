// ============================================================================
// server/gateway/registry.ts —— 可信工具定义 + 风险策略（§4.1）
//
// 🔴 这张表是**唯一事实来源**，且只存在于 Server 进程内。
//    请求体里若出现 risk / requiresApproval / inputSchema / tool_schema 之类的字段，
//    一律忽略（§4.1 / §4.11，用例 16）—— 否则"被约束的一方"就能自己声明自己是安全的。
// ============================================================================

import type { JsonSchema, ToolDef } from './types.ts';

/** read_note / delete_note / read_webpage 共用的参数形态（题面原文给的 delete_note 示例） */
const PATH_ONLY: JsonSchema = {
  type: 'object',
  properties: { path: { type: 'string', minLength: 1 } },
  required: ['path'],
  additionalProperties: false,
};

const SEND_EMAIL: JsonSchema = {
  type: 'object',
  properties: {
    to: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
    subject: { type: 'string', minLength: 1 },
    body: { type: 'string' },
  },
  required: ['to', 'subject', 'body'],
  additionalProperties: false,
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'read_note',
    description: '读取 sandbox/notes 下的笔记内容（只读，无副作用）',
    inputSchema: PATH_ONLY,
    risk: 'read_only',
    idempotency: 'idempotent',
    requiresApproval: false,
    allowedRoot: 'sandbox/notes',
  },
  {
    name: 'delete_note',
    description: '删除 sandbox/notes 下的笔记（销毁性操作；目标状态一致：不存在也算删除成功）',
    inputSchema: PATH_ONLY,
    risk: 'destructive',
    idempotency: 'idempotent',
    // 🔴 题面把 delete_note(path="draft.txt") 当作**用户确认**的例子（§1.9）
    //    ⇒ 合法路径必须走 require_approval；越界路径在步骤 3 就被 deny，走不到这里。
    requiresApproval: true,
    allowedRoot: 'sandbox/notes',
  },
  {
    name: 'send_email',
    description: '模拟发送邮件（不连真实邮件服务），把邮件写成 sandbox/outbox 下的 JSON 文件',
    inputSchema: SEND_EMAIL,
    risk: 'external_side_effect',
    // 🔴 重发会产生第二封邮件 ⇒ 非幂等 ⇒ 超时后**不自动重试**（§4.10，README 第 5 问）
    idempotency: 'non_idempotent',
    requiresApproval: true,
  },
  {
    // Challenge 2：间接提示词注入用的只读工具
    name: 'read_webpage',
    description: '读取 sandbox/web 下的网页内容（只读；返回内容可能含不可信文本）',
    inputSchema: PATH_ONLY,
    risk: 'read_only',
    idempotency: 'idempotent',
    requiresApproval: false,
    allowedRoot: 'sandbox/web',
  },
];

export class ToolRegistry {
  private readonly map = new Map<string, ToolDef>();

  constructor(defs: ToolDef[] = TOOL_DEFS) {
    for (const d of defs) this.map.set(d.name, d);
  }

  get(name: string): ToolDef | undefined {
    return this.map.get(name);
  }

  list(): ToolDef[] {
    return [...this.map.values()];
  }
}

export const defaultRegistry = new ToolRegistry();
