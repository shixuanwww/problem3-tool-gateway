// server/tools/index.ts —— 工具实现的汇总（barrel），并给执行器一份可注入的默认表
import { read_note } from './read_note.ts';
import { delete_note } from './delete_note.ts';
import { send_email } from './send_email.ts';
import { read_webpage } from './read_webpage.ts';
import type { ToolImpl } from '../gateway/types.ts';

export { read_note, delete_note, send_email, read_webpage };

/** 默认工具实现表。Executor 接受同形状的替身 ⇒ 用例 19 的超时桩靠它注入（不引入环境变量）。 */
export const builtinTools: Record<string, ToolImpl> = {
  read_note,
  delete_note,
  send_email,
  read_webpage,
};
