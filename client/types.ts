// client/types.ts —— Client 侧的**最小子集**契约
// Client 是独立进程（未来可能换成别的语言/运行时），所以不跨目录 import 服务端类型。
// 来源：server/gateway/types.ts（此处只复制用得到的字段，字段含义以那边为准）。
export type Decision = 'allow' | 'require_approval' | 'deny';

export interface ToolCall {
  call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  user_id?: string;
}

export interface ToolCallResponse {
  call_id: string;
  decision: Decision;
  status: 'executed' | 'pending' | 'denied' | 'failed';
  reason?: string;
  approval_id?: string;
  result?: unknown;
}
