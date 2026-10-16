/**
 * One definition of what a task status *means*, shared by the Agent Floor and
 * Insights so the two screens can never disagree with the board.
 *
 * The workspace rule (see the workspace CLAUDE.md) is that an agent may only
 * ever set `in_review`; the user moves a task to Done themselves. `approved` is
 * the legacy spelling of Done and is still what every completed task in an
 * existing workspace carries, so both spellings count as finished.
 */

/** Which kanban pile a task belongs to. Mirrors the columns in BoardView. */
export type Pile = 'backlog' | 'active' | 'review' | 'done';

export const BACKLOG_STATUSES = new Set(['backlog', 'ready']);
export const ACTIVE_STATUSES = new Set(['in_progress', 'blocked', 'review']);
export const REVIEW_STATUSES = new Set(['in_review']);
export const DONE_STATUSES = new Set(['done', 'approved']);

export function pileFor(status: string): Pile | null {
  if (BACKLOG_STATUSES.has(status)) return 'backlog';
  if (ACTIVE_STATUSES.has(status)) return 'active';
  if (REVIEW_STATUSES.has(status)) return 'review';
  if (DONE_STATUSES.has(status)) return 'done';
  return null;
}

/** A task that is finished — nothing further is expected from anyone. */
export function isDone(status: string): boolean {
  return DONE_STATUSES.has(status);
}

/** A task parked in Needs Review, waiting on the user rather than an agent. */
export function isAwaitingReview(status: string): boolean {
  return REVIEW_STATUSES.has(status);
}

/** A task still in play: not finished, not archived. */
export function isOpen(status: string): boolean {
  return status !== 'archived' && !DONE_STATUSES.has(status);
}
