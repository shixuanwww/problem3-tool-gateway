// ============================================================================
// server/gateway/persist.ts —— approvals.json 的跨进程安全读写（P2 修复）
//
// 为什么需要单独一层（改前的三个实测缺陷）：
//   1) 原来的临时文件名是**固定的** `approvals.json.tmp`：两个进程同时
//      persistState() 时会互相 rename / 删除，直接抛
//      `ENOENT: rename '...approvals.json.tmp' -> '...approvals.json'`；
//   2) 原来 persistState() 把**本进程内存全量覆盖磁盘**，跨进程 last-writer-wins，
//      会把别的进程刚写下的 `used=true` 覆盖回 `false` —— 确认“复活”，可能重复副作用；
//   3) 两个进程各自从 `seq=0` 起算，会生成**同一个** approval_id / mail_id。
//
// 这里用**同目录锁文件**（`open(..., 'wx')` 原子创建）把
// “读磁盘 → 单调合并 → 写磁盘”包成一个临界区，并且：
//   · 临时文件名带 pid + 随机数（即使有进程没遵守锁也不会互相踩）；
//   · 合并对安全字段取**单调**语义：used 只增不减，decided 一旦落盘不被覆盖。
//
// ⚠️ 诚实边界：这是**单机文件锁**，不是分布式锁。它能修好“同机多进程（HTTP +
//    MCP stdio）/ 并发写”的数据竞争，但多机器、多副本仍应换成数据库唯一约束
//    （如 `UPDATE ... WHERE used = 0`）。README 已如实收窄措辞。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './sandbox.ts';
import type { Approval, PersistedState } from './types.ts';

export const APPROVALS_FILE = path.join(DATA_DIR, 'approvals.json');
const LOCK_FILE = `${APPROVALS_FILE}.lock`;
/**
 * 等锁上限。锁只包住**同步文件 I/O**（正常是毫秒级），所以 1.5s 已经足够宽；
 * 再长只会让 HTTP 请求干等 —— 等不到时由 server/index.ts 兜底成 503。
 * ⚠️ 等待期间是 `Atomics.wait` **同步阻塞**（整个事件循环停住），因此这个值必须小。
 */
const LOCK_WAIT_MS = 1_500;
/** 锁文件超过这个时间没被释放 ⇒ 认定持有者已死，抢占（避免进程被 kill 后永久死锁） */
const LOCK_STALE_MS = 5_000;

/**
 * 同步退避。Node 主线程允许 `Atomics.wait`，比忙等省 CPU；
 * 持久化是同步 API，所以这里不能用 await。
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 以 `approvals.json.lock` 为互斥量执行 `fn`。
 * `fn` 内**禁止 await**（本函数是同步的），因此临界区天然原子。
 */
export function withStateLock<T>(fn: () => T): T {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(LOCK_FILE, 'wx'); // 原子：同一时刻只有一个进程能创建成功
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;

      // 持有者可能已经崩溃 —— 超过 LOCK_STALE_MS 就抢占
      try {
        const st = fs.statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(LOCK_FILE, { force: true });
          continue;
        }
      } catch {
        /* 锁刚好被持有者释放，下一轮直接抢 */
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `获取 approvals 文件锁超时（${LOCK_WAIT_MS}ms）：可能有其它进程长时间持有 ${path.basename(LOCK_FILE)}`,
        );
      }
      sleepSync(10 + Math.floor(Math.random() * 20));
      continue;
    }

    try {
      return fn();
    } finally {
      // Windows 上不能删除仍打开的文件 ⇒ 先 close 再 rm
      try {
        fs.closeSync(fd);
      } catch {
        /* 尽力而为 */
      }
      try {
        fs.rmSync(LOCK_FILE, { force: true });
      } catch {
        /* 尽力而为 */
      }
    }
  }
}

/** 读磁盘快照；不存在 / 损坏 / 结构不符一律返回 undefined（调用方决定怎么处理） */
export function readStateSnapshot(): PersistedState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8')) as Partial<PersistedState>;
    if (!parsed || !Array.isArray(parsed.approvals)) return undefined;
    const seq = (parsed.seq ?? {}) as Partial<PersistedState['seq']>;
    return {
      seq: { approval: Number(seq.approval ?? 0) || 0, mail: Number(seq.mail ?? 0) || 0 },
      approvals: parsed.approvals as Approval[],
    };
  } catch {
    return undefined;
  }
}

/**
 * 原子写：唯一临时名 + rename。
 * 唯一临时名是**第二道保险** —— 即使某个旧版本进程没遵守文件锁，也不会互相踩 tmp。
 */
export function writeApprovalsFile(state: PersistedState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${APPROVALS_FILE}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, APPROVALS_FILE);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 尽力而为 */
    }
    throw e;
  }
}

/**
 * 把磁盘版本（disk）与内存版本（mem）合并成一条记录。
 *
 * 安全相关的字段**单调**：
 *   · `used`    : 或运算 —— 任何一方用过就算用过，绝不回退；
 *   · `decided` : 磁盘优先 —— 一旦有进程把决定落盘，别的进程的旧快照不能覆盖它
 *                 （磁盘没有时才采用内存的新决定）；
 *   · `result`  : 磁盘有执行结果就保留（避免把“已执行”擦成“未执行”）。
 * 其它字段两侧本应完全一致，直接以磁盘版本为准。
 */
export function mergeApproval(disk: Approval, mem: Approval): Approval {
  return {
    ...disk,
    used: disk.used || mem.used,
    decided: disk.decided ?? mem.decided,
    result: disk.result !== undefined ? disk.result : mem.result,
    executed_at: disk.executed_at ?? mem.executed_at,
  };
}
