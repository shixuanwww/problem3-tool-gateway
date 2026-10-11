// ============================================================================
// server/gateway/sandbox.ts —— 沙箱路径校验（§4.4，三道闸门，缺一不可）
//
// 为什么需要三道：题面点名三种绕过方式（绝对路径 / `../` / 符号链接），
// 前两道拦不住"路径里没有 .. 也不是绝对路径、但指向沙箱外"的**符号链接**，
// 只有 realpath 能挡住。所以三道都要有。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 🔴 REPO_ROOT 必须由**模块位置**推导，禁止 process.cwd()
//    server/gateway/sandbox.ts + '../..' ⇒ 仓库根
//    （写成 '../../..' 会得到仓库的父目录）
const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/server/gateway
export const REPO_ROOT = path.resolve(HERE, '..', '..'); // <repo>
export const DATA_DIR = path.join(REPO_ROOT, 'server', 'data');
export const SANDBOX_DIR = path.join(REPO_ROOT, 'sandbox');

export type SandboxResult = { ok: true; abs: string } | { ok: false; reason: string };

const WIN_DRIVE = /^[A-Za-z]:/;

/** 对可能不存在的路径做 realpath：找到最近的已存在祖先再拼回剩余部分 */
function realpathAllowingMissing(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length > 0 ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // 退化：整条链都不存在
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function isStrictlyInside(target: string, root: string): boolean {
  const t = path.resolve(target);
  const r = path.resolve(root);
  return t !== r && t.startsWith(r + path.sep);
}

/**
 * @param root     相对仓库根的白名单根目录，如 "sandbox/notes"
 * @param userPath 请求里传来的 path 参数（**不可信**）
 */
export function resolveInSandbox(root: string, userPath: string): SandboxResult {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    return { ok: false, reason: 'path 必须是非空字符串' };
  }

  // ---- 闸门 0：拒绝控制字符（NUL 会一路穿过 path.resolve，最后在 fs 层才炸）----
  // 注意：JSON 里可以用 \u0000 表达 NUL，所以这不是理论问题。
  if (/[\u0000-\u001f]/.test(userPath)) {
    return { ok: false, reason: `路径包含控制字符（如 NUL）` };
  }

  // ---- 闸门 1：拒绝绝对路径（POSIX 绝对路径 + Windows 盘符 + UNC）----
  if (path.isAbsolute(userPath) || WIN_DRIVE.test(userPath) || /^\\\\/.test(userPath)) {
    return { ok: false, reason: `拒绝绝对路径: ${userPath}` };
  }
  // Windows 上 path.isAbsolute('/etc/passwd') 为 true，双保险再判一次前导分隔符
  if (userPath.startsWith('/') || userPath.startsWith('\\')) {
    return { ok: false, reason: `拒绝绝对路径: ${userPath}` };
  }

  // ---- 闸门 2：按**段**拒绝穿越形态（在归一化之前查，避免被 resolve 吞掉）----
  // 两种都要拦，不只看开头：
  //   ① 只由点/空格组成的段：'.' 是当前目录（放行），其余（".." / "..." / ".. " / " ."…）
  //      在任何平台都不是合法文件名 —— Windows 会把段末尾的点与空格规范化掉，
  //      所以 ".. " 这类写法语义上等价于 ".."。"./todo.md" 这种正常写法仍然放行。
  //   ② ':' 是 Windows 的 ADS 分隔符 ⇒ "todo.md::$DATA" 会绕过"只读这个文件"的直觉
  //      （实测改前这条路径返回 200 allow executed）。
  const segments = userPath.split(/[\\/]+/);
  for (const seg of segments) {
    if (seg === '') continue;
    if (/^[ .]+$/.test(seg) && seg !== '.') {
      return { ok: false, reason: `路径包含可疑的点/空格段: ${userPath}` };
    }
    if (seg.includes(':')) {
      return { ok: false, reason: `路径段包含非法字符 ':': ${userPath}` };
    }
  }

  // ---- 闸门 3：归一化 + realpath + 前缀比对 ----
  const rootAbs = path.resolve(REPO_ROOT, root);
  const abs = path.resolve(rootAbs, userPath);

  // 3a 字符串前缀（防御性，先挡掉明显越界的）
  if (!isStrictlyInside(abs, rootAbs)) {
    return { ok: false, reason: `越出白名单目录 ${root}` };
  }

  // 3b realpath（处理符号链接 / junction）
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(rootAbs);
  } catch {
    return { ok: false, reason: `白名单目录不存在: ${root}` };
  }
  const realTarget = realpathAllowingMissing(abs);
  if (!isStrictlyInside(realTarget, realRoot)) {
    return {
      ok: false,
      reason: `realpath 后越出白名单目录 ${root}（疑似符号链接指向外部）`,
    };
  }

  return { ok: true, abs };
}
