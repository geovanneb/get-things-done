/**
 * Unit tests for the board's columns. Run with `npm run test:board-columns --workspace=ui`.
 */
import type { Task } from '../types';
import {
  DEFAULT_BOARD, columnFor, dropUpdate, isDefaultBoard, labelError, moveColumn, newColumnId, placeTasks,
  statusesWithoutColumn, type BoardColumn,
} from './boardColumns';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const defaults = DEFAULT_BOARD.columns;
const at = (status: Task['status'], columns: BoardColumn[], board_column?: string) => columnFor({ status, board_column }, columns);

// The default board puts every status where the four fixed columns always did.
const before: Record<string, string | null> = {
  backlog: 'backlog', ready: 'backlog', in_progress: 'in_progress', blocked: 'in_progress', review: 'in_progress',
  in_review: 'needs_review', done: 'done', approved: 'done',
};
for (const [status, column] of Object.entries(before)) {
  check(`default board: ${status} stays in ${column}`, at(status as Task['status'], defaults) === column);
}
check('an unknown status is on no column, not dropped silently', at('someday' as Task['status'], defaults) === null);

// A board with a column split off: Waiting on others shares In Progress, Blocked takes the blocked tasks.
const custom: BoardColumn[] = [
  { id: 'backlog', label: 'Inbox', status: 'backlog' },
  { id: 'col-waiting', label: 'Waiting on others', status: 'in_progress' },
  { id: 'in_progress', label: 'In Progress', status: 'in_progress' },
  { id: 'col-blocked', label: 'Blocked', status: 'blocked' },
  { id: 'needs_review', label: 'Needs Review', status: 'in_review' },
];
check('a new column does not pull tasks in: without a remembered column they stay in the default one', at('in_progress', custom) === 'in_progress');
check('a remembered new column keeps the task', at('in_progress', custom, 'col-waiting') === 'col-waiting');
check('a legacy review task stays in the default In Progress column', at('review', custom) === 'in_progress');
const withoutDefault = custom.filter((c) => c.id !== 'in_progress');
check('without the default column, the leftmost column with the status takes the task', at('in_progress', withoutDefault) === 'col-waiting');
check('a blocked task goes to the Blocked column', at('blocked', custom) === 'col-blocked');
check('a blocked task dropped in an In Progress column may stay there', at('blocked', custom, 'col-waiting') === 'col-waiting');
check('a remembered column that no longer fits the status is ignored (an agent moved it on)', at('in_review', custom, 'col-waiting') === 'needs_review');
check('a remembered column that was deleted is ignored', at('in_progress', custom, 'col-gone') === 'in_progress');
check('a remembered value that is not a string is ignored', columnFor({ status: 'in_progress', board_column: 42 }, custom) === 'in_progress');

// No Done column: done tasks are on no column, and the editor can say so.
const tasks = [
  { id: 'A', status: 'backlog' as const }, { id: 'B', status: 'done' as const },
  { id: 'C', status: 'archived' as const }, { id: 'D', status: 'in_progress' as const, board_column: 'in_progress' },
];
const placed = placeTasks(tasks, custom);
check('placeTasks fills each column in board order', JSON.stringify([...placed.byColumn].map(([id, list]) => [id, list.map((t) => t.id)]))
  === JSON.stringify([['backlog', ['A']], ['col-waiting', []], ['in_progress', ['D']], ['col-blocked', []], ['needs_review', []]]));
check('a task no column shows is reported, not lost', placed.unplaced.map((t) => t.id).join() === 'B');
check('archived tasks are not on the board', ![...placed.byColumn.values()].flat().some((t) => t.id === 'C') && !placed.unplaced.some((t) => t.id === 'C'));
check('statusesWithoutColumn names Done for this board', statusesWithoutColumn(custom).join() === 'done');
check('the default board shows every status', statusesWithoutColumn(defaults).length === 0);
check('blocked is shown while an In Progress column exists', !statusesWithoutColumn([{ id: 'a', label: 'A', status: 'in_progress' }]).includes('blocked'));

// Dropping records the column only when another column has the same status.
check('drop into a column with its own status: no column recorded', JSON.stringify(dropUpdate(defaults[2], defaults)) === JSON.stringify({ status: 'in_review', board_column: null }));
check('drop into a shared status: the column is recorded', JSON.stringify(dropUpdate(custom[1], custom)) === JSON.stringify({ status: 'in_progress', board_column: 'col-waiting' }));
check('drop into a Blocked column sets blocked', dropUpdate(custom[3], custom).status === 'blocked');

// Editing helpers.
const ids = (cols: BoardColumn[]) => cols.map((c) => c.id).join();
check('move a column right', ids(moveColumn(defaults, 0, 2)) === 'in_progress,needs_review,backlog,done');
check('move a column left', ids(moveColumn(defaults, 3, 0)) === 'done,backlog,in_progress,needs_review');
check('moves are clamped', ids(moveColumn(defaults, 1, 99)) === 'backlog,needs_review,done,in_progress');
check('a move out of range does nothing', moveColumn(defaults, 9, 0) === defaults);
check('a move does not change the original list', ids(defaults) === 'backlog,in_progress,needs_review,done');

const sequence = [0.5, 0.5, 0.25];
const id = newColumnId([{ id: newColumnId([], () => 0.5), label: 'x', status: 'backlog' }], () => sequence.shift() ?? 0.1);
check('a new id never repeats an existing one', id !== newColumnId([], () => 0.5) && /^col-[a-z0-9]{6}$/.test(id), id);
check('new ids match the saved id pattern', /^[a-z][a-z0-9_-]{0,39}$/.test(newColumnId(defaults)));

const named = (labels: string[]) => labels.map((label, i) => ({ id: `c${i}`, label, status: 'backlog' as const }));
check('an empty name is an error', labelError(named(['  ']), 0) === 'Enter a name.');
check('a long name is an error', labelError(named(['x'.repeat(41)]), 0) === 'Use at most 40 characters.');
check('a repeated name is an error, ignoring case and spaces', labelError(named(['Doing', ' doing ']), 1) === 'Another column has this name.');
check('a good name has no error', labelError(named(['Doing', 'Done']), 1) === null);

check('the default board is recognized', isDefaultBoard(DEFAULT_BOARD.columns.map((c) => ({ ...c }))));
check('a renamed column is not the default', !isDefaultBoard(defaults.map((c, i) => (i === 0 ? { ...c, label: 'Inbox' } : c))));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll board column checks passed');
