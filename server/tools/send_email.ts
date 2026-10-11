// server/tools/send_email.ts —— 模拟发信（不连真实邮件服务，写 JSON 文件）
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../gateway/sandbox.ts';
import type { ToolImpl } from '../gateway/types.ts';

export const send_email: ToolImpl = async (args, ctx) => {
  const to = String(args['to'] ?? '');
  const subject = String(args['subject'] ?? '');
  const body = String(args['body'] ?? '');

  // 🔴 message_id 由 Gateway 生成、**不进 arguments**（§4.5）⇒ 同一份参数永远算出同一个 hash
  const message_id = ctx.nextMailId();
  const outbox = path.join(REPO_ROOT, 'sandbox', 'outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const fileName = `${message_id}.json`;
  fs.writeFileSync(
    path.join(outbox, fileName),
    JSON.stringify({ to, subject, body }, null, 2) + '\n',
    'utf8',
  );

  return { message_id, stored_at: `sandbox/outbox/${fileName}` };
};
