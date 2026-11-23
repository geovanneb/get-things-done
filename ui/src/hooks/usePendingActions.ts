import { useEffect, useMemo } from 'react';
import { useLanguage } from '@/i18n/LanguageProvider';
import { useAppState, useDataVersion } from '../store';
import { useApi } from './useApi';
import type { ContextUpdate, MeetingDigest, Routine, SystemCleanup, Task } from '../types';
import { waitingLabel, waitingOnUser } from '../utils/updateTypes';
import { meetingCounts } from '../utils/meetingHistory';
import { RECORDING_REFRESH_MS, hasOpenRecording, recheckIn, recordingElsewhere } from '../utils/meetingQueue';
import { useRecorder } from '../components/recording/RecordingProvider';
import { useThrottledValue } from './useThrottledValue';

/** At most this often the sidebar reads the meeting digest again because a transcription moved (see below). */
export const SIDEBAR_TRANSCRIPTION_MS = 10_000;

/**
 * Something that waits on the user and nobody else. `attention`: the user's move in a normal flow
 * (review a task, run a command). `problem`: something is broken and needs fixing. `activity`: not the user's move at
 * all, only a sign that work is moving on its own (meetings in progress): the nav shows it as a quiet marker, and it is
 * left out of Waiting on you and the More menu's count (see `waitsOnUser`).
 */
export interface PendingAction {
  /** Nav item this belongs to; the dot shows there. */
  navPath: string;
  /** Where to go to deal with it. */
  to: string;
  /** Where the nav item itself goes while this shows, when not its usual page: the meetings that need you. */
  link?: string;
  count: number;
  tone: 'attention' | 'problem' | 'activity';
  /** Short and countable, e.g. "2 tasks waiting for your review". */
  label: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Everything that waits on the user, one entry per area with a non-zero count. Shared by the nav
 * dots and the "Waiting on you" panel on Situation, so the two always agree. Meetings has at most one entry: the
 * meetings that need you, or else a quiet `activity` marker for the meetings in progress.
 * Context counts the updates ready for you (review or apply), so its dot goes up when a run finishes, and the material
 * waiting for an analysis that is not the agent's move (the server's `waits_on_agent`: a queued or running analysis,
 * or one the meeting digest will start by itself). The list is read again when a run is queued, starts or ends
 * (`run-change`) and when the digest's settings or state change, so the dot follows both.
 */
export function usePendingActions(): PendingAction[] {
  const { t } = useLanguage();
  const { validationCount } = useAppState();
  const recorder = useRecorder();
  const { data: tasks } = useApi<Task[]>('/api/tasks', [useDataVersion('tasks')]);
  const routinesVersion = useDataVersion('routines');
  // Read again when the digest's settings or state change too: they decide `waits_on_agent`.
  const { data: updates } = useApi<ContextUpdate[]>('/api/context-updates', [useDataVersion('context-updates'), routinesVersion]);
  const { data: routines } = useApi<Routine[]>('/api/routines', [routinesVersion]);
  const { data: cleanup, error: cleanupError } = useApi<SystemCleanup>('/api/routines/system-cleanup', [routinesVersion]);
  // The queue lives with the context updates, and model downloads are announced as transcription: as on the Meetings page.
  // A running transcription also announces its progress about once a second, and this hook runs in the sidebar on every
  // page. The sidebar needs those notices only for downloaded models (a recording's status changes its queue file, which
  // counts at once), so it follows them at most every SIDEBAR_TRANSCRIPTION_MS.
  const transcriptionVersion = useThrottledValue(useDataVersion('transcription'), SIDEBAR_TRANSCRIPTION_MS);
  const { data: digest, error: digestError, refetch: refetchDigest } = useApi<MeetingDigest>('/api/routines/meeting-digest', [routinesVersion, useDataVersion('context-updates'), transcriptionVersion]);

  const toReview = (tasks ?? []).filter((t) => t.status === 'in_review').length;
  const waiting = waitingOnUser(updates ?? []);
  const routineProblems = (routines ?? []).filter((r) => r.problem || r.state?.last_status === 'error').length
    + (cleanupError || cleanup?.state.last_status === 'error' ? 1 : 0)
    + (digestError || digest?.state.last_status === 'error' ? 1 : 0);
  // The Meetings page's Needs you and In progress tabs. Waiting for review is counted on Context, with its update.
  // Nothing announces audio arriving from another page, so while a recording is open the queue is asked again, as on
  // the Meetings page, and once more just after its newest audio gets too old. Whether audio is still arriving is judged
  // at the moment the queue was read, never against an older answer: only fresh data can say a recording stopped.
  const queue = digest?.queue ?? [];
  const readAt = useMemo(() => (digest ? Date.now() : 0), [digest]);
  const open = hasOpenRecording(queue);
  useEffect(() => {
    if (!open) return undefined;
    const timer = setInterval(refetchDigest, RECORDING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, refetchDigest]);
  const recheck = recheckIn(queue, readAt);
  useEffect(() => {
    if (recheck === null) return undefined;
    const timer = setTimeout(refetchDigest, recheck);
    return () => clearTimeout(timer);
  }, [recheck, refetchDigest]);
  // A meeting being recorded now, here or in another page, is in progress there too, not waiting on you.
  const meetings = meetingCounts(queue, {
    installed: digest?.installed_models ?? null, runnable: digest?.runnable_models ?? {}, chosen: digest?.chosen_model ?? null,
    recordingNow: (m) => (recorder.active && recorder.meetingId === m.id) || recordingElsewhere(m, readAt),
  });
  const meetingAction: PendingAction = meetings.needsYou > 0
    ? { navPath: '/meetings', to: '/meetings?show=you', link: '/meetings?show=you', count: meetings.needsYou, tone: 'attention', label: t('usePendingActions.meetingsNeedYou', { count: meetings.needsYou }) }
    : { navPath: '/meetings', to: '/meetings', count: meetings.inProgress, tone: 'activity', label: t('usePendingActions.meetingsInProgress', { count: meetings.inProgress }) };

  const all: PendingAction[] = [
    { navPath: '/board', to: '/board', count: toReview, tone: 'attention', label: t('usePendingActions.waitingForYourReview', { plural: t('common.taskCount', { count: toReview }) }) },
    { navPath: '/context', to: '/context/updates', count: waiting.ready + waiting.toAnalyze, tone: 'attention', label: waitingLabel(waiting) },
    meetingAction,
    { navPath: '/routines', to: '/routines', count: routineProblems, tone: 'problem', label: t('usePendingActions.attention', { plural: plural(routineProblems, t('usePendingActions.routineNeeds'), t('usePendingActions.routinesNeed')) }) },
    { navPath: '/settings', to: '/settings', count: validationCount.errors, tone: 'problem', label: t('usePendingActions.toFix', { plural: plural(validationCount.errors, t('usePendingActions.workspaceValidationError'), t('usePendingActions.workspaceValidationErrors')) }) },
  ];
  return all.filter((a) => a.count > 0);
}

/** True for what the user has to do; false for an `activity` marker, which only says that work is moving. */
export const waitsOnUser = (a: PendingAction): boolean => a.tone !== 'activity';

export const TONE_COLOR: Record<PendingAction['tone'], string> = {
  attention: 'var(--color-warning)',
  problem: 'var(--color-critical)',
  activity: 'var(--nav-text)',
};
