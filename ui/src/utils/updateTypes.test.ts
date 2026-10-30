/**
 * Unit tests for the context update types and filter. Run with `npm run test:update-types --workspace=ui`.
 */
import { filterUpdates, typeCounts, updateType } from './updateTypes';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const updates = [
  { id: 'CU-2026-0001', title: 'Weekly logistics sync', origin: null },
  { id: 'CU-2026-0002', title: 'Meeting digest 2026-10-01', origin: 'meetings' },
  { id: 'CU-2026-0003', title: 'Memory review', origin: 'system-cleanup' },
  { id: 'CU-2026-0004', title: 'Board prep', origin: '' },
  { id: 'CU-2026-0005', title: 'Something new', origin: 'future-job' },
  { id: 'CU-2026-0006', title: 'Kaizen from TASK-2026-0001', origin: 'kaizen' },
];

check('no origin is an import', updateType({ origin: null }) === 'imported' && updateType({ origin: '' }) === 'imported');
check('the meeting digest and memory review are told apart by origin',
  updateType({ origin: 'meetings' }) === 'meeting-digest' && updateType({ origin: 'system-cleanup' }) === 'memory-review');
check('an unknown origin is "other", never an import', updateType({ origin: 'future-job' }) === 'other');
check('a Kaizen is its own type', updateType({ origin: 'kaizen' }) === 'kaizen');

check('all with no query keeps everything', filterUpdates(updates, 'all', '').length === updates.length);
const imported = filterUpdates(updates, 'imported', '');
check('the type filter keeps only that type', imported.length === 2 && imported.every((u) => !u.origin));
check('the query matches the title in any case', filterUpdates(updates, 'all', '  LOGISTICS ').map((u) => u.id).join() === 'CU-2026-0001');
check('the query matches the id', filterUpdates(updates, 'all', '0003').map((u) => u.id).join() === 'CU-2026-0003');
check('type and query combine', filterUpdates(updates, 'meeting-digest', 'logistics').length === 0);

const counts = typeCounts(updates);
check('counts per type', counts.imported === 2 && counts['meeting-digest'] === 1 && counts['memory-review'] === 1 && counts.kaizen === 1 && counts.other === 1);
check('types with no update are left out', !('imported' in typeCounts([{ origin: 'meetings' }])));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll update type checks passed.');
