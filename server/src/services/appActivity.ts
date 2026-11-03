import * as fsp from 'fs/promises';
import * as path from 'path';
import { anyAnalysisRunning, processAlive } from './runState';
import { TranscriptionEngine } from './transcription/engine';
import { MeetingDigestService } from './meetingDigestService';

/**
 * What important is running now, in words, or null: a recording, a transcription, or an AI tool run. An update is
 * never offered or installed meanwhile (#284). Read only; judged for the workspace given.
 *
 * Recordings and runs are seen across dashboards (the meeting queue and the run records); a transcription is seen in
 * this dashboard only.
 */
export async function busyReason(workspace: string | null): Promise<string | null> {
  if (TranscriptionEngine.isBusy()) return 'A transcription is running';
  if (anyAnalysisRunning()) return 'An AI tool run is going';
  if (!workspace) return null;
  const recording = await new MeetingDigestService().readQueue()
    .then((q) => q.meetings.some((m) => m.live?.state === 'recording'), () => false);
  if (recording) return 'A meeting is being recorded';
  const runs = path.join(workspace, '.situation-board', 'runs');
  const names = await fsp.readdir(runs).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith('.json') && n !== 'runner-settings.json')) {
    // A damaged record is skipped, never the ones after it.
    let record: unknown;
    try { record = JSON.parse(await fsp.readFile(path.join(runs, name), 'utf-8')); } catch { continue; }
    const run = (record && typeof record === 'object' ? record : {}) as { status?: unknown; pid?: unknown };
    if (run.status === 'running' && processAlive(run.pid)) return 'An AI tool run is going';
  }
  return null;
}
