// A zone with daylight saving: 8 March 2026 is 23 hours long, 1 November is 25.
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysInRange, rangeLength, windowRange } from '../src/services/insightsCalendar';

test('ranges neither skip nor repeat a day across daylight saving changes', () => {
  assert.deepEqual(daysInRange('2026-03-07', '2026-03-09'), ['2026-03-07', '2026-03-08', '2026-03-09']);
  assert.deepEqual(daysInRange('2026-10-31', '2026-11-02'), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(rangeLength('2026-01-01', '2026-12-31'), 365);
  assert.equal(daysInRange('2026-01-01', '2026-12-31').length, 365);
  // The 30 days up to 9 March cross the switch to summer time and still count 30.
  const { from, to } = windowRange(30, [], new Date(2026, 2, 9, 12));
  assert.equal(daysInRange(from, to).length, 30);
});
