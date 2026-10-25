/**
 * Unit tests for the activity calendar date maths. Run with `npm run test:calendar --workspace=ui`.
 */
// Far from UTC, so a key built through UTC would land on the wrong day.
process.env.TZ = 'Asia/Tokyo';

import {
  addDays,
  buildScale,
  dayKey,
  endOfMonth,
  keysBetween,
  layoutFor,
  monthsBetween,
  startOfWeek,
  summarize,
  typicalDay,
} from './calendarModel';
import type { InsightsCalendarDay } from '@/types';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function day(date: string, activity: number): InsightsCalendarDay {
  return {
    date, created: activity, completed: 0, runs: 0, due: 0, overdue: 0, activity,
    task_count: activity ? 1 : 0, top_tasks: [], top_stakeholders: [],
  };
}

check('day keys use local dates', dayKey(new Date('2026-03-01T15:30:00Z')) === '2026-03-02');
check('adding days crosses month and year ends', addDays('2026-12-31', 1) === '2027-01-01' && addDays('2028-03-01', -1) === '2028-02-29');
check('weeks start on Sunday', startOfWeek('2026-10-25') === '2026-10-25' && startOfWeek('2026-10-31') === '2026-10-25');

check('each filter window has its own layout',
  same(['7', '30', '90', 'all'].map((w) => layoutFor(w as '7')), ['week', 'month', 'months', 'years']));
check('90 days ending 25 Oct touch four months',
  same(monthsBetween('2026-07-28', '2026-10-25'), ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']));
check('a range inside one month is one month', same(monthsBetween('2026-02-03', '2026-02-20'), ['2026-02-01']));
check('month ends know leap years', endOfMonth('2028-02-10') === '2028-02-29' && endOfMonth('2026-02-10') === '2026-02-28');

const quiet = buildScale([0, 1, 2, 1, 0, 3]);
check('quiet workspaces map counts straight to steps', [0, 1, 2, 3, 4, 5, 9].map(quiet.step).join() === '0,1,2,3,4,5,5');
check('quiet legend reads 1 to 5+', quiet.labels.join() === '1,2,3,4,5+', quiet.labels.join());
const busy = buildScale([...Array(20).fill(10), 200]);
check('one huge day does not wash out the rest', busy.step(10) === 5 && busy.step(200) === 5 && busy.step(4) === 2);
check('typical day ignores empty days', typicalDay([0, 0, 2, 4, 6]) === 4 && typicalDay([0, 0]) === null);

const days = keysBetween('2026-09-01', '2026-09-30').map((d) =>
  // Tuesdays are heavy, one three-day streak around the 15th.
  day(d, new Date(`${d}T12:00:00`).getDay() === 2 ? 4 : ['2026-09-14', '2026-09-16'].includes(d) ? 1 : 0),
);
const callouts = summarize(days, 'activity', 'month');
const find = (label: string) => callouts.find((c) => c.label === label)?.value;
check('busiest day is the first of the heaviest', find('Busiest day') === 'Tue 1 Sep (4)', find('Busiest day'));
check('busiest weekday is by average', find('Busiest weekday') === 'Tuesdays', find('Busiest weekday'));
check('longest streak counts consecutive active days', find('Longest streak') === '3 days in a row', find('Longest streak'));
check('busiest month only on the all-time strips', find('Busiest month') === undefined);
const all = summarize([...days, day('2026-10-02', 30)], 'activity', 'years');
check('busiest month names month and year', all.find((c) => c.label === 'Busiest month')?.value === 'October 2026 (30)');
check('a quiet window has no callouts', summarize([day('2026-10-01', 0)], 'activity', 'week').length === 0);

if (failures > 0) {
  console.error(`\n${failures} calendar check(s) failed`);
  process.exit(1);
}
console.log('\nAll calendar checks passed');
