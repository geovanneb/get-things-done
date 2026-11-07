/**
 * Unit tests for the context note sharing label in the editor. Run with `npm run test:context-sensitivity --workspace=ui`.
 */
import { sensitivityFormValue, sensitivityPatch, sensitivityState, UNKNOWN_SENSITIVITY } from './contextSensitivity';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

check('missing, null and empty labels are none', ['none', 'none', 'none'].every((s, i) => sensitivityState([undefined, null, ''][i]) === s));
check('known labels are known', sensitivityState('personal') === 'known');
check('other values are unknown, also wrong case and non-strings',
  ['Personal', 'public', true, 3, ['shareable']].every((v) => sensitivityState(v) === 'unknown'));

check('the editor starts from the label, none or unknown',
  sensitivityFormValue('shareable') === 'shareable' && sensitivityFormValue(null) === '' && sensitivityFormValue('Personal') === UNKNOWN_SENSITIVITY);

// A save that does not touch the label never sends it: a newer label set elsewhere, or an unknown one, stays.
check('an untouched label is not sent', same(sensitivityPatch('personal', 'personal'), {}));
check('an untouched unknown label is not sent', same(sensitivityPatch(UNKNOWN_SENSITIVITY, UNKNOWN_SENSITIVITY), {}));
check('an untouched none is not sent', same(sensitivityPatch('', ''), {}));
check('a chosen label is sent', same(sensitivityPatch(UNKNOWN_SENSITIVITY, 'personal'), { sensitivity: 'personal' }));
check('choosing none removes the label', same(sensitivityPatch('shareable', ''), { sensitivity: null }));

if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('All context sensitivity checks passed');
