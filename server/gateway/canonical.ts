// ============================================================================
// server/gateway/canonical.ts —— 规范化摘要（§4.5）
//
// 为什么需要它：待确认记录必须精确绑定**这一次具体操作**，而不只是工具名。
// 绑定靠 argument_hash，而 hash 只有在"同一份参数无论键序如何都算出同一个值"
// 时才有意义 —— 否则 Agent 只要把 {a,b} 写成 {b,a} 就能绕过绑定。
// ============================================================================

import { createHash } from 'node:crypto';

/**
 * 规范化序列化：
 * - 对象：**键按键的码点升序递归排序**，输出紧凑 JSON（无空格）
 * - 数组：保序
 * - 字符串：原样（用 JSON.stringify 转义，保证可逆）
 * - 数字：String(n)
 * - 布尔 / null：字面量
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Object.keys 的顺序依赖插入序，必须显式排序
    const keys = Object.keys(obj).sort();
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') +
      '}'
    );
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return 'null';
}

/** sha256:<hex>，hex 为小写 */
export function argumentHash(args: unknown): string {
  const hex = createHash('sha256')
    .update(canonicalize(args), 'utf8')
    .digest('hex');
  return 'sha256:' + hex;
}

/**
 * 参与 hash 的字段 = `arguments` 的**全部键，不做任何剔除**（§4.5 / §11）。
 * 因此重试/复用必须逐字节重发同一份 arguments（含正文）；
 * 演示与测试脚本里禁止出现 Date.now() / 随机 ID / 临时路径。
 */
export function hashOfCall(toolName: string, args: Record<string, unknown>): string {
  // 工具名一并纳入（虽然调用方还会单独校验 tool_name，双保险且便于排查）
  return argumentHash({ tool_name: toolName, arguments: args });
}
