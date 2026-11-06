/**
 * Unit tests for the search overlay's result order. Run with `npm run test:search-results --workspace=ui`.
 */
import { arrangeResults, clampIndex, latestOnly } from './searchResults';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

// Ranked results of mixed types: the server orders by rank, not by type.
const ranked = [
  { id: 'task-a', type: 'task' },
  { id: 'note-b', type: 'context' },
  { id: 'task-c', type: 'task' },
];
const { groups, ordered } = arrangeResults(ranked);

check('groups keep the order their best result came in',
  groups.map((g) => g.type).join(',') === 'task,context', groups.map((g) => g.type).join(','));
check('the displayed order lists each group together',
  ordered.map((r) => r.id).join(',') === 'task-a,task-c,note-b', ordered.map((r) => r.id).join(','));

const indexes = groups.flatMap((g) => g.items.map((i) => `${i.result.id}:${i.index}`));
check('every row has its own index, matching the displayed order',
  indexes.join(',') === 'task-a:0,task-c:1,note-b:2', indexes.join(','));
check('Enter on a highlighted row opens that row',
  groups.every((g) => g.items.every((i) => ordered[i.index] === i.result)));

check('no results: no groups', arrangeResults([]).groups.length === 0 && arrangeResults([]).ordered.length === 0);

check('the highlight stays inside a shorter list', clampIndex(5, 2) === 1);
check('an empty list never gives a negative index', clampIndex(0, 0) === 0 && clampIndex(-1, 0) === 0);
check('a highlight already inside is kept', clampIndex(1, 3) === 1);

const latest = latestOnly();
const first = latest.start();
const second = latest.start();
check('an earlier search is stale once a newer one starts', !latest.isLatest(first) && latest.isLatest(second));
latest.cancel();
check('clearing or closing makes the running search stale', !latest.isLatest(second));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll search result checks passed');
