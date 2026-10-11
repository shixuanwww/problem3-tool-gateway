// ============================================================================
// server/index.ts —— HTTP 入口（node:http，零依赖）
//
// 端点：
//   POST /tool-calls                          ← Client 提交 ToolCall
//   POST /approvals/{approval_id}/decision    ← 用户确认/拒绝（只能由 Client 根据用户实际操作发起）
//   GET  /audit[?call_id=]                    ← 便于演示/测试
//   GET  /health
//
// 🔴 错误码口径（§11）：只用 400 / 409；响应体**仍然是完整的 ToolCallResponse / 错误对象**
//    ⇒ Client 与测试必须"先解析响应体，再看状态码"，不能 `if (!res.ok) throw`。
// ============================================================================

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { GatewayService } from './gateway/service.ts';
import { readAudit } from './gateway/audit.ts';
import type { ToolCall } from './gateway/types.ts';

const MAX_BODY_BYTES = 1024 * 1024; // 1MB（§11）

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** 手写 body 收集（限制 1MB，超出即拒绝） */
function readBody(req: http.IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve({ ok: false, reason: '请求体超过 1MB 上限' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ ok: false, reason: '请求体读取失败' }));
  });
}

/**
 * 供测试复用：创建 server（不 listen）。
 * 测试用 `createHttpServer().listen(0)` 起在随机端口，**不派生子进程**。
 */
export function createHttpServer(service: GatewayService = new GatewayService()): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    // ---- GET /health ----
    if (req.method === 'GET' && pathname === '/health') {
      return json(res, 200, { ok: true });
    }

    // ---- GET /audit ----
    if (req.method === 'GET' && pathname === '/audit') {
      const callId = url.searchParams.get('call_id') ?? undefined;
      return json(res, 200, readAudit(callId ?? undefined));
    }

    // ---- POST /tool-calls ----
    if (req.method === 'POST' && pathname === '/tool-calls') {
      const raw = await readBody(req);
      if (!raw.ok) return json(res, 400, { error: raw.reason });

      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw.text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return json(res, 400, { error: '请求体必须是 JSON 对象' });
        }
        body = parsed as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: 'JSON 解析失败' });
      }

      // 🔴 user_id 由 Client 注入；Agent 不得覆盖（请求体里带了也忽略，用默认值）
      const user_id = 'user_default';
      const call: ToolCall = {
        call_id: String(body['call_id'] ?? ''),
        tool_name: String(body['tool_name'] ?? ''),
        arguments:
          typeof body['arguments'] === 'object' && body['arguments'] !== null && !Array.isArray(body['arguments'])
            ? (body['arguments'] as Record<string, unknown>)
            : ({} as Record<string, unknown>),
      };

      const out = await service.handleToolCall(call, { user_id, rawBody: body });
      return json(res, out.http, out.body);
    }

    // ---- POST /approvals/{approval_id}/decision ----
    const m = /^\/approvals\/([^/]+)\/decision$/.exec(pathname);
    if (req.method === 'POST' && m) {
      const approvalId = decodeURIComponent(m[1]);
      const raw = await readBody(req);
      if (!raw.ok) return json(res, 400, { error: raw.reason });

      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw.text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return json(res, 400, { error: '请求体必须是 JSON 对象' });
        }
        body = parsed as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: 'JSON 解析失败' });
      }

      const out = await service.handleDecision(approvalId, {
        action: typeof body['action'] === 'string' ? body['action'] : undefined,
        user_id: typeof body['user_id'] === 'string' ? body['user_id'] : 'user_default',
      });
      return json(res, out.http, out.body);
    }

    return json(res, 404, { error: `未知端点: ${req.method} ${pathname}` });
  });
}

// ---- 直接运行时才 listen ----
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const portArgIdx = process.argv.indexOf('--port');
  const port =
    portArgIdx >= 0 && process.argv[portArgIdx + 1]
      ? Number(process.argv[portArgIdx + 1])
      : 8787; // §11 默认端口
  const service = new GatewayService();
  createHttpServer(service).listen(port, () => {
    console.log(`[gateway] listening on http://127.0.0.1:${port}`);
    console.log(`[gateway] node ${process.version}（需 ≥22.6，且必须带 --experimental-strip-types）`);
  });
}
