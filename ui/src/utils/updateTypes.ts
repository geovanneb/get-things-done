import type { ContextUpdate, ContextUpdateStatus } from '@/types';

/**
 * What kind of update it is, from who opened it. One list of types feeds the filter, the badge and the counts,
 * so a new kind of update is one more entry here.
 */
export type UpdateType = 'imported' | 'meeting-digest' | 'meeting-correction' | 'correction-follow-up' | 'memory-review' | 'kaizen' | 'other';

export const UPDATE_TYPES: { id: UpdateType; label: string; hint: string }[] = [
  { id: 'imported', label: 'Imported', hint: 'Material you imported: files or a pasted transcript.' },
  { id: 'meeting-digest', label: 'Meeting digest', hint: 'Made by the Meeting digest routine from queued meetings.' },
  { id: 'meeting-correction', label: 'Correction', hint: 'Opened from a meeting to correct its reviewed record: names, terms, people, the title or the date.' },
  { id: 'correction-follow-up', label: 'Follow-up', hint: 'Opened from a finished correction to find notes in your context that still use the old names or terms.' },
  { id: 'memory-review', label: 'Memory review', hint: 'Opened by the weekly System cleanup job to review your memory. Set it up under Routines.' },
  { id: 'kaizen', label: 'Kaizen', hint: 'Opened after a task needed rework: a change to how the agent works, so the mistake does not repeat.' },
  { id: 'other', label: 'Other', hint: 'Opened by something this version of the dashboard does not know.' },
];

const BY_ORIGIN: Record<string, UpdateType> = { meetings: 'meeting-digest', 'system-cleanup': 'memory-review', kaizen: 'kaizen' };

/** Who opened it decides the type; within the meetings, a correction is told apart by its kind. */
type Typed = Pick<ContextUpdate, 'origin'> & { kind?: string | null };

export function updateType(u: Typed): UpdateType {
  if (!u.origin) return 'imported';
  if (u.origin === 'meetings' && u.kind === 'meeting-correction') return 'meeting-correction';
  if (u.origin === 'meetings' && u.kind === 'correction-follow-up') return 'correction-follow-up';
  return BY_ORIGIN[u.origin] ?? 'other';
}

export function typeMeta(type: UpdateType): { id: UpdateType; label: string; hint: string } {
  return UPDATE_TYPES.find((t) => t.id === type)!;
}

export type TypeFilter = UpdateType | 'all';

/** Updates of the chosen type whose title or id contains the query (any case). */
export function filterUpdates<T extends Pick<ContextUpdate, 'id' | 'title'> & Typed>(updates: T[], type: TypeFilter, query: string): T[] {
  const q = query.trim().toLowerCase();
  return updates.filter((u) =>
    (type === 'all' || updateType(u) === type) &&
    (!q || u.title.toLowerCase().includes(q) || u.id.toLowerCase().includes(q)));
}

/** How many updates of each type there are. Types with none are left out. */
export function typeCounts(updates: Typed[]): Partial<Record<UpdateType, number>> {
  const counts: Partial<Record<UpdateType, number>> = {};
  for (const u of updates) {
    const t = updateType(u);
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

/**
 * Finished updates pile up (a meeting digest can open one a day), so History shows this many at a time.
 * Updates that wait on the user or the agent always show in full: there are few, and hiding one hides work.
 */
export const HISTORY_PAGE = 20;

/**
 * Whose move it is (#246). Ready for you: analyzed and waiting for review, or approved and waiting to be applied, so
 * the count goes up exactly when a run finishes. To analyze: material waiting for an analysis, nothing to review yet.
 * The sidebar dot, the list's groups and the counts by the title all read these, so they always agree.
 */
export const READY_FOR_YOU: ContextUpdateStatus[] = ['in_review', 'approved'];
export const TO_ANALYZE: ContextUpdateStatus[] = ['ready'];

export function waitingCounts(updates: Pick<ContextUpdate, 'status'>[]): { ready: number; toAnalyze: number } {
  return {
    ready: updates.filter((u) => READY_FOR_YOU.includes(u.status)).length,
    toAnalyze: updates.filter((u) => TO_ANALYZE.includes(u.status)).length,
  };
}

/** Both counts in words, for a tooltip or an accessible name: status never rests on colour alone. */
export function waitingLabel({ ready, toAnalyze }: { ready: number; toAnalyze: number }): string {
  const one = (n: number, a: string, many: string) => `${n} ${n === 1 ? a : many}`;
  const parts = [ready ? `${one(ready, 'context update', 'context updates')} ready for you` : '', toAnalyze ? `${toAnalyze} to analyze` : ''];
  return parts.filter(Boolean).join(', ');
}
