/**
 * Unit tests for the context update types and filter. Run with `npm run test:update-types --workspace=ui`.
 */
import { waitingCounts, waitingLabel, waitingOnUser, filterUpdates, typeCounts, updateType } from './updateTypes';

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
check('the get-started interview is its own type', updateType({ origin: 'onboarding', kind: 'first-context' }) === 'first-context');
check('a correction is told from a digest by its kind',
  updateType({ origin: 'meetings', kind: 'meeting-correction' }) === 'meeting-correction' && updateType({ origin: 'meetings', kind: 'daily-digest' }) === 'meeting-digest');
check('a follow-up of a correction is its own type', updateType({ origin: 'meetings', kind: 'correction-follow-up' }) === 'correction-follow-up');

check('all with no query keeps everything', filterUpdates(updates, 'all', '').length === updates.length);
const imported = filterUpdates(updates, 'imported', '');
check('the type filter keeps only that type', imported.length === 2 && imported.every((u) => !u.origin));
check('the query matches the title in any case', filterUpdates(updates, 'all', '  LOGISTICS ').map((u) => u.id).join() === 'CU-2026-0001');
check('the query matches the id', filterUpdates(updates, 'all', '0003').map((u) => u.id).join() === 'CU-2026-0003');
check('type and query combine', filterUpdates(updates, 'meeting-digest', 'logistics').length === 0);

const counts = typeCounts(updates);
check('counts per type', counts.imported === 2 && counts['meeting-digest'] === 1 && counts['memory-review'] === 1 && counts.kaizen === 1 && counts.other === 1);
check('types with no update are left out', !('imported' in typeCounts([{ origin: 'meetings' }])));

// #246: whose move it is.
const waiting = waitingCounts([{ status: 'ready' }, { status: 'ready' }, { status: 'in_review' }, { status: 'approved' }, { status: 'analyzing' }, { status: 'applying' }, { status: 'done' }]);
check('ready for you: review and apply; to analyze: material only; runs and history in neither', waiting.ready === 2 && waiting.toAnalyze === 2);
check('both counts in words', waitingLabel(waiting) === '2 context updates ready for you, 2 to analyze');
check('one ready, none to analyze', waitingLabel({ ready: 1, toAnalyze: 0 }) === '1 context update ready for you');
check('only to analyze', waitingLabel({ ready: 0, toAnalyze: 3 }) === '3 to analyze');

// The sidebar dot: material to analyze waits on the user, unless the server marks it as the agent's move.
const mixed = [{ id: 'CU-1', status: 'ready' as const }, { id: 'CU-2', status: 'ready' as const }, { id: 'CU-3', status: 'in_review' as const }, { id: 'CU-4', status: 'analyzing' as const }];
const none = waitingOnUser(mixed);
check('nothing waiting on the agent: every update to analyze waits on the user', none.ready === 1 && none.toAnalyze === 2);
const agent = waitingOnUser(mixed.map((u) => (u.id === 'CU-2' ? { ...u, waits_on_agent: true as const } : u)));
check('an update waiting on the agent is left out', agent.ready === 1 && agent.toAnalyze === 1);
check('an update in review is counted whatever it says', waitingOnUser([{ status: 'in_review', waits_on_agent: true }]).ready === 1);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll update type checks passed.');
