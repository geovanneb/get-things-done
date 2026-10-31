/**
 * Unit tests for catching up after the live event stream was down (#201). Run with `npm run test:live-events --workspace=ui`.
 */
import { streamTracker } from './liveEvents';
import { initialState, reducer } from '../store';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const stream = streamTracker();
check('the first connection is the page starting: nothing to catch up', stream.connected() === false);
check('a reconnect after a drop catches up', (stream.failed(), stream.connected()) === true);
check('a reconnect the browser makes without an error event still catches up', stream.connected() === true);

const late = streamTracker();
late.failed();
late.failed();
check('a stream that fails before it ever connects catches up when it gets through', late.connected() === true);
check('each stream has its own tracker', streamTracker().connected() === false);

// A deleted context update while the stream was down: the sidebar dot reads `context-updates` again only if its
// version moves. Catching up moves every version once, so every dot and open view reads again.
const before = initialState.dataVersions;
const after = reducer(initialState, { type: 'ALL_DATA_CHANGED' }).dataVersions;
const scopes = Object.keys(before) as (keyof typeof before)[];
check('catching up bumps every data slice once', scopes.every((s) => after[s] === before[s] + 1), JSON.stringify(after));
check('the context update count is among them', after['context-updates'] === before['context-updates'] + 1);

// An update action now also tells the shared count, not only its own page.
const deleted = reducer(initialState, { type: 'DATA_CHANGED', payload: 'context-updates' }).dataVersions;
check('a context update change moves only its own slice',
  scopes.every((s) => deleted[s] === before[s] + (s === 'context-updates' ? 1 : 0)));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll live event checks passed');
