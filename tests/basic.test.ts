// ============================================================================
// tests/basic.test.ts —— 题面明确要求的 8 项测试（§8 表 A，一一对应）
//   1 合法的只读调用可以执行
//   2 高风险工具确认前不产生副作用
//   3 用户确认后工具只执行一次
//   4 用户拒绝后工具不能执行
//   5 未知工具和非法参数被拒绝
//   6 路径不能越过沙箱
//   7 过期、改参数、换用户和重复确认均被拒绝
//   8 每次决定与执行均存在审计记录
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewayService } from '../server/gateway/service.ts';
import { readAudit } from '../server/gateway/audit.ts';
import type { ToolCall, ToolCallResponse } from '../server/gateway/types.ts';
import {
  configBytes,
  decide,
  decideWithAction,
  freshService,
  NOTES_DIR,
  notePath,
  outboxCount,
  readNote,
  REPO_ROOT,
  removeLink,
  tryDirJunction,
  trySymlink,
  USER,
  writeNote,
  resetAll,
  startTestServer,
  decisionOf,
} from './helpers.ts';

function body(r: { body: unknown }): ToolCallResponse {
  return r.body as ToolCallResponse;
}

test('用例 1 — 合法的只读调用可以执行', async () => {
  const svc = freshService();
  const r = await svc.handleToolCall(
    { call_id: 'call_002', tool_name: 'read_note', arguments: { path: 'todo.md' } },
    { user_id: USER },
  );
  assert.equal(r.http, 200);
  assert.equal(body(r).decision, 'allow');
  assert.equal(body(r).status, 'executed');
  assert.match(String((body(r).result as { content: string }).content), /buy milk/);
});

test('用例 2 — 高风险工具确认前不产生副作用', async () => {
  const svc = freshService();
  const before = outboxCount();
  const r = await svc.handleToolCall(
    {
      call_id: 'call_001',
      tool_name: 'send_email',
      arguments: { to: 'mentor@example.com', subject: '作业链接', body: '这是本次作业的文档链接。' },
    },
    { user_id: USER },
  );
  assert.equal(body(r).decision, 'require_approval');
  assert.equal(body(r).status, 'pending');
  assert.ok(body(r).approval_id, '必须返回 approval_id');
  assert.equal(outboxCount(), before, '确认前 outbox/ 不得出现任何新文件');
});

test('用例 3 — 用户确认后工具只执行一次（重复确认被拒）', async () => {
  const svc = freshService();
  const before = outboxCount();
  const r = await svc.handleToolCall(
    {
      call_id: 'call_001',
      tool_name: 'send_email',
      arguments: { to: 'mentor@example.com', subject: '作业链接', body: '这是本次作业的文档链接。' },
    },
    { user_id: USER },
  );
  const id = body(r).approval_id!;

  const first = await decide(svc, id, 'approve');
  assert.equal(first.http, 200);
  assert.equal(String((first.body as Record<string, unknown>)['status']), 'executed');
  assert.equal(outboxCount(), before + 1, '确认后恰好多 1 个邮件文件');

  const second = await decide(svc, id, 'approve');
  assert.equal(second.http, 409);
  assert.equal(
    String((second.body as Record<string, unknown>)['reason']),
    '确认已使用',
  );
  assert.equal(outboxCount(), before + 1, '第二次确认不得再产生副作用');
});

test('用例 4 — 用户拒绝后工具不能执行（且此后 confirm 也被拒）', async () => {
  const svc = freshService();
  const before = outboxCount();
  const r = await svc.handleToolCall(
    {
      call_id: 'call_001',
      tool_name: 'send_email',
      arguments: { to: 'mentor@example.com', subject: '作业链接', body: '这是本次作业的文档链接。' },
    },
    { user_id: USER },
  );
  const id = body(r).approval_id!;

  const denied = await decide(svc, id, 'deny');
  assert.equal(denied.http, 200);
  assert.equal(String((denied.body as Record<string, unknown>)['status']), 'denied');
  assert.equal(outboxCount(), before, '拒绝后 outbox/ 必须无新文件');
  assert.equal(svc.getApproval(id)!.decided, 'deny');

  const later = await decide(svc, id, 'approve');
  assert.equal(later.http, 409);
  assert.equal(
    String((later.body as Record<string, unknown>)['reason']),
    '用户已拒绝该调用',
  );
  assert.equal(outboxCount(), before);
});

test('用例 5 — 未知工具和非法参数被拒绝', async () => {
  const svc = freshService();

  const unknown = await svc.handleToolCall(
    { call_id: 'call_004', tool_name: 'nope', arguments: {} },
    { user_id: USER },
  );
  assert.equal(unknown.http, 400);
  assert.equal(body(unknown).decision, 'deny');
  assert.match(String(body(unknown).reason), /未知工具/);

  // 缺 to（required 未满足）
  const missing = await svc.handleToolCall(
    {
      call_id: 'call_005',
      tool_name: 'send_email',
      arguments: { subject: '作业链接', body: '这是本次作业的文档链接。' },
    },
    { user_id: USER },
  );
  assert.equal(missing.http, 400);
  assert.match(String(body(missing).reason), /参数非法/);
  assert.match(String(body(missing).reason), /arguments\.to/);

  // path 传数字
  const wrongType = await svc.handleToolCall(
    { call_id: 'call_005b', tool_name: 'read_note', arguments: { path: 123 } },
    { user_id: USER },
  );
  assert.equal(wrongType.http, 400);
  assert.match(String(body(wrongType).reason), /参数非法/);

  // 多余字段（additionalProperties: false）
  const extra = await svc.handleToolCall(
    { call_id: 'call_005c', tool_name: 'read_note', arguments: { path: 'todo.md', x: 1 } },
    { user_id: USER },
  );
  assert.equal(extra.http, 400);
  assert.match(String(body(extra).reason), /多余字段/);
});

test('用例 6 — 路径不能越过沙箱（../、绝对路径、盘符、ADS、NUL、符号链接）', async (t) => {
  const svc = freshService();
  const before = configBytes();

  const cases: Array<[string, string]> = [
    ['../', '../../config.json'],
    ['POSIX 绝对路径', '/etc/passwd'],
    ['Windows 盘符', 'C:\\Windows\\System32\\drivers\\etc\\hosts'],
    // 🔴 以下四种改前是 decision=allow（靠执行期 ENOENT 兜底，ADS 那条甚至真的读到了内容）。
    //    闸门 2 按段收紧后，它们在策略阶段就 deny。
    ['点点+空格段（Windows 会规范化成 ..）', '.. /web/promo.html'],
    ['纯点段 ....', '....//config.json'],
    ['NTFS ADS', 'todo.md::$DATA'],
    ['含 NUL', 'todo.md\u0000x'],
  ];
  for (const [label, p] of cases) {
    const r = await svc.handleToolCall(
      { call_id: `call_006_${label}`, tool_name: 'read_note', arguments: { path: p } },
      { user_id: USER },
    );
    assert.equal(r.http, 400, `${label} 必须被拒绝`);
    assert.equal(body(r).decision, 'deny');
    assert.equal(body(r).reason, '目标路径超出 sandbox/notes');
  }

  // 符号链接：前两道闸门都拦不住（路径里没有 .. 也不是绝对路径），只有 realpath 能挡
  const link = path.join(NOTES_DIR, 'link');
  if (trySymlink(path.join('..', '..', 'config.json'), link)) {
    try {
      const r = await svc.handleToolCall(
        { call_id: 'call_006_symlink', tool_name: 'read_note', arguments: { path: 'link' } },
        { user_id: USER },
      );
      assert.equal(r.http, 400);
      assert.equal(body(r).decision, 'deny');
      assert.match(String(body(r).reason), /目标路径超出 sandbox\/notes/);
      t.diagnostic('[✔] 第 3 道闸门已由「文件符号链接」实证');
    } finally {
      removeLink(link);
    }
  } else {
    // Windows 上建符号链接需要开发者模式/管理员 ⇒ 退化为**目录 junction**（不需要权限），
    // 同样能构造"realpath 后指向沙箱外"的情形 —— 🔴 目的是证明第 3 道闸门不是摆设
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside sandbox\n');
    const jlink = path.join(NOTES_DIR, 'link_out');
    if (tryDirJunction(outside, jlink)) {
      try {
        const r = await svc.handleToolCall(
          {
            call_id: 'call_006_junction',
            tool_name: 'read_note',
            arguments: { path: 'link_out/secret.txt' },
          },
          { user_id: USER },
        );
        assert.equal(r.http, 400, 'junction 指向沙箱外也必须被拒');
        assert.equal(body(r).decision, 'deny');
        assert.match(String(body(r).reason), /目标路径超出 sandbox\/notes/);
        t.diagnostic('[✔] 第 3 道闸门（realpath）已由「目录 junction」实证（本机不能建符号链接，退化方案）');
      } finally {
        removeLink(jlink);
        fs.rmSync(outside, { recursive: true, force: true });
      }
    } else {
      t.diagnostic(
        '[跳过] 符号链接 / junction 子用例：本机既不能建符号链接也不能建 junction。' +
          '⚠️ 第 3 道闸门**未在本机得到实证**（代码在 server/gateway/sandbox.ts，逻辑已实现）。',
      );
    }
  }

  assert.equal(configBytes(), before, '沙箱外文件必须字节未变');
});

test('用例 7 — 过期 / 重复确认 / 换用户 / 改参数 / 已拒绝 均被拒绝', async () => {
  // ---- 过期：注入可控时钟 ----
  resetAll();
  let clock = Date.parse('2026-10-11T10:00:00.000Z');
  const svc = new GatewayService({ now: () => clock });
  const r = await svc.handleToolCall(
    {
      call_id: 'call_001',
      tool_name: 'send_email',
      arguments: { to: 'mentor@example.com', subject: '作业链接', body: '这是本次作业的文档链接。' },
    },
    { user_id: USER },
  );
  const id = body(r).approval_id!;
  clock += 301_000; // 300s 有效期 + 1s
  const expired = await decide(svc, id, 'approve');
  assert.equal(expired.http, 409);
  assert.equal(String((expired.body as Record<string, unknown>)['reason']), '确认已过期');

  // ---- 换用户 ----
  resetAll();
  const svc2 = new GatewayService();
  const r2 = await svc2.handleToolCall(
    {
      call_id: 'call_001',
      tool_name: 'send_email',
      arguments: { to: 'mentor@example.com', subject: '作业链接', body: '这是本次作业的文档链接。' },
    },
    { user_id: USER },
  );
  const id2 = body(r2).approval_id!;
  const other = await decide(svc2, id2, 'approve', 'user_other');
  assert.equal(other.http, 409);
  assert.equal(String((other.body as Record<string, unknown>)['reason']), '确认者不是原用户');

  // ---- action 非法 ----
  const badAction = await decideWithAction(svc2, id2, 'maybe');
  assert.equal(badAction.http, 400);
  assert.match(String((badAction.body as Record<string, unknown>)['reason']), /action 非法/);

  // ---- 记录不存在 ----
  const ghost = await decide(svc2, 'approval_999', 'approve');
  assert.equal(ghost.http, 409);
  assert.equal(String((ghost.body as Record<string, unknown>)['reason']), '未找到待确认记录');

  // ---- 改参数（同 call_id，换了 path）----
  resetAll();
  const svc3 = new GatewayService();
  writeNote('report.txt', '报告草稿\n');
  const base = { call_id: 'call_900', tool_name: 'delete_note' };
  const ok = await svc3.handleToolCall(
    { ...base, arguments: { path: 'draft.txt' } },
    { user_id: USER },
  );
  await decide(svc3, body(ok).approval_id!, 'approve');
  const changed = await svc3.handleToolCall(
    { ...base, arguments: { path: 'report.txt' } },
    { user_id: USER },
  );
  assert.equal(changed.http, 409);
  assert.equal(body(changed).reason, '工具或参数发生变化');
  assert.ok(fs.existsSync(notePath('report.txt')), 'report.txt 必须还在（未被删除）');
});

test('用例 8 — 每次决定与执行均存在审计记录（7 个必需字段齐全）', async () => {
  const svc = freshService();

  // 制造 4 次请求：1 次 allow、1 次 pending、1 次 approve、1 次 deny
  await svc.handleToolCall(
    { call_id: 'call_002', tool_name: 'read_note', arguments: { path: 'todo.md' } },
    { user_id: USER },
  );
  const p1 = await svc.handleToolCall(
    {
      call_id: 'call_001',
      tool_name: 'send_email',
      arguments: { to: 'mentor@example.com', subject: '作业链接', body: '这是本次作业的文档链接。' },
    },
    { user_id: USER },
  );
  await decide(svc, body(p1).approval_id!, 'approve');

  const p2 = await svc.handleToolCall(
    { call_id: 'call_010', tool_name: 'delete_note', arguments: { path: 'draft.txt' } },
    { user_id: USER },
  );
  await decide(svc, body(p2).approval_id!, 'deny');

  const rows = readAudit();
  // 本用例共发出 5 次请求：3 次 /tool-calls + 2 次 /decision
  // ⇒ 一次 HTTP 请求**恰好一条**审计（§11 审计条数口径）
  assert.equal(rows.length, 5, '一次 HTTP 请求恰好一条审计（3 次 tool-calls + 2 次 decision）');

  for (const row of rows) {
    for (const f of [
      'ts',
      'user_id',
      'call_id',
      'tool_name',
      'decision',
      'approval_result',
      'execution_result',
    ] as const) {
      assert.ok(row[f] !== undefined && row[f] !== '', `审计字段 ${f} 必须非空`);
    }
    assert.ok(['allow', 'require_approval', 'deny'].includes(row.decision));
  }
  // 审计里不得出现邮件正文原文
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'server', 'data', 'audit.jsonl'), 'utf8');
  assert.ok(!raw.includes('这是本次作业的文档链接。'), 'detail 不得写入邮件正文原文');
});

test('端到端 — 走 HTTP 跑通题面要求的三个基础场景', async () => {
  const { base, close, service } = await startTestServer();
  try {
    const post = async (p: string, b: unknown, secret?: string) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (secret) headers['x-approval-secret'] = secret;
      const res = await fetch(base + p, {
        method: 'POST',
        headers,
        body: JSON.stringify(b),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    // 场景 1
    const s1 = await post('/tool-calls', {
      call_id: 'call_002',
      tool_name: 'read_note',
      arguments: { path: 'todo.md' },
      // 客户端塞进来的策略字段必须被忽略（用例 16）
      risk: 'read_only',
      requiresApproval: false,
    });
    assert.equal(s1.status, 200);
    assert.equal(s1.body['decision'], 'allow');
    assert.match(JSON.stringify(s1.body['result']), /buy milk/);

    // 场景 2
    const before = outboxCount();
    const s2 = await post('/tool-calls', {
      call_id: 'call_001',
      tool_name: 'send_email',
      arguments: { to: 'mentor@example.com', subject: '作业链接', body: '这是本次作业的文档链接。' },
    });
    assert.equal(s2.body['decision'], 'require_approval');
    assert.equal(outboxCount(), before, '确认前不得有邮件');

    const d2 = await post(
      `/approvals/${String(s2.body['approval_id'])}/decision`,
      { action: 'approve', user_id: USER },
      service.approvalSecret,
    );
    assert.equal(d2.status, 200);
    assert.equal(d2.body['status'], 'executed');
    assert.equal(outboxCount(), before + 1, '确认后才出现邮件文件');

    // 场景 3
    const cfgBefore = configBytes();
    const s3 = await post('/tool-calls', {
      call_id: 'call_003',
      tool_name: 'delete_note',
      arguments: { path: '../../config.json' },
    });
    assert.equal(s3.status, 400, 'deny 的 HTTP 码是 400，但响应体仍是完整 ToolCallResponse');
    assert.equal(s3.body['decision'], 'deny');
    assert.equal(s3.body['reason'], '目标路径超出 sandbox/notes');
    assert.equal(configBytes(), cfgBefore, '沙箱外文件不受影响');

    // GET /audit —— 用户通道：没令牌必须 401（审计里有别人的调用记录，不该给 Agent 看）
    const noToken = await fetch(base + '/audit');
    assert.equal(noToken.status, 401, '/audit 未带用户通道令牌必须 401');
    // 带上令牌后：本段共发出 4 次请求（3 次 tool-calls + 1 次 decision）
    const audit = await fetch(base + '/audit', {
      headers: { 'x-approval-secret': service.approvalSecret },
    });
    const rows = (await audit.json()) as unknown[];
    assert.equal(rows.length, 4, '每次请求都留下一条审计');
  } finally {
    await close();
  }
});

test('空产物自检 — 未重置就重跑会返回已存结果（说明为什么必须先 reset）', async () => {
  const svc = freshService();
  const call: ToolCall = {
    call_id: 'call_001',
    tool_name: 'send_email',
    arguments: { to: 'mentor@example.com', subject: '作业链接', body: '这是本次作业的文档链接。' },
  };
  const r1 = await svc.handleToolCall(call, { user_id: USER });
  await decide(svc, body(r1).approval_id!, 'approve');
  const after = outboxCount();

  // 同一调用再发一次 ⇒ 命中"已批准且已执行"⇒ 不重跑
  const r2 = await svc.handleToolCall(call, { user_id: USER });
  assert.equal(decisionOf(r2.body), 'allow');
  assert.match(String(body(r2).reason), /不重跑/);
  assert.equal(outboxCount(), after, '绝不重复产生副作用');
});

// ===========================================================================
// 第三轮修复的回归（2026-10-11）：HTTP 兜底 / 413 / 审计字段
// ===========================================================================

test('用例 20 — 请求体超过 1MB 返回 413，而不是把连接掐掉', async () => {
  const { base, close } = await startTestServer();
  try {
    const big = JSON.stringify({
      call_id: 'too_big',
      tool_name: 'read_note',
      arguments: { path: 'x'.repeat(1100 * 1024) },
    });
    const res = await fetch(base + '/tool-calls', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big,
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(res.status, 413, '超限必须是 413 JSON（改前先 req.destroy() ⇒ 客户端只拿到 fetch failed）');
    const bodyObj = (await res.json()) as Record<string, unknown>;
    assert.match(String(bodyObj['error']), /上限/);
  } finally {
    await close();
  }
});

test('用例 21 — 持久化锁被占用时返回 503，既不挂死也不打挂进程（P0 回归）', async () => {
  const { base, close } = await startTestServer();
  const lock = path.join(REPO_ROOT, 'server', 'data', 'approvals.json.lock');
  fs.writeFileSync(lock, 'held-by-another-process', 'utf8'); // 人造"别的进程正持锁"
  try {
    const res = await fetch(base + '/tool-calls', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        call_id: 'lock_001',
        tool_name: 'send_email',
        arguments: { to: 'mentor@example.com', subject: '作业链接', body: '这是本次作业的文档链接。' },
      }),
      // 改前这里会一直挂着，客户端只能自己超时；锁等待上限 1.5s + 余量
      signal: AbortSignal.timeout(6000),
    });
    assert.equal(res.status, 503, '锁超时必须兜底成 503');
    const bodyObj = (await res.json()) as Record<string, unknown>;
    assert.match(String(bodyObj['error']), /暂时不可用/);
    assert.equal(outboxCount(), 0, '失败请求不得产生副作用');
  } finally {
    fs.rmSync(lock, { force: true });
    await close();
  }
});

test('用例 22 — 畸形请求（缺 call_id / tool_name）也留下非空审计字段', async () => {
  const svc = freshService();
  const r = await svc.handleToolCall(
    { call_id: '', tool_name: '', arguments: {} },
    { user_id: USER },
  );
  assert.equal(r.http, 400);
  const row = readAudit().at(-1)!;
  assert.equal(row.call_id, '(missing)', 'call_id 必须非空（改前是空串）');
  assert.equal(row.tool_name, '(missing)', 'tool_name 必须非空（改前是空串）');
  assert.equal(row.decision, 'deny');
});
