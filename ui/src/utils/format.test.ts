/**
 * Unit tests for relative dates (#361). Run with `npm run test:format --workspace=ui`.
 */
// Far from UTC, so a count made in UTC days or 24-hour periods would land on the wrong day. Run with another TZ
// (for example TZ=America/New_York) to check a zone west of UTC; every case below holds in any zone.
process.env.TZ ||= 'Asia/Tokyo';

import { dueHighlight, formatDueStatus, formatRelativeDate } from './format';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

// A frozen clock. Times are local (no `Z`) and dates are date-only, as a due_date is, so every case is the same in any zone.
const RealDate = Date;
let now = 0;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length) super(...(args as [string]));
    else super(now);
  }
  static now() { return now; }
}
globalThis.Date = FrozenDate as DateConstructor;
const at = (local: string) => { now = new RealDate(local).getTime(); };
const says = (value: string, expected: string) => {
  const actual = formatRelativeDate(value);
  check(`${value} reads "${expected}"`, actual === expected, actual === expected ? '' : `got "${actual}"`);
};

at('2026-11-10T09:00:00');
says('2026-11-10', 'today');
says('2026-11-11', 'tomorrow');
says('2026-11-12', 'in 2 days');
says('2026-11-09T20:00:00', 'yesterday');
says('2026-11-08T20:00:00', '2 days ago');

// Late in the evening: an hour away is already tomorrow.
at('2026-11-10T23:30:00');
says('2026-11-11T00:30:00', 'tomorrow');
says('2026-11-09T00:30:00', 'yesterday');

// Early in the morning: a due date three days ahead is due soon, four days ahead is not yet.
at('2026-11-10T09:00:00');
check('due in 3 calendar days is due soon', formatDueStatus('2026-11-13') === 'due-soon');
check('due in 4 calendar days is upcoming', formatDueStatus('2026-11-14') === 'upcoming');

// The stakeholder page's task list: a task due today is due soon all day, never overdue, in any zone.
const marks = (value: string | undefined, expected: string) => {
  const actual = dueHighlight(value);
  check(`${new Date().toString()}: due ${value} is marked ${expected}`, actual === expected, actual === expected ? '' : `got "${actual}"`);
};
for (const time of ['00:30', '09:30', '12:00', '23:30']) {
  at(`2026-11-10T${time}:00`);
  marks('2026-11-10', 'soon');
  marks('2026-11-09', 'overdue');
  marks('2026-11-13', 'soon');
  marks('2026-11-14', 'none');
}
at('2026-11-09T20:00:00');
marks('2026-11-10', 'soon');
marks(undefined, 'none');
marks('', 'none');
marks('next week', 'none');

globalThis.Date = RealDate;
if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll relative date checks passed.');
