import * as path from 'path';
import * as fsp from 'fs/promises';
import { WorkspaceService } from './workspace';
import { atomicWrite } from '../utils/atomicWrite';

const workspaceService = new WorkspaceService();

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

async function readAll(): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file(), 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.entries(parsed).some(([key, value]) => !/^(?:(?:TASK|CU|MQ)-\d{4}|STK|GRP)$/.test(key)
        || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('invalid reservation data');
    }
    return parsed as Record<string, number>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`ID reservations cannot be read: ${(err as Error).message}`, { cause: err });
  }
}

/** The highest reserved sequence for a prefix such as "TASK-2026-", "CU-2026-" or "STK", or 0. */
export async function reservedSequence(prefix: string): Promise<number> {
  return (await readAll())[prefix.replace(/-$/, '')] ?? 0;
}

/** Reserves ids like TASK-2026-0050, CU-2026-0003, MQ-2026-0007 (a queued meeting), STK-0012 or GRP-0002. Other shapes are ignored. */
export async function reserveIds(ids: string[]): Promise<void> {
  const all = await readAll();
  let changed = false;
  for (const id of ids) {
    const m = id.match(/^((?:TASK|CU|MQ)-\d{4})-(\d{4})$/) ?? id.match(/^(STK|GRP)-(\d+)$/);
    if (!m) continue;
    const seq = Number(m[2]);
    if ((all[m[1]!] ?? 0) < seq) { all[m[1]!] = seq; changed = true; }
  }
  if (!changed) return;
  await fsp.mkdir(path.dirname(file()), { recursive: true });
  await atomicWrite(file(), JSON.stringify(all, null, 2));
}
