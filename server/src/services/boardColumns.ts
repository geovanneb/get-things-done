import { readUiPreference, saveUiPreference } from './uiPreferences';

/**
 * The columns of the task board, kept per workspace in `.situation-board/ui-preferences.json` under `board`.
 *
 * A column is a view over task statuses, never a status of its own: tasks keep the statuses the agents and the
 * workspace rules know (backlog, in_progress, in_review, done...). Each column names the status a task gets when it
 * is dropped there. Two columns may share a status ("In progress" and "Waiting on others"); a task dropped in one of
 * them records the column in its optional `board_column` field, so it stays there. Editing the columns never writes
 * to a task: the dashboard places each task from its status (and the column it was dropped in),
 * and a task no column shows stays in the List view.
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

export class InvalidBoardColumnsError extends Error {}

/** A column id, also the shape of a task's `board_column`. Underscores are allowed because the default ids use them. */
export const BOARD_COLUMN_ID = /^[a-z][a-z0-9_-]{0,39}$/;
export const BOARD_COLUMN_STATUSES: readonly BoardColumnStatus[] = ['backlog', 'in_progress', 'blocked', 'in_review', 'done'];
const MAX_COLUMNS = 12;
const MAX_LABEL = 40;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The board as it has always been. A workspace without saved columns shows it. */
export const DEFAULT_BOARD: BoardColumns = {
  columns: [
    { id: 'backlog', label: 'Backlog', status: 'backlog' },
    { id: 'in_progress', label: 'In Progress', status: 'in_progress' },
    { id: 'needs_review', label: 'Needs Review', status: 'in_review' },
    { id: 'done', label: 'Done', status: 'done' },
  ],
};

/** Checks a request body. TypeScript types do not validate JSON at runtime. */
export function parseBoardColumns(value: unknown): BoardColumns {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidBoardColumnsError('Expected an object with columns.');
  const { columns } = value as { columns?: unknown };
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > MAX_COLUMNS) {
    throw new InvalidBoardColumnsError(`columns must be a list of 1 to ${MAX_COLUMNS} columns.`);
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  const parsed = columns.map((column: unknown, index): BoardColumn => {
    if (!column || typeof column !== 'object' || Array.isArray(column)) throw new InvalidBoardColumnsError(`Column ${index + 1} must be an object.`);
    const { id, label, status } = column as { id?: unknown; label?: unknown; status?: unknown };
    if (typeof id !== 'string' || !BOARD_COLUMN_ID.test(id)) throw new InvalidBoardColumnsError(`Column ${index + 1} has an invalid id.`);
    if (ids.has(id)) throw new InvalidBoardColumnsError(`Two columns have the id ${id}.`);
    ids.add(id);
    const name = typeof label === 'string' ? label.trim() : '';
    if (!name || name.length > MAX_LABEL || CONTROL.test(name)) {
      throw new InvalidBoardColumnsError(`Column ${index + 1} needs a name of 1 to ${MAX_LABEL} characters.`);
    }
    if (labels.has(name.toLowerCase())) throw new InvalidBoardColumnsError(`Two columns are called ${name}.`);
    labels.add(name.toLowerCase());
    if (typeof status !== 'string' || !(BOARD_COLUMN_STATUSES as readonly string[]).includes(status)) {
      throw new InvalidBoardColumnsError(`Column ${index + 1} has an invalid status.`);
    }
    // Only the known keys are stored, so a request cannot put arbitrary data in a git-tracked file.
    return { id, label: name, status: status as BoardColumnStatus };
  });
  return { columns: parsed };
}

export async function readBoardColumns(workspacePath: string): Promise<BoardColumns> {
  const stored = await readUiPreference(workspacePath, 'board');
  try {
    return stored === undefined ? DEFAULT_BOARD : parseBoardColumns(stored);
  } catch {
    // A hand-edited or half-merged value shows the default board rather than a broken one.
    return DEFAULT_BOARD;
  }
}

/** Replaces the board part of the file and keeps every other key as it was. */
export function saveBoardColumns(workspacePath: string, value: unknown): Promise<BoardColumns> {
  return saveUiPreference(workspacePath, 'board', parseBoardColumns(value));
}

/** Back to the default columns: the key is removed, so a later release's default applies. */
export async function resetBoardColumns(workspacePath: string): Promise<BoardColumns> {
  await saveUiPreference(workspacePath, 'board', undefined);
  return DEFAULT_BOARD;
}
