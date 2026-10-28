import * as path from 'path';
import * as fsp from 'fs/promises';
import { WorkspaceService } from './workspace';
import { atomicWrite } from '../utils/atomicWrite';

const workspaceService = new WorkspaceService();

/**
 * Highest sequence number ever used per id prefix ("TASK-2026", "CU-2026"), kept after the item itself
 * is gone. Task and context update ids are picked as "highest folder on disk + 1", so removing the
 * newest one would hand its id to the next new item, and old mentions, routine receipts and run history
 * would then point at the wrong thing. The cleanup job records an id here before it removes the folder.
 *
 *   .situation-board/reserved-ids.json   { "TASK-2026": 50, "CU-2026": 3 }
 */
function file(): string {
  return path.join(workspaceService.getWorkspacePath(), '.situation-board', 'reserved-ids.json');
}

async function readAll(): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file(), 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.entries(parsed).some(([key, value]) => !/^(TASK|CU)-\d{4}$/.test(key)
        || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('invalid reservation data');
    }
    return parsed as Record<string, number>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`ID reservations cannot be read: ${(err as Error).message}`, { cause: err });
  }
}

/** The highest reserved sequence for a prefix such as "TASK-2026-" or "CU-2026-", or 0. */
export async function reservedSequence(prefix: string): Promise<number> {
  return (await readAll())[prefix.replace(/-$/, '')] ?? 0;
}

/** Reserves ids like TASK-2026-0050 or CU-2026-0003. Other shapes are ignored. */
export async function reserveIds(ids: string[]): Promise<void> {
  const all = await readAll();
  let changed = false;
  for (const id of ids) {
    const m = id.match(/^((?:TASK|CU)-\d{4})-(\d{4})$/);
    if (!m) continue;
    const seq = Number(m[2]);
    if ((all[m[1]!] ?? 0) < seq) { all[m[1]!] = seq; changed = true; }
  }
  if (!changed) return;
  await fsp.mkdir(path.dirname(file()), { recursive: true });
  await atomicWrite(file(), JSON.stringify(all, null, 2));
}
