// ============================================================================
// tests/advanced.test.ts —— 进阶与工程性用例 9–16（§8 表 B）
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GatewayService } from '../server/gateway/service.ts';
import { argumentHash, canonicalize } from '../server/gateway/canonical.ts';
import { readAudit, appendAudit } from '../server/gateway/audit.ts';
import { ToolRegistry } from '../server/gateway/registry.ts';
import { TOOL_DEFS } from '../server/gateway/registry.ts';
import { builtinTools } from '../server/tools/index.ts';
import type { JsonSchema, ToolCallResponse, ToolDef, ToolImpl } from '../server/gateway/types.ts';
import {
  decide,
  freshService,
  notePath,
  outboxCount,
  REPO_ROOT,
  resetAll,
  startTestServer,
  USER,
  writeNote,
} from './helpers.ts';

function body(r: { body: unknown }): ToolCallResponse {
  return r.body as ToolCallResponse;
}

const EMAIL_ARGS = {
  to: 'mentor@example.com',
  subject: '作业链接',
  body: '这是本次作业的文档链接。',
};

test('用例 9 — 参数绑定：同 call_id 换参数必须被拒，且旧确认已生效、新目标未被碰', async () => {
  const svc = freshService();
  writeNote('report.txt', '报告草稿\n');
  assert.ok(fs.existsSync(notePath('draft.txt')));

  const base = { call_id: 'call_900', tool_name: 'delete_note' };
  const r = await svc.handleToolCall({ ...base, arguments: { path: 'draft.txt' } }, { user_id: USER });
  assert.equal(body(r).decision, 'require_approval');
  const d = await decide(svc, body(r).approval_id!, 'approve');
  assert.equal(String((d.body as Record<string, unknown>)['status']), 'executed');
  assert.ok(!fs.existsSync(notePath('draft.txt')), '原确认删掉的是 draft.txt');

  const changed = await svc.handleToolCall(
    { ...base, arguments: { path: 'report.txt' } },
    { user_id: USER },
  );
  assert.equal(changed.http, 409);
  assert.equal(body(changed).decision, 'deny');
  assert.equal(body(changed).reason, '工具或参数发生变化');
  assert.ok(fs.existsSync(notePath('report.txt')), 'report.txt 必须仍在（未被执行）');
});

test('用例 10 — 键序不影响 argument_hash（否则绑定可被绕过）', () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  assert.equal(argumentHash({ a: 1, b: 2 }), argumentHash({ b: 2, a: 1 }));
  // 嵌套也要递归排序
  assert.equal(
    argumentHash({ x: { p: 1, q: 2 }, y: [1, 2] }),
    argumentHash({ y: [1, 2], x: { q: 2, p: 1 } }),
  );
  // 数组保序 ⇒ 不同值必须不同 hash
  assert.notEqual(argumentHash({ y: [1, 2] }), argumentHash({ y: [2, 1] }));
});

test('用例 11 — TOCTOU：确认接口带不同参数也不会改变执行内容（用快照）', async () => {
  const { base, close, service } = await startTestServer();
  try {
    writeNote('report.txt', '报告草稿\n');
    const res0 = await fetch(base + '/tool-calls', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        call_id: 'call_901',
        tool_name: 'delete_note',
        arguments: { path: 'draft.txt' },
      }),
    });
    const r0 = (await res0.json()) as Record<string, unknown>;

    // 确认请求里塞一份**不同的** arguments —— 必须被忽略，执行的是快照
    const res1 = await fetch(
      `${base}/approvals/${String(r0['approval_id'])}/decision`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-approval-secret': service.approvalSecret,
        },
        body: JSON.stringify({
          action: 'approve',
          user_id: USER,
          arguments: { path: 'report.txt' },
        }),
      },
    );
    await res1.json();

    assert.ok(!fs.existsSync(notePath('draft.txt')), '被删的必须是快照里的 draft.txt');
    assert.ok(fs.existsSync(notePath('report.txt')), '请求里塞的 report.txt 不得被执行');
  } finally {
    await close();
  }
});

test('用例 12 — 决策优先级：越界优先于需确认（步骤 3 的 deny 永远压过步骤 4）', async () => {
  resetAll();
  const pathSchema: JsonSchema = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  };
  const tempDef: ToolDef = {
    name: 'temp_delete',
    description: '测试用：销毁性 + 需确认 + 限定 sandbox/notes',
    inputSchema: pathSchema,
    risk: 'destructive',
    idempotency: 'idempotent',
    requiresApproval: true,
    allowedRoot: 'sandbox/notes',
  };
  const svc = new GatewayService({ registry: new ToolRegistry([...TOOL_DEFS, tempDef]) });

  const escaped = await svc.handleToolCall(
    { call_id: 'call_120', tool_name: 'temp_delete', arguments: { path: '../../config.json' } },
    { user_id: USER },
  );
  assert.equal(body(escaped).decision, 'deny', '越界必须 deny，不能被"需确认"掩盖');
  assert.equal(body(escaped).reason, '目标路径超出 sandbox/notes');

  // 对照：合法路径才走 require_approval
  const legal = await svc.handleToolCall(
    { call_id: 'call_121', tool_name: 'temp_delete', arguments: { path: 'todo.md' } },
    { user_id: USER },
  );
  assert.equal(body(legal).decision, 'require_approval');
});

test('用例 13 — 并发一次性：同一 approval_id 在同一 tick 里确认两次，只有一次执行', async () => {
  const svc = freshService();
  const before = outboxCount();
  const r = await svc.handleToolCall(
    { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS },
    { user_id: USER },
  );
  const id = body(r).approval_id!;

  // 不 await 中间，两个请求"同时"提交
  const [a, b] = await Promise.all([
    decide(svc, id, 'approve'),
    decide(svc, id, 'approve'),
  ]);

  const statuses = [a, b].map((x) =>
    String((x.body as Record<string, unknown>)['status'] ?? '(none)'),
  );
  const executed = statuses.filter((s) => s === 'executed').length;
  assert.equal(executed, 1, `恰好 1 次 executed，实际 ${JSON.stringify(statuses)}`);
  assert.equal(outboxCount(), before + 1, 'outbox/ 恰好多 1 个文件');
});

test('用例 14 — 重启恢复：已用的确认不能因为重启就复活', async () => {
  const svc1 = freshService();
  const r = await svc1.handleToolCall(
    { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS },
    { user_id: USER },
  );
  const id = body(r).approval_id!;
  await decide(svc1, id, 'approve');
  const after = outboxCount();

  // 新进程（这里用新实例模拟：状态只从 approvals.json 恢复）
  const svc2 = new GatewayService();
  const restored = svc2.getApproval(id);
  assert.ok(restored, 'approvals.json 必须被载入');
  assert.equal(restored!.used, true, '已用的确认重启后仍为 used');
  assert.equal(restored!.decided, 'approve');

  // 再确认一次仍被拒（第 4 条）
  const again = await decide(svc2, id, 'approve');
  assert.equal(again.http, 409);
  assert.equal(String((again.body as Record<string, unknown>)['reason']), '确认已使用');

  // 重发同一调用 ⇒ 返回已存结果，不重跑
  const repost = await svc2.handleToolCall(
    { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS },
    { user_id: USER },
  );
  assert.equal(body(repost).decision, 'allow');
  assert.match(String(body(repost).reason), /不重跑/);
  assert.equal(outboxCount(), after, '重启+重发都不得产生第二封邮件');
});

test('用例 15 — 审计含题面要求的 5 个日志字段', async () => {
  const svc = freshService();
  await svc.handleToolCall(
    { call_id: 'call_002', tool_name: 'read_note', arguments: { path: 'todo.md' } },
    { user_id: USER },
  );
  const p = await svc.handleToolCall(
    { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS },
    { user_id: USER },
  );
  await decide(svc, body(p).approval_id!, 'approve');

  const rows = readAudit();
  assert.ok(rows.length >= 3);
  // 注：decision / execution_result 是字面量 union，TS 认为 `!== ''` 恒真；
  //     这里要断的是"运行时非空字符串"，所以统一转成 string 再比。
  const nonEmpty = (v: unknown) => typeof v === 'string' && String(v).length > 0;
  for (const row of rows) {
    assert.ok(nonEmpty(row.call_id), 'call_id 必须非空');
    assert.ok(nonEmpty(row.tool_name), 'tool_name 必须非空');
    assert.ok(nonEmpty(row.decision), 'decision 必须非空');
    assert.ok(nonEmpty(row.execution_result), 'execution_result 必须非空');
  }
  // approval_id 必须能在待确认/确认记录里读到
  const withApproval = rows.filter((r) => r.decision === 'require_approval');
  assert.equal(withApproval.length, 1);
  assert.ok(withApproval[0]!.approval_id, 'requir_approval 的审计必须带 approval_id');
});

test('用例 16 — 客户端提交的策略字段被忽略（策略只在 Server）', async () => {
  const svc = freshService();
  const r = await svc.handleToolCall(
    { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS },
    {
      user_id: USER,
      // 客户端谎报"我很安全、我不需要确认"
      rawBody: {
        call_id: 'call_001',
        tool_name: 'send_email',
        arguments: EMAIL_ARGS,
        risk: 'read_only',
        requiresApproval: false,
        inputSchema: { type: 'object' },
      },
    },
  );
  assert.equal(body(r).decision, 'require_approval', '客户端自报的策略必须无效');

  const entry = readAudit('call_001').at(-1)!;
  assert.match(String(entry.detail), /ignored client-supplied policy/);
  assert.equal(entry.decision, 'require_approval');
});

// ===========================================================================
// 回归用例 R1–R6 —— 2026-10-11 审核发现并修复的 4 个实质缺陷，各留一条锁
//   R1/R2 → 同一调用重发不再新建并列的待确认记录；并发确认不会重复副作用
//   R3    → 执行仍在进行中时，Gateway 拒绝并发执行（用户已确认也拒）
//   R4    → used 在执行期间就已落盘（进程被杀后确认不复活）
//   R5    → 审计终端镜像走 stderr（stdout 是 MCP 的协议通道）
//   R6    → 确认端点能看到别的实例写下的待确认记录（跨进程两阶段确认）
// ===========================================================================

test('R1 — 同一调用重发：复用同一条待确认记录，不新建（approval_id 稳定）', async () => {
  const svc = freshService();
  const call = { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS };

  const r1 = await svc.handleToolCall(call, { user_id: USER });
  const r2 = await svc.handleToolCall(call, { user_id: USER });
  const r3 = await svc.handleToolCall(call, { user_id: USER });

  assert.equal(body(r1).decision, 'require_approval');
  assert.equal(body(r2).approval_id, body(r1).approval_id, '重发必须复用同一条记录');
  assert.equal(body(r3).approval_id, body(r1).approval_id);
  assert.equal(svc.listApprovals().length, 1, '不得出现并列的多条待确认记录');
  assert.equal(outboxCount(), 0, '未确认时不得有邮件');
});

test('R2 — 同一调用重发后再并发确认：副作用只发生一次（P0-1 回归）', async () => {
  const svc = freshService();
  const call = { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS };

  // 修复前：两次提交产生 approval_001 / approval_002，并发确认两条都会通过
  // "未使用"检查 ⇒ outbox/ 出现两封邮件。
  const a = body(await svc.handleToolCall(call, { user_id: USER })).approval_id!;
  const b = body(await svc.handleToolCall(call, { user_id: USER })).approval_id!;
  assert.equal(a, b);

  const before = outboxCount();
  const results = await Promise.all([
    decide(svc, a, 'approve'),
    decide(svc, b, 'approve'),
  ]);
  assert.equal(outboxCount(), before + 1, '并发确认后必须恰好 1 封邮件');

  const statuses = results.map((r) => String((r.body as Record<string, unknown>)['status']));
  assert.equal(statuses.filter((s) => s === 'executed').length, 1, `实际 ${JSON.stringify(statuses)}`);
});

test('R3 — 执行仍在进行中时并发确认：Gateway 拒绝执行（即使已获用户确认）', async () => {
  resetAll();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let writes = 0;
  const tools: Record<string, ToolImpl> = {
    ...builtinTools,
    send_email: async () => {
      writes += 1;
      await sleep(150); // 制造一个足够宽的"执行中"窗口
      return { message_id: `mail_${writes}`, stored_at: 'sandbox/outbox/x.json' };
    },
  };
  const svc = new GatewayService({ tools });

  const call = { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS };
  const id = body(await svc.handleToolCall(call, { user_id: USER })).approval_id!;

  // 第一次确认：工具开始执行并挂起
  const first = decide(svc, id, 'approve');
  await sleep(50); // 让第一次真正进入 await

  // 执行中重发 ⇒ 非幂等超时/未完成路径会新建一条 Approval（用例 19 的行为）
  const id2 = body(await svc.handleToolCall(call, { user_id: USER })).approval_id!;
  assert.notEqual(id2, id, '执行未完成时重发应新建记录（与用例 19 一致）');

  // 第二条也确认 ⇒ 必须被 in-flight 闸门挡下，不得产生第二次副作用
  const second = await decide(svc, id2, 'approve');
  assert.equal(second.http, 409, '执行进行中必须拒绝并发执行');
  assert.match(String((second.body as Record<string, unknown>)['reason']), /仍在进行中/);

  const firstOut = await first;
  assert.equal(String((firstOut.body as Record<string, unknown>)['status']), 'executed');
  assert.equal(writes, 1, '工具实现只应被调用一次');
  assert.equal(outboxCount(), 0, '本用例的桩不落盘，outbox 应保持为空');

  // 审计如实记录"用户已确认，但 Gateway 拒绝执行"
  const rows = readAudit('call_001');
  const blocked = rows.find((r) => String(r.detail ?? '').includes('Gateway 拒绝执行'));
  assert.ok(blocked, '必须留下一条"Gateway 拒绝执行"的审计');
  assert.equal(blocked!.decision, 'deny');
  assert.equal(blocked!.approval_result, 'approved');
  assert.equal(blocked!.execution_result, 'skipped');
});

test('R4 — used 在执行期间就已落盘（进程被杀后确认不复活，P1-2 回归）', async () => {
  resetAll();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const tools: Record<string, ToolImpl> = {
    ...builtinTools,
    send_email: async (a, ctx) => {
      await sleep(150);
      return builtinTools.send_email(a, ctx);
    },
  };
  const svc = new GatewayService({ tools });
  const id = body(
    await svc.handleToolCall(
      { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS },
      { user_id: USER },
    ),
  ).approval_id!;

  const pending = decide(svc, id, 'approve');
  await sleep(50); // 工具执行中

  // 模拟"此刻进程被 kill"：只看磁盘上已经写下的内容
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'server', 'data', 'approvals.json'), 'utf8'),
  ) as { approvals: Array<{ approval_id: string; used: boolean; decided?: string }> };
  const rec = onDisk.approvals.find((x) => x.approval_id === id);
  assert.ok(rec, '记录必须在磁盘上');
  assert.equal(rec.used, true, 'used 必须在 await 之前落盘');
  assert.equal(rec.decided, 'approve');

  await pending;
});

test('R5 — 审计的终端镜像走 stderr，不污染 stdout（MCP 的协议通道）', () => {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void outLines.push(a.join(' '));
  console.error = (...a: unknown[]) => void errLines.push(a.join(' '));
  try {
    appendAudit({
      ts: new Date(0).toISOString(),
      user_id: USER,
      call_id: 'call_r5',
      tool_name: 'read_note',
      decision: 'allow',
      approval_result: 'not_required',
      execution_result: 'success',
    });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assert.equal(outLines.length, 0, 'stdout 必须保持干净（那是 MCP 的 JSON-RPC 通道）');
  assert.equal(errLines.length, 1, '终端镜像必须走 stderr');
  assert.match(errLines[0]!, /call_id=call_r5/);
});

test('R6 — 确认端点能看到别的实例写下的待确认记录（跨进程两阶段确认）', async () => {
  resetAll();
  const writer = new GatewayService(); // 模拟 MCP stdio server 那个进程
  const httpLike = new GatewayService(); // 模拟 HTTP Gateway，构造早于记录产生

  const id = body(
    await writer.handleToolCall(
      { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS },
      { user_id: USER },
    ),
  ).approval_id!;

  assert.equal(httpLike.getApproval(id), undefined, '构造时磁盘上还没有这条记录');

  const before = outboxCount();
  const d = await decide(httpLike, id, 'approve');
  assert.equal(d.http, 200, '必须能确认另一个实例写下的记录');
  assert.equal(String((d.body as Record<string, unknown>)['status']), 'executed');
  assert.equal(outboxCount(), before + 1);
});

// ===========================================================================
// P1 / P2 修复回归（2026-10-11 第二轮审核）
//   R7 → 确认接口必须有用户通道令牌，Agent 自报 user_id 不再能自己 approve
//   R8 → 跨实例写盘不能把 used=true 擦回 false（旧实现会全量覆盖）
//   R9 → 两个实例分配 approval_id 不重复、磁盘不丢记录（旧实现会撞号 + 覆盖）
// ===========================================================================

test('R7 — 确认接口必须有用户通道令牌（P1 回归：Agent 不能自己 approve）', async () => {
  const svc = freshService();
  const r = await svc.handleToolCall(
    { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS },
    { user_id: USER },
  );
  const id = body(r).approval_id!;
  const before = outboxCount();

  // ① 改前的伪造方式：只自报 user_id，不带任何令牌
  const forged = await svc.handleDecision(id, { action: 'approve', user_id: USER });
  assert.equal(forged.http, 401, '无令牌的确认必须 401');
  assert.match(String((forged.body as Record<string, unknown>)['reason']), /用户通道认证/);
  assert.equal(outboxCount(), before, '无令牌必须无副作用');

  // ② 长度相同但内容错误的令牌（覆盖 timingSafeEqual 路径）
  const wrong = await svc.handleDecision(id, {
    action: 'approve',
    user_id: USER,
    approval_secret: 'deadbeef'.repeat(8),
  });
  assert.equal(wrong.http, 401);
  assert.equal(outboxCount(), before);

  // ③ Agent 通道的响应里绝不能回传用户令牌
  assert.ok(
    !JSON.stringify(r.body).includes(svc.approvalSecret),
    '/tool-calls 响应不得回传用户通道令牌',
  );

  // ④ 带正确令牌才执行，且恰好一次
  const ok = await decide(svc, id, 'approve');
  assert.equal(String((ok.body as Record<string, unknown>)['status']), 'executed');
  assert.equal(outboxCount(), before + 1);

  // ⑤ 未认证的请求也要留下审计（decision=deny），便于事后追查伪造尝试
  const forgedRows = readAudit('call_001').filter((x) =>
    String(x.detail ?? '').includes('用户通道认证'),
  );
  assert.ok(forgedRows.length >= 1, '伪造确认必须留审计');
});

test('R8 — 跨实例写盘不会把 used 擦回 false（P2 回归）', async () => {
  const a = freshService();
  const b = new GatewayService(); // 构造早于记录产生 ⇒ 内存里没有它

  const id = body(
    await a.handleToolCall(
      { call_id: 'call_001', tool_name: 'send_email', arguments: EMAIL_ARGS },
      { user_id: USER },
    ),
  ).approval_id!;
  const before = outboxCount();

  const d = await decide(b, id, 'approve');
  assert.equal(String((d.body as Record<string, unknown>)['status']), 'executed');
  assert.equal(outboxCount(), before + 1);

  // a 的内存里这条还是 used=false；让它再写一次盘。
  // 改前 a.persistState() 全量覆盖，会把磁盘上的 used=true 擦回 false。
  await a.handleToolCall(
    {
      call_id: 'call_002',
      tool_name: 'send_email',
      arguments: { ...EMAIL_ARGS, subject: '第二封' },
    },
    { user_id: USER },
  );

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'server', 'data', 'approvals.json'), 'utf8'),
  ) as { approvals: Array<{ approval_id: string; used: boolean; decided?: string }> };
  const rec = onDisk.approvals.find((x) => x.approval_id === id);
  assert.ok(rec, '磁盘上必须还有这条记录');
  assert.equal(rec!.used, true, 'used 必须单调：不能被旧快照擦回 false');
  assert.equal(rec!.decided, 'approve');

  // 模拟"重启后"：从磁盘重新载入，确认也不能复活
  const c = new GatewayService();
  const again = await decide(c, id, 'approve');
  assert.equal(again.http, 409);
  assert.equal(String((again.body as Record<string, unknown>)['reason']), '确认已使用');
  assert.equal(outboxCount(), before + 1, '不得出现第二封邮件');
});

test('R9 — 跨实例 approval_id 不撞号、磁盘不丢记录（P2 回归）', async () => {
  const a = freshService();
  const b = new GatewayService(); // 构造时磁盘 seq=0；改前它会从 0 起算撞号

  const mk = (svc: GatewayService, callId: string) =>
    svc.handleToolCall(
      { call_id: callId, tool_name: 'send_email', arguments: EMAIL_ARGS },
      { user_id: USER },
    );
  const [r1, r2] = await Promise.all([mk(a, 'call_101'), mk(b, 'call_102')]);
  const id1 = body(r1).approval_id!;
  const id2 = body(r2).approval_id!;

  assert.equal(body(r1).decision, 'require_approval');
  assert.equal(body(r2).decision, 'require_approval');
  assert.notEqual(id1, id2, '两个实例必须拿到不同的 approval_id');

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'server', 'data', 'approvals.json'), 'utf8'),
  ) as { approvals: Array<{ approval_id: string }> };
  const ids = onDisk.approvals.map((x) => x.approval_id);
  assert.ok(
    ids.includes(id1) && ids.includes(id2),
    `磁盘必须同时保留两条记录，实际 [${ids.join(', ')}]`,
  );
});
