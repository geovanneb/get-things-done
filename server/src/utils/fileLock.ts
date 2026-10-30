import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { randomUUID } from 'crypto';
import { processAlive } from '../services/runState';

/**
 * A lock file shared by every dashboard on this computer: one holder at a time, across processes.
 *
 * The file names its holder (pid) and a token, so only the holder releases it. A lock whose holder is gone, or that
 * was never finished (a crash or a full disk while writing it) and is old, is taken over under a short second lock,
 * the guard: there it is read again and removed only if it is still the very file judged stale (same inode, same
 * content), so a live lock is never removed. The guard names its holder too and is cleared only when that process
 * is gone, never by age while it lives. Left open: two dashboards clearing the same dead holder's guard within the
 * same instant, which needs operating-system file locks Node does not offer.
 */

export interface HeldLock { file: string; token: string }

export interface LockHolder { pid?: number; token?: string; incomplete: boolean; mtime: number; ino: number; raw: string }

/** A lock file whose holder never finished writing it is taken over after this long. */
export const INCOMPLETE_LOCK_MS = 10_000;

/** The tokens of the locks this process holds, per lock file: its own live locks are never taken for stale ones. */
const owned = new Map<string, Set<string>>();
const ownedFor = (file: string) => {
  let set = owned.get(file);
  if (!set) owned.set(file, (set = new Set()));
  return set;
};

/** The lock as it is now, with what identifies this very file: its inode and its exact content. Null when there is none. */
export async function readLock(file: string): Promise<LockHolder | null> {
  let raw: string;
  let st: fs.Stats;
  try {
    st = await fsp.lstat(file);
    raw = await fsp.readFile(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    const o = JSON.parse(raw) as { pid?: unknown; token?: unknown };
    if (typeof o.pid === 'number' && Number.isInteger(o.pid) && o.pid > 0 && typeof o.token === 'string' && o.token) {
      return { pid: o.pid, token: o.token, incomplete: false, mtime: st.mtimeMs, ino: st.ino, raw };
    }
  } catch { /* an unfinished or damaged lock */ }
  return { incomplete: true, mtime: st.mtimeMs, ino: st.ino, raw };
}

/** True when the lock is held by a live process other than this one. */
export async function heldElsewhere(file: string): Promise<boolean> {
  const holder = await readLock(file);
  return Boolean(holder && !holder.incomplete && holder.pid !== process.pid && processAlive(holder.pid));
}

/**
 * One attempt at the lock, taking over a stale one. Returns the held lock, or the reason it is busy: `held` (a live
 * holder), `starting` (a lock still being written) or `stuck` (a stale lock that could not be taken over yet, for
 * example while another dashboard's takeover guard is in place).
 */
export type Busy = 'held' | 'starting' | 'stuck';
export async function tryLock(file: string): Promise<HeldLock | Busy> {
  const token = `${process.pid}-${randomUUID()}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const handle = await fsp.open(file, 'wx', 0o600);
      ownedFor(file).add(token);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })); } finally { await handle.close(); }
      return { file, token };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = await readLock(file);
    if (!holder) continue;
    const stale = holder.incomplete ? Date.now() - holder.mtime > INCOMPLETE_LOCK_MS
      : !processAlive(holder.pid) || (holder.pid === process.pid && !ownedFor(file).has(holder.token!));
    if (!stale) return holder.incomplete ? 'starting' : 'held';
    await takeOver(file, holder.ino, holder.raw);
  }
  return 'stuck';
}

/** Takes the lock, waiting up to `waitMs` for another holder to finish. Throws `busy()` when it does not in time. */
export async function lock(file: string, waitMs: number, busy: (reason: Busy) => Error): Promise<HeldLock> {
  const until = Date.now() + waitMs;
  for (let delay = 20; ; delay = Math.min(delay * 2, 250)) {
    const result = await tryLock(file);
    if (typeof result !== 'string') return result;
    if (Date.now() + delay > until) throw busy(result);
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** Releases the lock only when it is still ours. */
export async function unlock(held: HeldLock): Promise<void> {
  try {
    const holder = await readLock(held.file);
    if (holder?.token === held.token) await fsp.rm(held.file, { force: true });
  } finally {
    // Forgotten only once the file is gone, so this process never takes its own live lock for a stale one.
    ownedFor(held.file).delete(held.token);
  }
}

/** True when this process holds the lock under this token. */
export function ownsToken(file: string, token: string): boolean {
  return ownedFor(file).has(token);
}

/** Removes the stale lock seen, under the takeover guard, if it is still that very file. */
async function takeOver(file: string, ino: number, raw: string): Promise<void> {
  const guard = `${file}.takeover`;
  const mine = JSON.stringify({ pid: process.pid, token: randomUUID() });
  try {
    const created = await fsp.open(guard, 'wx', 0o600);
    try { await created.writeFile(mine); } finally { await created.close(); }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const held = await readLock(guard);
    const gone = held && (held.incomplete ? Date.now() - held.mtime > INCOMPLETE_LOCK_MS : !processAlive(held.pid));
    if (gone) {
      const again = await readLock(guard);
      if (again && again.ino === held.ino && again.raw === held.raw) await fsp.rm(guard, { force: true });
    }
    await new Promise((r) => setTimeout(r, 50));
    return;
  }
  try {
    const now = await readLock(file);
    if (now && now.ino === ino && now.raw === raw) await fsp.rm(file, { force: true });
  } finally {
    const held = await fsp.readFile(guard, 'utf-8').catch(() => '');
    if (held === mine) await fsp.rm(guard, { force: true });
  }
}
