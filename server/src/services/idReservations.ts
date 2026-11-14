import * as path from 'path';
import * as fsp from 'fs/promises';
import { WorkspaceService } from './workspace';
import { atomicWrite } from '../utils/atomicWrite';
import { lock, unlock } from '../utils/fileLock';
import { workspaceEntry } from '../utils/files';

const workspaceService = new WorkspaceService();

/**
 * The largest sequence worth reserving: generous, and within Number.isSafeInteger. Task, context update and
 * queued meeting ids carry exactly four digits (the task schema and the match below), and stakeholder and group
 * ids count up by one from 0001, so nothing the app creates comes near it. A bigger number comes from a
 * hand-written id such as STK-99999999999999999999; reserving it would make the next id useless, and beyond
 * 2^53 it cannot even be stored exactly.
 */
const MAX_SEQUENCE = 999_999_999;

/**
 * Highest sequence number ever used per id prefix ("TASK-2026", "CU-2026", "STK"), kept after the item
 * itself is gone. Task, context update and stakeholder ids are picked as "highest on disk + 1", so removing
 * the newest one would hand its id to the next new item, and old mentions, routine receipts and run history
 * would then point at the wrong thing. Whatever removes one records its id here first.
 *
 *   .situation-board/reserved-ids.json   { "TASK-2026": 50, "CU-2026": 3, "STK": 12 }
 */
function file(): string {
  return path.join(workspaceService.getWorkspacePath(), '.situation-board', 'reserved-ids.json');
}

/**
 * The file as it is. Unreadable JSON or something other than an object is refused: read as empty, it would hand
 * out ids that are still referenced, and the next reservation would overwrite every other prefix. Single entries
 * are judged per prefix by highWater, so one bad entry never blocks the others.
 */
async function readAll(target = file()): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fsp.readFile(target, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid reservation data');
    return parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`ID reservations cannot be read: ${(err as Error).message}`, { cause: err });
  }
}

function usable(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SEQUENCE;
}

const reported = new Set<string>();

/**
 * The reserved sequence for one prefix, or 0. An entry that is not a usable number (for example 1e20, written
 * by older versions when an oversized hand-written id was deleted) is ignored for its own prefix and reported
 * once; it stays in the file until a real reservation for that prefix replaces it.
 */
function highWater(all: Record<string, unknown>, key: string): number {
  const value = all[key];
  if (value === undefined || usable(value)) return value ?? 0;
  const note = `${key}=${JSON.stringify(value)}`;
  if (!reported.has(note)) {
    reported.add(note);
    console.warn(`[ids] reserved-ids.json: the ${key} entry ${JSON.stringify(value)} is not a usable id number, so it is ignored. Ids of deleted ${key} items may be given out again.`);
  }
  return 0;
}

/** The highest reserved sequence for a prefix such as "TASK-2026-", "CU-2026-" or "STK", or 0. */
export async function reservedSequence(prefix: string): Promise<number> {
  return highWater(await readAll(), prefix.replace(/-$/, ''));
}

/**
 * Reserves ids like TASK-2026-0050, CU-2026-0003, MQ-2026-0007 (a queued meeting), STK-0012 or GRP-0002. Other
 * shapes, and sequences above MAX_SEQUENCE, are ignored. Only these five prefixes are written (older versions refuse
 * any other key); entries it does not change, including keys it does not know, are written back as they were.
 */
export async function reserveIds(ids: string[]): Promise<void> {
  const ws = workspaceService.getWorkspacePath();
  const target = await workspaceEntry(ws, file(), true);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const lockFile = await workspaceEntry(ws, `${target}.lock`, true);
  // Every prefix shares one file. Atomic replacement alone loses another deletion's reservation.
  const held = await lock(lockFile, 5000, () => Object.assign(new Error('ID reservations are busy. Try again.'), { statusCode: 409 }));
  try {
    const all = await readAll(target);
    let changed = false;
    for (const id of ids) {
      const m = id.match(/^((?:TASK|CU|MQ)-\d{4})-(\d{4})$/) ?? id.match(/^(STK|GRP)-(\d+)$/);
      if (!m) continue;
      const seq = Number(m[2]);
      if (!Number.isSafeInteger(seq) || seq > MAX_SEQUENCE) continue;
      if (highWater(all, m[1]!) < seq) { all[m[1]!] = seq; changed = true; }
    }
    if (changed) await atomicWrite(target, JSON.stringify(all, null, 2));
  } finally {
    await unlock(held);
  }
}
