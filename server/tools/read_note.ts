// server/tools/read_note.ts —— 读笔记（只读）
import fs from 'node:fs';
import { resolveInSandbox } from '../gateway/sandbox.ts';
import type { ToolImpl } from '../gateway/types.ts';

export const read_note: ToolImpl = async (args) => {
  const raw = String(args['path'] ?? '');
  // 纵深防御：工具自己也再走一遍沙箱校验，上层漏了也不会越界
  const p = resolveInSandbox('sandbox/notes', raw);
  if (!p.ok) throw new Error(`沙箱拒绝: ${p.reason}`);
  return { content: fs.readFileSync(p.abs, 'utf8') };
};

/** 沙箱根（供执行器/文档引用，避免字面量散落） */
export const READ_NOTE_ROOT = 'sandbox/notes';
