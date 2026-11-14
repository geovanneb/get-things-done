import type { Task } from '../types';

/**
 * The task panel's draft: what the panel shows and saves, kept apart from the copies the server sends.
 *
 * - `baseline` is the version the draft started from. The draft has unsaved edits when it differs from it, never when
 *   it merely differs from a newer copy read in the background (an agent's update while you type).
 * - `latest` is the newest server copy seen. While there are edits it waits; once the draft is back to its baseline
 *   (edits undone), the panel takes it.
 * - After a save, `savedAt` is the saved version until a copy at least that new arrives: a copy read before the save
 *   (`stale`, or one with an older `updated_at`) can never put the old version back.
 * - What the server showed after a save was sent is kept when its response arrives late: a copy newer than the saved
 *   version (archived, or changed by someone else) and a deletion seen after the request (`seq` orders them) stay.
 * - Unsaved edits are tracked apart from whether they can be saved: a task archived or deleted elsewhere keeps the
 *   draft and its edits, and only saving stops.
 */
export interface TaskDraft {
  draft: Task | null;
  baseline: Task | null;
  latest: Task | null;
  savedAt: string | null;
  stale: Task | null;
  /** The task is gone on the server (deleted elsewhere): the draft is kept so its text can be copied. */
  gone: boolean;
  /** The task was deleted from this panel: its draft is dropped and nothing from the server is taken any more. */
  closed: boolean;
  /** Counts what the server showed (refreshes and 404s), so a save can tell what it saw after it was sent. */
  seq: number;
  /** `seq` when the deletion was seen. */
  goneSeq: number;
  /** `seq` when the last save was sent. */
  saveSeq: number;
}

export type TaskDraftAction =
  | { type: 'refresh'; task: Task }
  | { type: 'edit'; field: string; value: unknown }
  | { type: 'saving' }
  | { type: 'saved'; sent: Task; updatedAt: string }
  | { type: 'reset'; task: Task }
  | { type: 'gone' }
  | { type: 'deleted' };

export const emptyDraft: TaskDraft = { draft: null, baseline: null, latest: null, savedAt: null, stale: null, gone: false, closed: false, seq: 0, goneSeq: 0, saveSeq: 0 };

const same = (a: Task | null, b: Task | null) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The draft differs from the version it started from. */
export function hasEdits(state: TaskDraft): boolean {
  return !!state.draft && !same(state.draft, state.baseline);
}

/** Archived on the server: shown as it was and read-only, whatever the draft's own status says. */
export function isArchived(state: TaskDraft): boolean {
  return state.latest?.status === 'archived';
}

/** Edits can be made and saved: the task still exists and is not archived. */
export function canSave(state: TaskDraft): boolean {
  return !!state.draft && !state.gone && !state.closed && !isArchived(state);
}

/** `a` is an earlier time than `b`. Values that are not dates are never called older. */
function older(a: string | undefined, b: string): boolean {
  const x = Date.parse(a ?? ''), y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && x < y;
}

export function taskDraftReducer(state: TaskDraft, action: TaskDraftAction): TaskDraft {
  if (state.closed) return state;
  switch (action.type) {
    case 'refresh': {
      const { task } = action;
      // Read before the last save: the saved version stays.
      if (state.savedAt && (task === state.stale || older(task.updated_at, state.savedAt))) return state;
      const next = { ...state, latest: task, savedAt: null, stale: null, gone: false, seq: state.seq + 1 };
      if (!state.draft || !hasEdits(state)) return { ...next, draft: task, baseline: task };
      return next;
    }
    case 'edit': {
      if (!state.draft || !canSave(state)) return state;
      const draft = { ...state.draft, [action.field]: action.value } as Task;
      const next = { ...state, draft };
      // Edits undone after a newer copy arrived: there is nothing left to keep, so show the newer copy.
      if (!hasEdits(next) && state.latest && state.latest !== state.baseline) {
        return { ...next, draft: state.latest, baseline: state.latest };
      }
      return next;
    }
    case 'saving':
      return { ...state, saveSeq: state.seq };
    case 'saved': {
      const { sent, updatedAt } = action;
      const baseline = { ...sent, updated_at: updatedAt };
      // Edits typed while the save ran stay unsaved, now measured from the saved version.
      const draft = state.draft === sent || !state.draft ? baseline : { ...state.draft, updated_at: updatedAt };
      // Deleted after the request was sent: still deleted, whenever the response arrives.
      const gone = state.gone && state.goneSeq > state.saveSeq;
      const latest = state.latest;
      // A copy of the saved version or a newer one (archived, changed by someone else) already arrived: it stays.
      if (latest && (latest.updated_at === updatedAt || older(updatedAt, latest.updated_at))) {
        const next = { ...state, draft, baseline, savedAt: updatedAt, stale: null, gone };
        return draft === baseline ? { ...next, draft: latest, baseline: latest } : next;
      }
      const stale = latest && latest.updated_at !== updatedAt ? latest : null;
      return { ...state, draft, baseline, latest: baseline, savedAt: updatedAt, stale, gone };
    }
    case 'reset':
      return { ...emptyDraft, draft: action.task, baseline: action.task, latest: action.task };
    case 'gone':
      return state.gone ? state : { ...state, gone: true, seq: state.seq + 1, goneSeq: state.seq + 1 };
    case 'deleted':
      return { ...state, draft: state.baseline, closed: true };
  }
}
