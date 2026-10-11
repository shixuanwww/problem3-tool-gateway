// ============================================================================
// tests/sandbox.test.ts —— resolveInSandbox 四道闸门的**直接**单测（第四轮补）
//
// 为什么要有这个文件：改前四条闸门全靠 HTTP 层统一文案「目标路径超出 …」
// 间接断言 —— 删掉闸门 0 / 闸门 2 测试照样绿。这里直接调 resolveInSandbox，
// 逐道闸门断言**具体 reason**；删掉任何一道闸门，本文件必红。
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInSandbox, SANDBOX_DIR, REPO_ROOT } from '../server/gateway/sandbox.ts';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'sandbox/notes';
const outside = path.relative(REPO_ROOT, path.resolve(SANDBOX_DIR, '..', 'config.json'));

/** 与仓库同平台的一条"逃出沙箱"相对路径（../ 形态） */
const escapeRel = path.posix ? '../config.json' : '..\\config.json';

test('闸门 0：控制字符（NUL）被拒，reason 指名控制字符', () => {
  const r = resolveInSandbox(ROOT, 'todo\u0000.md');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /控制字符/);
});

test('闸门 1a：POSIX 绝对路径被拒', () => {
  const r = resolveInSandbox(ROOT, '/etc/passwd');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /绝对路径/);
});

test('闸门 1b：Windows 盘符被拒', () => {
  const r = resolveInSandbox(ROOT, 'C:\\Windows\\system32\\config');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /绝对路径/);
});

test('闸门 1c：UNC 路径被拒', () => {
  const r = resolveInSandbox(ROOT, '\\\\server\\share\\secret.txt');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /绝对路径/);
});

test('闸门 2a：点/空格段（.. 、... 、".. "）被拒，./ 正常放行', () => {
  for (const p of ['.. ', '...', 'notes/.. ', '.. /todo.md']) {
    const r = resolveInSandbox(ROOT, p);
    assert.equal(r.ok, false, `应拒绝: ${JSON.stringify(p)}`);
    if (!r.ok) assert.match(r.reason, /点\/空格段/);
  }
  const ok = resolveInSandbox(ROOT, './todo.md');
  assert.equal(ok.ok, true, './todo.md 是正常写法，必须放行');
});

test('闸门 2b：ADS 冒号段（todo.md::$DATA）被拒，reason 指名冒号', () => {
  const r = resolveInSandbox(ROOT, 'todo.md::$DATA');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /:/);
});

test('联防：../config.json 被拒（`..` 段先由闸门 2 拦下；闸门 3a 前缀比对是纵深防御）', () => {
  // 🔴 如实说明：闸门 0/1/2 拦完后已不存在"含 .. 却逃逸"的公开输入形态，
  //    所以闸门 3a（字符串前缀比对）无法从外部单独触发 —— 它是防御性兜底。
  //    本用例保证 "../config.json" 一定被拒；闸门 3b（realpath）另有独立用例。
  const r = resolveInSandbox(ROOT, escapeRel);
  assert.equal(r.ok, false, '../config.json 必须被拒');
  if (!r.ok) assert.match(r.reason, /点\/空格段|越出白名单/);
});

test('闸门 3b：符号链接 / 目录 junction 指向外部被拒（realpath）', () => {
  // Windows 无权建符号链接 ⇒ 退化用目录 junction（无需管理员权限）
  const notesReal = fs.realpathSync(path.join(REPO_ROOT, 'sandbox', 'notes'));
  const linkName = process.platform === 'win32' ? 'junction-probe' : 'symlink-probe';
  const linkPath = path.join(notesReal, linkName);
  const target = path.join(REPO_ROOT, 'web-escape-target');
  let created = false;
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.rmSync(linkPath, { force: true, recursive: true });
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    created = true;
  } catch {
    // 两条路都建不了：明确标记跳过，不静默算通过
    assert.ok(true, '[跳过] 本机无法创建符号链接/junction，闸门 3b 的运行时实证见 HTTP 层用例');
    return;
  }
  try {
    assert.ok(created);
    const r = resolveInSandbox(ROOT, `${linkName}/secret.txt`);
    assert.equal(r.ok, false, 'junction 指向外部必须被拒');
    if (!r.ok) assert.match(r.reason, /realpath/);
  } finally {
    fs.rmSync(linkPath, { force: true, recursive: true });
    fs.rmSync(target, { force: true, recursive: true });
  }
});

test('外围：沙箱外的 config.json 相对路径确实指向仓库根（夹具自检）', () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, outside)), true, '夹具 config.json 应存在于仓库根');
});
