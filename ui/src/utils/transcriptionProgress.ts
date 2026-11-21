import { tr } from '@/i18n/current';
import type { TranscriptionPhase, TranscriptionProgress } from '@/types';

/**
 * How a running transcription reads, in one place: the Meetings row, the meeting's file view and Transcribe again
 * all use it, so they never disagree. The steps before transcribing (converting, finding who speaks, loading the
 * model) have no percent of the audio: they show how long they have run, so a long step clearly isn't frozen. Time
 * left comes from the transcribing step's own pace and is rounded, so it does not jump around; with no pace yet,
 * nothing is guessed.
 */

/** Audio transcribed before time left is guessed: the first parts say little about the pace. */
export const PACE_AFTER_SECONDS = 60;

/** A length as the app writes it: "a moment", "45 s", "12 min", "1 h 05 min". */
export function duration(seconds: number): string {
  if (seconds < 60) return seconds < 1 ? tr('queuedMeetingActions.aMoment') : `${Math.max(1, Math.round(seconds))} s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? tr('queuedMeetingActions.min', { m }) : tr('queuedMeetingActions.hMin', { floor: Math.floor(m / 60), padStart: String(m % 60).padStart(2, '0') });
}

/** The same length in words, for screen readers: "12 minutes", "1 hour 5 minutes". From a minute on. */
function spokenDuration(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return m === 1 ? tr('transcriptionProgress.oneMinute') : tr('transcriptionProgress.minutes', { m });
  return tr('transcriptionProgress.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 });
}

/**
 * Time left rounded so it reads calmly: whole minutes up to 10, then fives up to an hour, then quarter hours. Never
 * less than a minute.
 */
export function roundLeft(seconds: number): number {
  const m = seconds / 60;
  if (m <= 10) return Math.max(1, Math.ceil(m)) * 60;
  if (m <= 60) return Math.round(m / 5) * 5 * 60;
  return Math.round(m / 15) * 15 * 60;
}

/** The step, also from an older server that sends none. */
export function phaseOf(p: TranscriptionProgress): TranscriptionPhase {
  return p.phase ?? (p.total > 0 ? 'transcribing' : 'loading');
}

/** Seconds since the job entered its step; null when unknown. */
function inPhase(p: TranscriptionProgress, now: number): number | null {
  const since = Date.parse(p.phase_started_at ?? p.started_at);
  return Number.isFinite(since) ? Math.max(0, (now - since) / 1000) : null;
}

/**
 * Seconds left, rounded (see roundLeft), from the transcribing step's pace: audio done per second of work since it
 * began. Null before a minute of audio is done, or when the pace is unknown.
 */
export function timeLeft(p: TranscriptionProgress, now: number): number | null {
  if (phaseOf(p) !== 'transcribing' || !(p.total > 0) || p.done < PACE_AFTER_SECONDS || p.done >= p.total) return null;
  const spent = inPhase(p, now);
  if (!spent) return null;
  const pace = p.done / spent;
  if (!(pace > 0) || !Number.isFinite(pace)) return null;
  return roundLeft((p.total - p.done) / pace);
}

export interface TranscriptionView {
  /** Null: the recording runs, but its progress is not known here (another dashboard that does not share it). */
  phase: TranscriptionPhase | null;
  /** How full the bar is, 0–99; null for a bar that only shows it moves. */
  percent: number | null;
  /** For the badge: "Transcribing", "Transcribing 34%". */
  badge: string;
  /** The line under it: "52 min recording · about 12 min left", "Finding who speaks · 3 min", "in another dashboard". */
  detail?: string;
  /** One sentence for the file view: "Transcribing: 34% of 52 min · about 12 min left". */
  line: string;
  /** What a screen reader says: "Transcribing, 34 percent, about 12 minutes left". */
  spoken: string;
}

/** How a running transcription reads now. `progress` is null when this dashboard knows only that it runs. */
export function transcriptionView(progress: TranscriptionProgress | null, now: number): TranscriptionView {
  const transcribing = tr('meetingHistory.transcribing');
  if (!progress) {
    const elsewhere = tr('queuedMeetingActions.transcribingInAnotherDashboard');
    return { phase: null, percent: null, badge: transcribing, detail: tr('transcriptionProgress.inAnotherDashboard'), line: elsewhere, spoken: elsewhere };
  }
  const phase = phaseOf(progress);
  const elsewhere = progress.elsewhere ? [tr('transcriptionProgress.elsewhere')] : [];
  if (phase === 'transcribing' && progress.total > 0) {
    const percent = Math.min(99, Math.floor((progress.done / progress.total) * 100));
    const left = timeLeft(progress, now);
    const leftText = left === null ? [] : [tr('transcriptionProgress.timeLeft', { left: duration(left) })];
    return {
      phase, percent,
      badge: tr('meetingHistory.transcribing2', { p: percent }),
      detail: [tr('transcriptionProgress.recordingLength', { length: duration(progress.total) }), ...leftText, ...elsewhere].join(' · '),
      line: [tr('queuedMeetingActions.transcribingOf', { min: percent, minutes: duration(progress.total) }), ...leftText, ...elsewhere].join(' · '),
      spoken: [transcribing, tr('transcriptionProgress.percent', { p: percent }), ...(left === null ? [] : [tr('transcriptionProgress.timeLeft', { left: spokenDuration(left) })]), ...elsewhere].join(', '),
    };
  }
  if (phase === 'transcribing') {
    return { phase, percent: null, badge: transcribing, ...(elsewhere.length ? { detail: elsewhere.join(' · ') } : {}), line: [transcribing, ...elsewhere].join(' · '), spoken: [transcribing, ...elsewhere].join(', ') };
  }
  // A step before transcribing: what it is, and from a minute on, how long it has run.
  const part = phase === 'speakers' && typeof progress.phase_part === 'number' ? Math.min(99, Math.floor(progress.phase_part * 100)) : null;
  const step = phase === 'converting' ? tr('transcriptionProgress.converting')
    : phase === 'speakers' ? (part === null ? tr('transcriptionProgress.speakers') : tr('transcriptionProgress.speakersPercent', { p: part }))
      : tr('transcriptionProgress.loading');
  const spent = inPhase(progress, now);
  const long = spent !== null && spent >= 60 ? Math.floor(spent / 60) * 60 : null;
  const text = [step, ...(long === null ? [] : [duration(long)]), ...elsewhere].join(' · ');
  return {
    phase, percent: part, badge: transcribing, detail: text, line: text,
    spoken: [transcribing, step, ...(long === null ? [] : [spokenDuration(long)]), ...elsewhere].join(', '),
  };
}
