// server/tools/delete_note.ts —— 删笔记（销毁性；目标状态一致）
import fs from 'node:fs';
import { resolveInSandbox } from '../gateway/sandbox.ts';
import type { ToolImpl } from '../gateway/types.ts';

export const delete_note: ToolImpl = async (args) => {
  const raw = String(args['path'] ?? '');
  const p = resolveInSandbox('sandbox/notes', raw);
  if (!p.ok) throw new Error(`沙箱拒绝: ${p.reason}`);
  try {
    fs.rmSync(p.abs);
  } catch (e) {
    // 🔴 目标状态一致：文件本就不存在（ENOENT）也算删除成功。
    //    否则超时重试会因"文件已被删"而报错，registry 里标的 idempotent 就不成立（§4.9 / §11）。
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw e;
  }
  return { deleted: raw };
};
