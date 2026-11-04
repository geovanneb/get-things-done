/**
 * What the notice of a finished run says (#246), read in one request so the workspace, the run and the update all
 * belong together: the route pins the workspace for the whole request, and the notice is given only when that is the
 * workspace the caller expects and that very run (same start) ended. Read only.
 */

export interface RunNoticeData {
  outcome: 'review' | 'applied' | 'analyze-failed' | 'apply-failed';
  /** The update's title, cleaned for a system notice; empty when unknown. */
  title: string;
  /** Proposals of a finished analysis; null when the update could not be read (never taken as none). */
  proposals: number | null;
}

/** Text from a workspace file, safe for a system notice: one line, no control or direction characters, at most 80. */
export function cleanNoticeTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
}

/**
 * The notice, or null: the workspace is not the expected one, the run is not that run, or it did not end (still going,
 * or stopped by the user, who knows).
 */
export function runNoticeData(
  workspace: string, expected: { workspace: unknown; started_at: unknown },
  run: { command: string; status: string; started_at: string } | null, update: { title: string; proposals: unknown[] } | null,
): RunNoticeData | null {
  if (expected.workspace !== workspace || !run || run.started_at !== expected.started_at) return null;
  if (run.status !== 'succeeded' && run.status !== 'failed') return null;
  const outcome = run.status === 'failed' ? (run.command === 'analyze' ? 'analyze-failed' : 'apply-failed') : run.command === 'analyze' ? 'review' : 'applied';
  return { outcome, title: cleanNoticeTitle(update?.title), proposals: update ? update.proposals.length : null };
}
