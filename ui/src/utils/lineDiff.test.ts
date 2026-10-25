/**
 * Unit tests for the proposal diff. Run with `npm run test:diff --workspace=ui`.
 */
import { diffLines, diffStats, foldUnchanged } from './lineDiff';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const shape = (before: string | null, after: string | null) =>
  diffLines(before, after).map((l) => `${l.kind === 'same' ? ' ' : l.kind === 'add' ? '+' : '-'}${l.text}`).join('|');

check('identical text has no changes', shape('a\nb\n', 'a\nb\n') === ' a| b');
check('a new file is all additions', shape(null, 'a\nb') === '+a|+b');
check('a changed line is a removal then an addition', shape('a\nb\nc', 'a\nB\nc') === ' a|-b|+B| c', shape('a\nb\nc', 'a\nB\nc'));
check('an inserted line keeps the rest unchanged', shape('a\nc', 'a\nb\nc') === ' a|+b| c');
check('a trailing newline is not a change', shape('a\nb', 'a\nb\n') === ' a| b');
check('Windows line endings compare equal', shape('a\r\nb\r\n', 'a\nb\n') === ' a| b');

const numbered = diffLines('x\ny\nz', 'x\nnew\ny\nz');
check('line numbers follow each side', numbered[2]!.oldNo === 2 && numbered[2]!.newNo === 3 && numbered[1]!.newNo === 2 && numbered[1]!.oldNo === undefined);

const stats = diffStats(diffLines('a\nb\nc', 'a\nB\nc\nd'));
check('stats count added and removed lines', stats.added === 2 && stats.removed === 1, JSON.stringify(stats));

const long = Array.from({ length: 30 }, (_, i) => `line ${i}`);
const changed = [...long];
changed[15] = 'changed';
const blocks = foldUnchanged(diffLines(long.join('\n'), changed.join('\n')), 3);
check('unchanged runs far from a change are folded', blocks.map((b) => b.kind).join(',') === 'fold,lines,fold', blocks.map((b) => b.kind).join(','));
check('three lines of context are kept around a change', blocks[1]!.kind === 'lines' && blocks[1]!.lines.length === 8);
check('folded blocks keep their lines so they can be expanded', blocks[0]!.kind === 'fold' && blocks[0]!.count === 12 && blocks[0]!.lines.length === 12);

const short = foldUnchanged(diffLines('a\nb\nc\nd\ne', 'a\nb\nc\nd\nE'), 3);
check('runs shorter than four lines are never folded', short.length === 1 && short[0]!.kind === 'lines');

if (failures) { console.error(`${failures} diff check(s) failed`); process.exit(1); }
