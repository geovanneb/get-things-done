import * as fsp from 'fs/promises';
import * as path from 'path';
import { anyAnalysisRunning, processAlive } from './runState';
import { TranscriptionEngine } from './transcription/engine';
import { MeetingDigestService } from './meetingDigestService';
import { withWorkspacePath } from './workspace';

let updating = false;

/** An update was handed to its helper and this dashboard is about to stop: no new run or recording starts (#284). */
export function setUpdating(value: boolean): void {
  updating = value;
}

/** Refuses a new run, recording or workspace switch while this dashboard stops for an update. */
export function refuseWhileUpdating(): void {
  if (updating) throw Object.assign(new Error('Get Things Done is restarting for an update; try again in a minute'), { statusCode: 409 });
}

/** What has been admitted and is not visible as running yet, in words, with how many of each. */
const starting = new Map<string, number>();

/**
 * Something admitted that is not visible as running yet (a recording until it is saved, a workspace switch until it
 * is done): counted until then, so an update checking what runs never misses it. Refused once an update closed
 * admission. Returns the release, called when it is over either way.
 */
export function beginStart(what: string): () => void {
  refuseWhileUpdating();
  starting.set(what, (starting.get(what) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (starting.get(what) ?? 1) - 1;
    if (left > 0) starting.set(what, left); else starting.delete(what);
  };
}

/**
 * What important is running now, in words, or null: a recording, a transcription, or an AI tool run. An update is
 * never offered or installed meanwhile (#284). Read only; judged for the workspace given.
 *
 * Recordings and runs are seen across dashboards (the meeting queue and the run records); a transcription is seen in
 * this dashboard only.
 */
export async function busyReason(workspace: string | null): Promise<string | null> {
  const pending = [...starting.keys()][0];
  if (pending) return pending;
  if (TranscriptionEngine.isBusy()) return 'A transcription is running';
  if (anyAnalysisRunning()) return 'An AI tool run is going';
  if (!workspace) return null;
  // Use the same workspace as the run scan, even outside an HTTP request or inside another workspace's context.
  const queue = await withWorkspacePath(workspace, () => new MeetingDigestService().readQueue());
  if (queue.meetings.some((m) => m.live?.state === 'recording')) return 'A meeting is being recorded';
  if (queue.problems.length) return 'Meeting activity could not be checked; repair the meeting queue before updating';
  const runs = path.join(workspace, '.situation-board', 'runs');
  const names = await fsp.readdir(runs).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [] as string[];
    throw err;
  });
  for (const name of names.filter((n) => n.endsWith('.json') && n !== 'runner-settings.json')) {
    // A damaged record is skipped, never the ones after it.
    let record: unknown;
    try { record = JSON.parse(await fsp.readFile(path.join(runs, name), 'utf-8')); } catch { continue; }
    const run = (record && typeof record === 'object' ? record : {}) as { status?: unknown; pid?: unknown };
    if (run.status === 'running' && processAlive(run.pid)) return 'An AI tool run is going';
  }
  return null;
}
