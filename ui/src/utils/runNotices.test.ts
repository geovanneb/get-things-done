/**
 * Unit tests for the run-finished notices (#246). Run with `npm run test:run-notices --workspace=ui`.
 */
import { anotherTabInFront, claimNotice, cleanTitle, finishedRun, markFront, noticeFor, noticeKey, noticeWords, type RunRecord } from './runNotices';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

// A stand-in for the browser's storage, shared like two tabs of one browser.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const run = (command: 'analyze' | 'apply', status: RunRecord['status']): RunRecord => ({ command, status, started_at: '2026-11-04T09:00:00.000Z', ended_at: '2026-11-04T09:05:00.000Z' });
const sync = { title: 'Weekly logistics sync', proposals: 2 };
const words = (n: ReturnType<typeof noticeFor>) => (n ? noticeWords(n) : null);

check('an analysis: ready for your review, with what it proposed',
  JSON.stringify(words(noticeFor('CU-2026-0001', '/w', run('analyze', 'succeeded'), sync))) === JSON.stringify({ title: 'CU-2026-0001 is ready for your review', body: 'Weekly logistics sync: the analysis proposed 2 changes.' }));
check('one change, and none', words(noticeFor('CU-2026-0001', '/w', run('analyze', 'succeeded'), { ...sync, proposals: 1 }))?.body.endsWith('1 change.') === true
  && words(noticeFor('CU-2026-0001', '/w', run('analyze', 'succeeded'), { ...sync, proposals: 0 }))?.body.endsWith('no changes.') === true);
check('the update not read: never said as "no changes"', words(noticeFor('CU-2026-0001', '/w', run('analyze', 'succeeded'), null))?.body === 'the analysis finished. Open it to review.');
check('an apply: applied', words(noticeFor('CU-2026-0001', '/w', run('apply', 'succeeded'), sync))?.title === 'CU-2026-0001 is applied');
check('a failure says to open it', words(noticeFor('CU-2026-0001', '/w', run('analyze', 'failed'), sync))?.title === 'The analysis of CU-2026-0001 did not finish');
check('a run the user stopped, or still going, says nothing', noticeFor('CU-2026-0001', '/w', run('apply', 'cancelled'), sync) === null && noticeFor('CU-2026-0001', '/w', run('apply', 'running'), sync) === null);

check('a title is one line, without control or direction characters', cleanTitle('Weekly\nsync‮⁦ x') === 'Weekly sync x');
check('a long title is shortened, never dropped', cleanTitle('y'.repeat(300)).length === 80);
check('the event names a valid update and its workspace', finishedRun({ update_id: 'CU-2026-0001', workspace: '/w' })?.workspace === '/w' && finishedRun({ update_id: '../x' }) === null && finishedRun(null) === null);

const key = noticeKey({ workspace: '/w', update_id: 'CU-2026-0001', started_at: '2026-11-04T09:00:00.000Z' });
check('one run is one key, apart from the same id in another workspace or a later run',
  key !== noticeKey({ workspace: '/v', update_id: 'CU-2026-0001', started_at: '2026-11-04T09:00:00.000Z' }) && key !== noticeKey({ workspace: '/w', update_id: 'CU-2026-0001', started_at: '2026-11-04T10:00:00.000Z' }));

// Tabs.
markFront('a', true, 1000);
check('another tab in front is seen', anotherTabInFront('b', 2000) === true && anotherTabInFront('a', 2000) === false);
check('a tab in front long ago is taken as gone', anotherTabInFront('b', 1000 + 31_000) === false);
markFront('a', false);
check('a tab leaving the front says so', anotherTabInFront('b', 2000) === false);

void (async () => {
  const first = await claimNotice(key, 'a', () => true, 5000);
  const second = await claimNotice(key, 'b', () => true, 5000);
  check('only one tab says a run', first === true && second === false);
  const other = noticeKey({ workspace: '/w', update_id: 'CU-2026-0002', started_at: '2026-11-04T09:00:00.000Z' });
  check('not said when the last check says no, and still sayable later', (await claimNotice(other, 'a', () => false, 5000)) === false && (await claimNotice(other, 'b', () => true, 5000)) === true);
  // With Web Locks (as in browsers): check and claim happen under one lock, so a paused tab can't also claim.
  let held = Promise.resolve();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (_n: string, cb: () => Promise<boolean>) => { const r = held.then(cb); held = r.then(() => undefined); return r; } } } });
  const third = noticeKey({ workspace: '/w', update_id: 'CU-2026-0003', started_at: '2026-11-04T09:00:00.000Z' });
  const both = await Promise.all([claimNotice(third, 'a', async () => { await new Promise((r) => setTimeout(r, 20)); return true; }, 5000), claimNotice(third, 'b', () => true, 5000)]);
  check('two tabs at once under a lock: exactly one says it', both.filter(Boolean).length === 1);
  await claimNotice('later', 'a', () => true, 5000 + 25 * 60 * 60 * 1000);
  check('claims older than a day are cleared', !store.has(`gtd:run-notice:${key}`));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll run notice checks passed.');
})();
