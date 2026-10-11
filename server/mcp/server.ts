// ============================================================================
// server/mcp/server.ts —— MCP 接入（Challenge 1）
//
// 零依赖手写：**stdio + 换行分隔 JSON**（newline-delimited JSON-RPC 2.0）。
// ⚠️ 注意：不是 LSP 那种 `Content-Length` 头 framing。手测：
//     printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node --experimental-strip-types server/mcp/server.ts
//
// 🔴 不可妥协的一点：`tools/call` **必须调用同一个 `GatewayService.handleToolCall`**，
//    不得因为"换成 MCP"就绕开参数校验与确认流程。
// 🔴 `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`
//    在任何代码路径中**都不得参与决策** —— 它们只是行为提示（用例 17）。
// ============================================================================

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { GatewayService } from '../gateway/service.ts';
import { hashOfCall } from '../gateway/canonical.ts';
import type { McpToolDescriptor, ToolDef } from '../gateway/types.ts';

export const MCP_PROTOCOL_VERSION = '2026-07-28'; // §11：照题面参考资料的 MCP 版本写死

const ANNOTATION_NOTE = '（提示：annotations 仅为工具行为提示，权限一律以 Gateway 判定为准）';

/** 由 ToolDef 推导 MCP 工具描述符。`lie` 用于演示"annotation 不参与决策" */
export function toolDescriptors(
  defs: ToolDef[],
  lie?: { readOnlyHint?: Record<string, boolean> },
): McpToolDescriptor[] {
  return defs.map((d) => ({
    name: d.name,
    description: d.description + ANNOTATION_NOTE,
    inputSchema: d.inputSchema,
    annotations: {
      readOnlyHint: lie?.readOnlyHint?.[d.name] ?? d.risk === 'read_only',
      destructiveHint: d.risk === 'destructive',
      idempotentHint: d.idempotency === 'idempotent',
      openWorldHint: d.risk === 'external_side_effect',
    },
  }));
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcOk(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcErr(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export interface McpOptions {
  service?: GatewayService;
  /** 演示用：强制给某些工具塞一个**错误**的 readOnlyHint，证明它不影响决策 */
  lie?: { readOnlyHint?: Record<string, boolean> };
  user_id?: string;
}

/**
 * 纯函数式处理一条 JSON-RPC 消息 —— 抽出来是为了让测试**无需派生子进程**即可覆盖 MCP 路径。
 */
export async function handleMcpMessage(
  msg: JsonRpcRequest,
  opts: McpOptions = {},
): Promise<Record<string, unknown> | null> {
  const service = opts.service ?? new GatewayService();
  const user_id = opts.user_id ?? 'user_default';
  const id = msg?.id ?? null;

  switch (msg?.method) {
    case 'initialize':
      return rpcOk(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-tool-gateway', version: '1.0.0' },
      });

    case 'notifications/initialized':
      return null; // 通知，无需响应

    case 'tools/list':
      return rpcOk(id, { tools: toolDescriptors(service.listToolDefs(), opts.lie) });

    case 'tools/call': {
      const p = (msg.params ?? {}) as Record<string, unknown>;
      const name = String(p['name'] ?? '');
      const args = (p['arguments'] ?? {}) as Record<string, unknown>;
      const meta = (p['_meta'] ?? {}) as Record<string, unknown>;

      // 🔴 call_id 与 (tool_name, arguments) 一一绑定（§11 不变量）：
      //    MCP 没有 call_id 概念，所以按键值**确定性派生** ⇒ 重发同一调用会得到同一 call_id，
      //    从而能复用两阶段确认（§4.8）；换参数会得到新 call_id，不会被误判为"参数变化"。
      const call_id =
        typeof meta['call_id'] === 'string'
          ? (meta['call_id'] as string)
          : `mcp_${hashOfCall(name, args).slice('sha256:'.length, 'sha256:'.length + 16)}`;

      const out = await service.handleToolCall(
        { call_id, tool_name: name, arguments: args },
        { user_id },
      );
      const body = out.body as Record<string, unknown>;

      if (body['decision'] === 'deny') {
        return rpcOk(id, {
          content: [{ type: 'text', text: `拒绝执行：${String(body['reason'] ?? '')}` }],
          isError: true,
        });
      }
      if (body['decision'] === 'require_approval') {
        // MCP 是同步请求-响应，没有交互通道问用户 ⇒ 两阶段：
        //   ① 用户走 HTTP 端点 `POST /approvals/{approval_id}/decision` 确认/拒绝
        //      （handleDecision 在文件锁内会先合并磁盘状态，因此**跨进程**也看得见这条记录）；
        //   ② 确认执行成功之后，客户端以**同一 call_id 重发** tools/call，
        //      这次命中"已获确认并执行完毕"分支，直接取回结果。
        // 🔴 只"重发"不确认是不会执行的 —— 重发只会拿回同一条待确认记录（approval_id 不变）。
        // 🔴 用户通道令牌（P1）：确认请求还必须带 `x-approval-secret`。它**故意不在这里回传**
        //    —— Agent/模型拿不到它，只有用户侧的 Client 持有（server/data/approval-secret）。
        return rpcOk(id, {
          content: [
            {
              type: 'text',
              text:
                `该调用需要用户确认，Gateway 未执行任何操作。approval_id=${String(body['approval_id'] ?? '')}。\n` +
                `请用户通过 POST /approvals/${String(body['approval_id'] ?? '')}/decision ` +
                `选择 {"action":"approve"|"deny","user_id":"<原用户>"}；\n` +
                `该请求必须携带用户通道令牌头 x-approval-secret（由用户侧 Client 持有，` +
                `存在 server/data/approval-secret，不在本响应中回传）。\n` +
                `确认成功后，以**同一 call_id** 重发本次 tools/call 即可取回执行结果` +
                `（call_id=${call_id}）。\n` +
                `🔴 annotation 中的 readOnlyHint 等不作为权限依据。`,
            },
          ],
          isError: true,
        });
      }
      return rpcOk(id, {
        content: [{ type: 'text', text: JSON.stringify(body['result'] ?? null) }],
        isError: false,
      });
    }

    default:
      return rpcErr(id, -32601, `Method not found: ${String(msg?.method ?? '')}`);
  }
}

/** stdio 主循环 */
export function startStdioServer(opts: McpOptions = {}): void {
  // 🔴 整个 stdio 会话**只用一个** GatewayService 实例。
  //    若写成"每条消息 new 一个"（本文件早先的写法），approvals 的内存 Map 每条消息都重建，
  //    与 HTTP Gateway 更不是"同一个 Gateway"；而且每次构造都 loadState()，
  //    两个进程各自 persistState() 会互相覆盖 —— 直接违背题面
  //    "MCP 请求仍然必须经过**同一个** Gateway"的要求。
  const service = opts.service ?? new GatewayService();
  const sessionOpts: McpOptions = { ...opts, service };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (text === '') return;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(text) as JsonRpcRequest;
    } catch {
      process.stdout.write(JSON.stringify(rpcErr(null, -32700, 'Parse error')) + '\n');
      return;
    }
    void handleMcpMessage(msg, sessionOpts).then((resp) => {
      if (resp !== null) process.stdout.write(JSON.stringify(resp) + '\n');
    });
  });
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  // --lie-annotations：演示用（故意把 send_email 标成 readOnlyHint: true）
  const lie = process.argv.includes('--lie-annotations')
    ? { readOnlyHint: { send_email: true, delete_note: true } }
    : undefined;
  startStdioServer({ lie });
}
