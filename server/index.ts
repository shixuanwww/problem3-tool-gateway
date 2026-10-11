// ============================================================================
// server/index.ts —— HTTP 入口（node:http，零依赖）
//
// 端点：
//   POST /tool-calls                          ← Client 提交 ToolCall
//   POST /approvals/{approval_id}/decision    ← 用户确认/拒绝（只能由 Client 根据用户实际操作发起）
//   GET  /audit[?call_id=]                    ← 便于演示/测试（同样走用户通道，需令牌）
//   GET  /health
//
// 🔴 两个通道的认证口径（P1；第三轮审核收紧为"只认请求头"）：
//   · Agent 通道（POST /tool-calls）**不要求**令牌 —— Agent 本来就只负责提出调用；
//   · 用户通道（POST /approvals/{id}/decision、GET /audit）**必须**携带
//     `x-approval-secret` **请求头**，令牌由 Gateway 生成、只给用户侧 Client。
//   这样模型 / 被提示词注入的调用无法自己 approve 自己。
//
// 🔴 **只认请求头，不认请求体**（第三轮审核收紧，改前允许 body `approval_secret`）：
//    令牌是"持有者即用户"的凭证；一旦允许它躺在请求体里，就会跟着请求体一起进
//    日志 / 抓包 / 回放记录，而**请求体恰恰是 Agent 唯一能自由构造的地方** ——
//    等于把用户通道的边界建在对手手里。请求体里出现 `approval_secret` 一律忽略
//    （与 §4.1「忽略客户端提交的策略字段」同源）。
//
// 🔴 错误码口径：业务拒绝仍是 400 / 409；**401** 专用于"用户通道没通过认证"；
//    **413** = 请求体超 1MB；**503** = 持久化锁竞争/磁盘错误的兜底（非策略决定）。
//    响应体**仍然是完整的 ToolCallResponse / 错误对象**
//    ⇒ Client 与测试必须"先解析响应体，再看状态码"，不能 `if (!res.ok) throw`。
// ============================================================================

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { GatewayService } from './gateway/service.ts';
import { readAudit } from './gateway/audit.ts';
import { secretMatches } from './gateway/secret.ts';
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

type BodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: string; tooLarge?: boolean };

/**
 * 手写 body 收集（限制 1MB）。
 *
 * 🔴 超限时**不能**先 `req.destroy()`：那会直接把 socket 掐掉，客户端只能拿到
 *    `fetch failed` / ECONNRESET，永远收不到我们承诺的 413。这里改成把结果返回给
 *    上层，由上层写响应；剩余 body 交给 Node 自己丢弃。
 */
function readBody(req: http.IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = (r: BodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, reason: `请求体超过 ${MAX_BODY_BYTES} 字节上限`, tooLarge: true });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, reason: '请求体读取失败' }));
  });
}

/**
 * 用户通道令牌：**只认 `x-approval-secret` 请求头**。
 *
 * 🔴 请求体里的 `approval_secret` 故意不读（理由见文件头）。
 * ⚠️ 不做"多值/重复头"解析：重复头会被 Node 折成逗号串，长度必然不等 ⇒ 直接判不匹配。
 */
function approvalSecretOf(req: http.IncomingMessage): string | undefined {
  const h = req.headers['x-approval-secret'];
  return typeof h === 'string' ? h : undefined;
}

async function handleRequest(
  service: GatewayService,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  // ---- GET /health ----
  if (req.method === 'GET' && pathname === '/health') {
    return json(res, 200, { ok: true });
  }

  // ---- GET /audit（用户/运维通道：要令牌，否则 Agent 能读到别人的调用记录）----
  if (req.method === 'GET' && pathname === '/audit') {
    if (!secretMatches(service.approvalSecret, approvalSecretOf(req))) {
      return json(res, 401, {
        error: '需要用户会话令牌：请带 x-approval-secret 头（值见 server/data/approval-secret）',
      });
    }
    const callId = url.searchParams.get('call_id') || undefined;
    return json(res, 200, readAudit(callId));
  }

  // ---- POST /tool-calls ----
  if (req.method === 'POST' && pathname === '/tool-calls') {
    const raw = await readBody(req);
    if (!raw.ok) return json(res, raw.tooLarge ? 413 : 400, { error: raw.reason });

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
    if (!raw.ok) return json(res, raw.tooLarge ? 413 : 400, { error: raw.reason });

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
      approval_secret: approvalSecretOf(req),
    });
    return json(res, out.http, out.body);
  }

  return json(res, 404, { error: `未知端点: ${req.method} ${pathname}` });
}

/**
 * 供测试复用：创建 server（不 listen）。
 * 测试用 `createHttpServer().listen(0)` 起在随机端口，**不派生子进程**。
 *
 * 🔴 整个请求处理包在 try/catch 里：持久化锁竞争 / 磁盘错误会从 handleToolCall
 *    抛出来（`withStateLock` 超时就是其中之一）。若不接住，async handler 的
 *    rejection 会让请求**永久挂起**（客户端只能自己超时），并且按 Node 默认策略
 *    直接**打挂进程**。这里兜底成 503 + stderr 日志。
 */
export function createHttpServer(service: GatewayService = new GatewayService()): http.Server {
  return http.createServer((req, res) => {
    void handleRequest(service, req, res).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[gateway] 请求处理异常（${req.method} ${req.url}）：${message}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, 503, {
        error: '服务暂时不可用（内部错误或持久化锁竞争），请稍后重试',
        detail: message,
      });
    });
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
  // 🔴 只绑回环地址：改前 `listen(port)` 会监听所有网卡，把带副作用的 Gateway 暴露到局域网。
  createHttpServer(service).listen(port, '127.0.0.1', () => {
    console.log(`[gateway] listening on http://127.0.0.1:${port}`);
    console.log(`[gateway] node ${process.version}（需 ≥22.6，且必须带 --experimental-strip-types）`);
    // 用户通道令牌只打印在**服务端终端**（并落在 server/data/approval-secret）。
    // 它不会出现在任何 /tool-calls 响应里，所以 Agent 拿不到。
    console.error(
      `[gateway] 用户确认通道令牌（Client 自动读取 server/data/approval-secret）：${service.approvalSecret}`,
    );
  });
}
