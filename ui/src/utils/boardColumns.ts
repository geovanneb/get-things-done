import { tr } from '@/i18n/current';
import type { Task } from '../types';

/**
 * The board's columns, saved per workspace (server/src/services/boardColumns.ts has the same shape and checks).
 *
 * A column is a view over task statuses, never a status of its own, so agents, Insights and the workspace rules see
 * the same statuses as before. Each column names the status a task gets when it is dropped there. When several
 * columns share a status ("In Progress" and "Waiting on others"), a dropped task records the column in its
 * `board_column` so it stays there. Every task is placed by `placeTasks`, so renaming, reordering or removing a column
 * never changes a task.
 */
export type BoardColumnStatus = 'backlog' | 'in_progress' | 'blocked' | 'in_review' | 'done';

export interface BoardColumn {
  id: string;
  label: string;
  status: BoardColumnStatus;
}

export interface BoardColumns {
  columns: BoardColumn[];
}

export const MAX_COLUMNS = 12;
export const MAX_LABEL = 40;

/** A default column's saved name follows the interface language; a name someone chose stays as they wrote it. */
export function columnLabel(column: BoardColumn): string {
  const fallback = DEFAULT_BOARD.columns.find((c) => c.id === column.id);
  if (!fallback || fallback.label !== column.label) return column.label;
  return { backlog: tr('routineEditor.backlog'), in_progress: tr('board.columnInProgress'), needs_review: tr('simulation.needsReview'), done: tr('done') }[column.id] ?? column.label;
}

/** The board as it has always been. */
export const DEFAULT_BOARD: BoardColumns = {
  columns: [
    { id: 'backlog', label: 'Backlog', status: 'backlog' },
    { id: 'in_progress', label: 'In Progress', status: 'in_progress' },
    { id: 'needs_review', label: 'Needs Review', status: 'in_review' },
    { id: 'done', label: 'Done', status: 'done' },
  ],
};

/** The statuses a column can give, in workflow order, with the names the rest of the app uses. */
export const COLUMN_STATUSES = (): ReadonlyArray<{ value: BoardColumnStatus; label: string }> => ([
  { value: 'backlog', label: tr('routineEditor.backlog') },
  { value: 'in_progress', label: tr('board.columnInProgress') },
  { value: 'blocked', label: tr('renderer.blocked') },
  { value: 'in_review', label: tr('simulation.needsReview') },
  { value: 'done', label: tr('done') },
]);

/**
 * The task statuses a column shows. The legacy spellings stay where they always were: `ready` with Backlog, `review`
 * with In Progress, `approved` with Done. A blocked task shows in an In Progress column unless a Blocked column exists.
 */
const SHOWS: Record<BoardColumnStatus, ReadonlyArray<Task['status']>> = {
  backlog: ['backlog', 'ready'],
  in_progress: ['in_progress', 'review', 'blocked'],
  blocked: ['blocked'],
  in_review: ['in_review'],
  done: ['done', 'approved'],
};

export function statusLabel(status: BoardColumnStatus): string {
  return COLUMN_STATUSES().find((s) => s.value === status)?.label ?? status;
}

const DEFAULT_IDS = new Set(DEFAULT_BOARD.columns.map((c) => c.id));

/**
 * The column a task shows in, or null when no column shows its status (it is still in the List view).
 * 1. The column it was dropped in, while that column still shows its status.
 * 2. Else a column with exactly its status (a blocked task goes to a Blocked column).
 * 3. Else any column that shows its status (a legacy `review` task goes to In Progress).
 * Within 2 and 3 a default column comes first, so adding a column never pulls tasks into it: it only holds the
 * tasks dropped there. Without a default column, the leftmost one takes them.
 */
export function columnFor(task: Pick<Task, 'status'> & { board_column?: unknown }, columns: BoardColumn[]): string | null {
  const candidates = columns.filter((c) => SHOWS[c.status].includes(task.status));
  if (candidates.length === 0) return null;
  const remembered = candidates.find((c) => c.id === task.board_column);
  if (remembered) return remembered.id;
  const exact = candidates.filter((c) => c.status === task.status);
  const pool = exact.length > 0 ? exact : candidates;
  return (pool.find((c) => DEFAULT_IDS.has(c.id)) ?? pool[0]).id;
}

/** Every open task in its column; `unplaced` holds those no column shows. Archived tasks are not on the board. */
export function placeTasks<T extends Pick<Task, 'status'> & { board_column?: unknown }>(
  tasks: T[], columns: BoardColumn[],
): { byColumn: Map<string, T[]>; unplaced: T[] } {
  const byColumn = new Map<string, T[]>(columns.map((c) => [c.id, []]));
  const unplaced: T[] = [];
  for (const task of tasks) {
    if (task.status === 'archived') continue;
    const id = columnFor(task, columns);
    if (id) byColumn.get(id)!.push(task);
    else unplaced.push(task);
  }
  return { byColumn, unplaced };
}

/** The workflow statuses no column shows, so the editor can say where those tasks would go. */
export function statusesWithoutColumn(columns: BoardColumn[]): BoardColumnStatus[] {
  return COLUMN_STATUSES().map((s) => s.value).filter((status) => columnFor({ status }, columns) === null);
}

/**
 * What a task gets when it is dropped in (or created from) a column. The column is only recorded when another column
 * has the same status; otherwise the status says it all, and `null` clears a column recorded earlier.
 */
export function dropUpdate(column: BoardColumn, columns: BoardColumn[]): { status: BoardColumnStatus; board_column: string | null } {
  const shared = columns.filter((c) => c.status === column.status).length > 1;
  return { status: column.status, board_column: shared ? column.id : null };
}

/** A new, unused id. Random, so a task that remembers a deleted column never lands in a new one by chance. */
export function newColumnId(columns: BoardColumn[], random: () => number = Math.random): string {
  for (;;) {
    const id = `col-${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`;
    if (!columns.some((c) => c.id === id)) return id;
  }
}

export function moveColumn(columns: BoardColumn[], from: number, to: number): BoardColumn[] {
  if (from === to || from < 0 || from >= columns.length) return columns;
  const next = [...columns];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  return next;
}

/** What is wrong with a column's name, in the words the form shows, or null when it is fine. */
export function labelError(columns: BoardColumn[], index: number): string | null {
  const name = columns[index].label.trim();
  if (!name) return tr('boardColumns.enterAName');
  if (name.length > MAX_LABEL) return tr('boardColumns.useAtMostCharacters', { MAX_LABEL });
  if (columns.some((c, i) => i !== index && c.label.trim().toLowerCase() === name.toLowerCase())) return tr('boardColumns.anotherColumnHasThisName');
  return null;
}

export function isDefaultBoard(columns: BoardColumn[]): boolean {
  return JSON.stringify(columns) === JSON.stringify(DEFAULT_BOARD.columns);
}
