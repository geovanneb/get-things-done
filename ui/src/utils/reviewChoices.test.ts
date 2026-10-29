/**
 * Unit tests for review choices that are saved one by one. Run with `npm run test:review-choices --workspace=ui`.
 */
import { mergeServerChoices, PendingChoices, shownChoice } from './reviewChoices';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

type C = 'confirmed' | 'rejected' | null;

check('a cleared choice shows as cleared, not as the saved one', shownChoice<C>({ 'M-01': null }, 'M-01', 'confirmed') === null);
check('without a local choice the saved one shows', shownChoice<C>({}, 'M-01', 'confirmed') === 'confirmed');

const merged = mergeServerChoices<C>({ 'M-01': 'rejected', 'M-02': 'confirmed' }, { 'M-01': 'confirmed', 'M-02': null }, new Set(['M-01']));
check('a refresh keeps a choice still being saved', merged['M-01'] === 'rejected');
check('a refresh takes the server value for settled choices', merged['M-02'] === null);

const pending = new PendingChoices();
const first = pending.start('M-01');
const second = pending.start('M-01');
const other = pending.start('M-02');
check('only the latest save of a choice may apply its answer', !pending.isLatest('M-01', first) && pending.isLatest('M-01', second));
pending.finish('M-01', first);
check('an older save finishing does not clear the newer one', pending.size === 2 && pending.ids().has('M-01'));
pending.finish('M-01', second);
pending.finish('M-02', other);
check('nothing is pending once every latest save finished', pending.size === 0);

if (failures) { console.error(`${failures} review choice check(s) failed`); process.exit(1); }
console.log('All review choice checks passed');
