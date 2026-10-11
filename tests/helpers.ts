// tests/helpers.ts —— 测试公共件
//
// 🔴 测试隔离（§11）：**每个用例前后都要重置** outbox / approvals / executions，
//    否则用例 3 / 13 的"恰好 1 个文件"会不稳定。这是最容易写红的地方。
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { GatewayService, type GatewayOptions } from '../server/gateway/service.ts';
import { createHttpServer } from '../server/index.ts';
import { clearOutbox, listOutbox, REPO_ROOT, resetAll } from '../scripts/reset.ts';
import type { ToolCallResponse } from '../server/gateway/types.ts';

export { clearOutbox, listOutbox, REPO_ROOT, resetAll };
export type { ToolCallResponse };

export const USER = 'user_default';
export const NOTES_DIR = path.join(REPO_ROOT, 'sandbox', 'notes');
export const OUTBOX_DIR = path.join(REPO_ROOT, 'sandbox', 'outbox');

/** 先重置再建服务（服务构造时会从 approvals.json 载入，顺序不能反） */
export function freshService(opts: GatewayOptions = {}): GatewayService {
  resetAll();
  return new GatewayService(opts);
}

export function outboxCount(): number {
  return listOutbox().length;
}

export function configBytes(): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8');
}

export function notePath(name: string): string {
  return path.join(NOTES_DIR, name);
}

export function writeNote(name: string, content: string): void {
  fs.writeFileSync(notePath(name), content, 'utf8');
}

export function readNote(name: string): string {
  return fs.readFileSync(notePath(name), 'utf8');
}

export function decisionOf(body: unknown): string {
  return String((body as ToolCallResponse).decision);
}

/** 在**本进程内**起 HTTP 服务（不派生子进程 —— 本机沙箱对 spawn 有限制） */
export async function startTestServer(): Promise<{
  base: string;
  server: http.Server;
  service: GatewayService;
  close: () => Promise<void>;
}> {
  resetAll();
  const service = new GatewayService();
  const server = createHttpServer(service);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    service,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 尽量创建符号链接；无权限时返回 false（Windows 需开发者模式/管理员） */
export function trySymlink(target: string, linkPath: string): boolean {
  try {
    fs.rmSync(linkPath, { force: true });
    fs.symlinkSync(target, linkPath, 'file');
    return true;
  } catch {
    return false;
  }
}

/**
 * 退化路径：Windows 上**目录 junction 不需要开发者模式/管理员**。
 * 用它照样能构造"路径里没有 .. 也不是绝对路径、realpath 后却指向沙箱外"的情形，
 * 从而证明第 3 道闸门（realpath 前缀比对）确实在起作用。
 */
export function tryDirJunction(targetAbs: string, linkPath: string): boolean {
  try {
    fs.rmSync(linkPath, { force: true });
    fs.symlinkSync(targetAbs, linkPath, 'junction');
    return true;
  } catch {
    return false;
  }
}

/** 删除链接本身（不递归进目标） */
export function removeLink(linkPath: string): void {
  try {
    fs.unlinkSync(linkPath);
  } catch {
    try {
      fs.rmSync(linkPath, { force: true });
    } catch {
      /* 尽力而为 */
    }
  }
}
