import { useAppState, useDataVersion } from '../store';
import { useApi } from './useApi';
import type { ContextUpdate, MeetingDigest, Routine, SystemCleanup, Task } from '../types';

/**
 * Something that waits on the user and nobody else. `attention`: the user's move in a normal flow
 * (review a task, run a command). `problem`: something is broken and needs fixing.
 */
export interface PendingAction {
  /** Nav item this belongs to; the dot shows there. */
  navPath: string;
  /** Where to go to deal with it. */
  to: string;
  count: number;
  tone: 'attention' | 'problem';
  /** Short and countable, e.g. "2 tasks waiting for your review". */
  label: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Everything that waits on the user, one entry per area with a non-zero count. Shared by the nav
 * dots and the "Waiting on you" panel on Situation, so the two always agree.
 * Context updates count the same statuses as the "Waiting on you" group of the updates list.
 */
export function usePendingActions(): PendingAction[] {
  const { validationCount } = useAppState();
  const { data: tasks } = useApi<Task[]>('/api/tasks', [useDataVersion('tasks')]);
  const { data: updates } = useApi<ContextUpdate[]>('/api/context-updates', [useDataVersion('context-updates')]);
  const routinesVersion = useDataVersion('routines');
  const { data: routines } = useApi<Routine[]>('/api/routines', [routinesVersion]);
  const { data: cleanup, error: cleanupError } = useApi<SystemCleanup>('/api/routines/system-cleanup', [routinesVersion]);
  const { data: digest, error: digestError } = useApi<MeetingDigest>('/api/routines/meeting-digest', [routinesVersion]);

  const toReview = (tasks ?? []).filter((t) => t.status === 'in_review').length;
  const updatesWaiting = (updates ?? []).filter((u) => u.status === 'in_review' || u.status === 'ready' || u.status === 'approved').length;
  const routineProblems = (routines ?? []).filter((r) => r.problem || r.state?.last_status === 'error').length
    + (cleanupError || cleanup?.state.last_status === 'error' ? 1 : 0)
    + (digestError || digest?.state.last_status === 'error' ? 1 : 0);

  const all: PendingAction[] = [
    { navPath: '/board', to: '/board', count: toReview, tone: 'attention', label: `${plural(toReview, 'task', 'tasks')} waiting for your review` },
    { navPath: '/context', to: '/context/updates', count: updatesWaiting, tone: 'attention', label: `${plural(updatesWaiting, 'context update', 'context updates')} waiting on you` },
    { navPath: '/routines', to: '/routines', count: routineProblems, tone: 'problem', label: `${plural(routineProblems, 'routine needs', 'routines need')} attention` },
    { navPath: '/settings', to: '/settings', count: validationCount.errors, tone: 'problem', label: `${plural(validationCount.errors, 'workspace validation error', 'workspace validation errors')} to fix` },
  ];
  return all.filter((a) => a.count > 0);
}

export const TONE_COLOR: Record<PendingAction['tone'], string> = {
  attention: 'var(--color-warning)',
  problem: 'var(--color-critical)',
};
