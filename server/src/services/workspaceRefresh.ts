import * as fsp from 'fs/promises';
import * as path from 'path';
import { refreshAppFiles, type UpgradeResult } from './scaffold';
import { isAnalysisRunning } from './runState';
import { tryLock, unlock } from '../utils/fileLock';

export type RefreshOutcome =
  | { status: 'done'; result: UpgradeResult }
  | { status: 'skipped'; reason: string };

/** Whether an agent started from the dashboard is working in the workspace: its files are not changed under it. */
async function agentRunning(workspacePath: string): Promise<boolean> {
  const runs = await fsp.readdir(path.join(workspacePath, '.situation-board', 'runs')).catch(() => [] as string[]);
  for (const name of runs) if (name.endsWith('.json') && await isAnalysisRunning(workspacePath, name.slice(0, -'.json'.length))) return true;
  return false;
}

/**
 * Brings a workspace's app-provided files up to this app (see `refreshAppFiles`): one writer at a time, the dashboard
 * and `gtd upgrade` alike, and not while an agent started from the dashboard works. An agent started by hand in a
 * terminal is not known to the app.
 */
export async function refreshWorkspace(workspacePath: string): Promise<RefreshOutcome> {
  const folder = path.join(workspacePath, '.situation-board');
  await fsp.mkdir(folder, { recursive: true });
  const held = await tryLock(path.join(folder, 'upgrade.lock'));
  if (typeof held === 'string') return { status: 'skipped', reason: 'another dashboard or gtd upgrade is bringing the files up to date' };
  try {
    if (await agentRunning(workspacePath)) return { status: 'skipped', reason: 'an agent is working in the workspace' };
    const result = refreshAppFiles(workspacePath);
    return result ? { status: 'done', result } : { status: 'skipped', reason: 'a newer version of the app last upgraded this workspace' };
  } finally {
    await unlock(held);
  }
}
