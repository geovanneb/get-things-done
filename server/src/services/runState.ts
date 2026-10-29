import * as path from 'path';
import * as fsp from 'fs/promises';

/**
 * Which context updates an agent is working on right now, started from the dashboard. Shared by the runner and
 * the update service, so the dashboard does not edit, close, approve or delete an update while a run writes to it.
 */
const running = new Set<string>();

const key = (workspace: string, id: string) => `${workspace}\0${id}`;

export function setAnalysisRunning(workspace: string, id: string, on: boolean): void {
  if (on) running.add(key(workspace, id));
  else running.delete(key(workspace, id));
}

/** Whether a process still exists. Only probed, never signalled. */
export function processAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Whether a run is writing to this update: one started by this dashboard, or one recorded as running whose
 * process outlived a restart of the dashboard.
 */
export async function isAnalysisRunning(workspace: string, id: string): Promise<boolean> {
  if (running.has(key(workspace, id))) return true;
  try {
    const record = JSON.parse(await fsp.readFile(path.join(workspace, '.situation-board', 'runs', `${id}.json`), 'utf-8')) as { status?: unknown; pid?: unknown };
    return record.status === 'running' && processAlive(record.pid);
  } catch {
    return false;
  }
}
