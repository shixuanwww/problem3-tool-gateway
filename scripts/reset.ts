// ============================================================================
// scripts/reset.ts —— 演示与测试前的**唯一**重置入口
//
// 为什么必做（§9 第 0 步）：approvals.json / executions.jsonl 是**落盘**的，且
// §4.3 步骤 4 ① 规定"命中已批准且已执行的同一调用 → 直接返回已存结果、不重跑"。
// 所以不重置就跑第二遍时，场景 2 不会再进入"等待确认"，outbox/ 也不会新增文件 ——
// 而题面明确要求演示"确认前无邮件、确认后才出现邮件文件"的对比。
//
// 做三件事：
//   1 清空 server/data/*.json / *.jsonl（含 .corrupt-* 现场）
//   2 清空 sandbox/outbox/*.json（保留 .gitkeep）
//   3 把 sandbox/notes/ 恢复为**初始夹具**（只清不建会让场景 1 与用例 1 在重置后必红）
// 🔴 **不触碰**仓库根 config.json（场景 3 要用它证明"沙箱外文件不受影响"）
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

const DATA_DIR = path.join(REPO_ROOT, 'server', 'data');
const OUTBOX_DIR = path.join(REPO_ROOT, 'sandbox', 'outbox');
const NOTES_DIR = path.join(REPO_ROOT, 'sandbox', 'notes');

/** 初始夹具：todo.md 的内容与题面示例的返回值（"buy milk"）呼应 */
export const INITIAL_NOTES: Record<string, string> = {
  'todo.md': 'buy milk\n',
  'draft.txt':
    '这是一份草稿，用来演示「用户确认 delete_note(path="draft.txt") 之后，\n' +
    'Agent 不能把参数改成 report.txt 并继续复用原来的确认」。\n',
};

export function resetAll(): void {
  // 1) 运行期状态
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (/\.(json|jsonl|tmp)$/.test(f) || f.includes('.corrupt-')) {
      fs.rmSync(path.join(DATA_DIR, f), { force: true });
    }
  }

  // 2) 邮件落点
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUTBOX_DIR)) {
    if (f.endsWith('.json')) fs.rmSync(path.join(OUTBOX_DIR, f), { force: true });
  }

  // 3) 笔记夹具
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  for (const f of fs.readdirSync(NOTES_DIR)) {
    if (f !== '.gitkeep') fs.rmSync(path.join(NOTES_DIR, f), { recursive: true, force: true });
  }
  for (const [name, content] of Object.entries(INITIAL_NOTES)) {
    fs.writeFileSync(path.join(NOTES_DIR, name), content, 'utf8');
  }
}

/** 只清 outbox（用例 2/3/13 需要"前后文件数对比"时用） */
export function clearOutbox(): void {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUTBOX_DIR)) {
    if (f.endsWith('.json')) fs.rmSync(path.join(OUTBOX_DIR, f), { force: true });
  }
}

export function listOutbox(): string[] {
  try {
    return fs.readdirSync(OUTBOX_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  resetAll();
  console.log('[reset] 已重置：');
  console.log('  · server/data/*.json|*.jsonl —— 清空（approvals / audit / executions）');
  console.log('  · sandbox/outbox/*.json —— 清空（保留 .gitkeep）');
  console.log(
    `  · sandbox/notes/ —— 恢复初始夹具：${Object.keys(INITIAL_NOTES).join(', ')}`,
  );
  console.log('  · 仓库根 config.json —— **未触碰**（场景 3 需要它证明沙箱外文件不受影响）');
}
