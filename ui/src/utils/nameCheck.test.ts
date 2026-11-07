/**
 * Unit tests for the names and terms panel. Run with `npm run test:name-check --workspace=ui`.
 */
import { checkableDeliverables, visibleFindings, type NameCheckFinding } from './nameCheck';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const items = checkableDeliverables([
  { id: 'DEL-01', file_path: 'tasks/active/T/deliverables/a.md' },
  { id: 'DEL-02', file_path: 'tasks/active/T/deliverables/b.HTML' },
  { id: 'DEL-03', file_path: 'tasks/active/T/deliverables/c.pptx' },
  { id: 'DEL-04' },
  { file_path: 'x.md' },
  { id: 'DEL-05', file_path: 'tasks/active/T/deliverables/notes.txt' },
]);
check('only saved Markdown, HTML and text deliverables can be checked', items.map((d) => d.id).join(',') === 'DEL-01,DEL-02,DEL-05', items.map((d) => d.id).join(','));

const f = (key: string, dismissed: boolean): NameCheckFinding => ({ key, kind: 'abbreviation', found: key, line: 1, snippet: '', count: 1, dismissed });
const split = visibleFindings([f('a', false), f('b', true), f('c', false)]);
check('dismissed findings are kept apart', split.shown.map((x) => x.key).join() === 'a,c' && split.dismissed.map((x) => x.key).join() === 'b');

if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('All name check panel checks passed');
