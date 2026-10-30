import type { ContextUpdate } from '@/types';

/**
 * What kind of update it is, from who opened it. One list of types feeds the filter, the badge and the counts,
 * so a new kind of update (Kaizen next) is one more entry here.
 */
export type UpdateType = 'imported' | 'meeting-digest' | 'memory-review' | 'other';

export const UPDATE_TYPES: { id: UpdateType; label: string; hint: string }[] = [
  { id: 'imported', label: 'Imported', hint: 'Material you imported: files or a pasted transcript.' },
  { id: 'meeting-digest', label: 'Meeting digest', hint: 'Made by the Meeting digest routine from queued meetings.' },
  { id: 'memory-review', label: 'Memory review', hint: 'Opened by the weekly System cleanup job to review your memory. Set it up under Routines.' },
  { id: 'other', label: 'Other', hint: 'Opened by something this version of the dashboard does not know.' },
];

const BY_ORIGIN: Record<string, UpdateType> = { meetings: 'meeting-digest', 'system-cleanup': 'memory-review' };

export function updateType(u: Pick<ContextUpdate, 'origin'>): UpdateType {
  if (!u.origin) return 'imported';
  return BY_ORIGIN[u.origin] ?? 'other';
}

export function typeMeta(type: UpdateType): { id: UpdateType; label: string; hint: string } {
  return UPDATE_TYPES.find((t) => t.id === type)!;
}

export type TypeFilter = UpdateType | 'all';

/** Updates of the chosen type whose title or id contains the query (any case). */
export function filterUpdates<T extends Pick<ContextUpdate, 'id' | 'title' | 'origin'>>(updates: T[], type: TypeFilter, query: string): T[] {
  const q = query.trim().toLowerCase();
  return updates.filter((u) =>
    (type === 'all' || updateType(u) === type) &&
    (!q || u.title.toLowerCase().includes(q) || u.id.toLowerCase().includes(q)));
}

/** How many updates of each type there are. Types with none are left out. */
export function typeCounts(updates: Pick<ContextUpdate, 'origin'>[]): Partial<Record<UpdateType, number>> {
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
