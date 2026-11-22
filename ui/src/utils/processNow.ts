import { tr } from '@/i18n/current';
import type { MeetingDigest, QueuedMeeting } from '@/types';

/**
 * "Process this meeting now" (#487): a digest of one queued meeting, without waiting for the batch. Whether it can run,
 * and what its confirmation says, are worked out here from what the Meetings page already has, so every state can be
 * tested without a page, and other places (such as a meeting's next step) can use the same answer.
 *
 * The server checks all of it again when it runs; this only decides what the page offers.
 */

/** Why the action cannot run now. */
export type ProcessNowBlock = 'open_digest' | 'digest_busy' | 'draft' | 'held' | 'transcript' | 'transcript_missing' | 'in_digest';

/** What the analysis does once the digest is made, as the server names it (see analysisExpectation on the server). */
export type AnalysisExpectation = 'manual' | 'auto' | 'auto_paused';

export type ProcessNowState =
  | { kind: 'ready'; analysis: AnalysisExpectation }
  /** Disabled: `reason` says why in plain words; `open_digest` is the update to review first, when that is why. */
  | { kind: 'blocked'; block: ProcessNowBlock; reason: string; open_digest?: string };

export type ProcessNowJob = Pick<MeetingDigest, 'open_digest' | 'queue' | 'workspace'> & { settings: Pick<MeetingDigest['settings'], 'auto_analyze' | 'enabled'> };

/** The same rule as the server's: off, on, or on while the routine is paused. */
export function analysisExpectation(settings: ProcessNowJob['settings']): AnalysisExpectation {
  return !settings.auto_analyze ? 'manual' : settings.enabled ? 'auto' : 'auto_paused';
}

/** A recording whose transcript is done, or partial and accepted as it is (as the server counts it). */
const transcribed = (r: NonNullable<QueuedMeeting['files'][number]['recording']>) => r.status === 'done' || (r.status === 'partial' && r.accepted === true);

/**
 * Whether one meeting can go into a digest of its own now. The meeting's own state comes first (a meeting that is not
 * ready says so, whatever else is going on), then what holds every digest back: one waiting for review, or one being made.
 */
export function processNowState(meeting: QueuedMeeting, job: ProcessNowJob): ProcessNowState {
  const blocked = (block: ProcessNowBlock, reason: string, open?: string): ProcessNowState => ({ kind: 'blocked', block, reason, ...(open ? { open_digest: open } : {}) });
  if (meeting.in_digest) return blocked('in_digest', tr('processNow.inDigest'));
  if (meeting.status !== 'queued' || meeting.live) return blocked('draft', tr('processNow.notQueued'));
  if (meeting.held) return blocked('held', tr('processNow.held'));
  if (meeting.files.some((f) => f.recording && !transcribed(f.recording))) return blocked('transcript', tr('processNow.transcript'));
  // As the server checks: a recording counted as transcribed needs its transcript among the meeting's files (by hash too).
  if (meeting.files.some((f) => f.recording && transcribed(f.recording)
    && !(f.recording.transcript && meeting.files.some((o) => o.name === f.recording!.transcript && (!f.recording!.transcript_sha256 || o.sha256 === f.recording!.transcript_sha256))))) {
    return blocked('transcript_missing', tr('processNow.transcriptMissing'));
  }
  if (job.open_digest) return blocked('open_digest', tr('processNow.waitingFor', { id: job.open_digest }), job.open_digest);
  if (job.queue.some((m) => m.in_digest)) return blocked('digest_busy', tr('processNow.busy'));
  return { kind: 'ready', analysis: analysisExpectation(job.settings) };
}

/**
 * The request the confirmation sends: bound to the workspace it was shown in (as the body and the workspace header)
 * and to what it said about the analysis. The server refuses it when either no longer holds.
 */
export function processNowRequest(meeting: Pick<QueuedMeeting, 'id'>, job: Pick<ProcessNowJob, 'workspace'>, analysis: AnalysisExpectation): { path: string; body: { meeting: string; workspace: string; expect_analysis: AnalysisExpectation }; workspace: string } {
  return { path: '/api/routines/meeting-digest/run', body: { meeting: meeting.id, workspace: job.workspace, expect_analysis: analysis }, workspace: job.workspace };
}

/** What the run answered (201), as the toast after it says it. */
export interface ProcessNowResult { status: 'ok' | 'error'; message: string; context_update?: string; analysis?: 'started' | 'waiting' | 'paused_waiting' | 'not_started' }

export function processNowOutcome(result: ProcessNowResult, title: string): { tone: 'success' | 'warning' | 'error'; text: string } {
  const id = result.context_update;
  if (!id) return { tone: 'error', text: result.message };
  if (result.analysis === 'paused_waiting') return { tone: 'warning', text: tr('processNow.madePausedWaiting', { id, title }) };
  if (result.analysis === 'not_started' || result.status === 'error') return { tone: 'warning', text: result.message };
  if (result.analysis === 'started') return { tone: 'success', text: tr('processNow.madeStarted', { id, title }) };
  if (result.analysis === 'waiting') return { tone: 'success', text: tr('processNow.madeWaiting', { id, title }) };
  return { tone: 'success', text: tr('processNow.made', { id, title }) };
}

/**
 * What the confirmation says before a digest of this meeting alone is made: what it does, what happens to the analysis
 * (honestly: with automatic analysis on, the dashboard tries to start it and, with another run going, starts it after
 * that run; while the routine is paused it tries once only, so the user may have to start it; off, the user starts it
 * from the update), and that it costs a little more.
 */
export function processNowConfirmation(meeting: Pick<QueuedMeeting, 'title'>, analysis: AnalysisExpectation): { title: string; lines: string[]; confirmLabel: string } {
  return {
    title: tr('processNow.confirmTitle', { title: meeting.title }),
    lines: [
      tr('processNow.confirmWhat'),
      analysis === 'auto' ? tr('processNow.confirmAuto') : analysis === 'auto_paused' ? tr('processNow.confirmAutoPaused') : tr('processNow.confirmManual'),
      tr('processNow.confirmUsage'),
    ],
    confirmLabel: tr('processNow.confirm'),
  };
}
