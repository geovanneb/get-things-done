// A zone with daylight saving: 8 March 2026 is 23 hours long, 1 November is 25.
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { daysInRange, rangeLength, windowRange } from '../src/services/insightsCalendar';
import { InsightsService } from '../src/services/insightsService';

test('ranges neither skip nor repeat a day across daylight saving changes', () => {
  assert.deepEqual(daysInRange('2026-03-07', '2026-03-09'), ['2026-03-07', '2026-03-08', '2026-03-09']);
  assert.deepEqual(daysInRange('2026-10-31', '2026-11-02'), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(rangeLength('2026-01-01', '2026-12-31'), 365);
  assert.equal(daysInRange('2026-01-01', '2026-12-31').length, 365);
  // The 30 days up to 9 March cross the switch to summer time and still count 30.
  const { from, to } = windowRange(30, [], new Date(2026, 2, 9, 12));
  assert.equal(daysInRange(from, to).length, 30);
});

test('the weekly chart keeps every week in the first hour after the spring change', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-weekly-dst-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  // Created Tuesday and Wednesday of the week the clocks went forward (8 March).
  for (const [id, created] of [['TASK-2026-0001', '2026-03-10T16:00:00.000Z'], ['TASK-2026-0002', '2026-03-11T16:00:00.000Z']]) {
    await fsp.mkdir(path.join(dir, 'tasks/active', id), { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'tasks/active', id, 'task.md'),
      `---\nid: ${id}\ntitle: Fictional ${id}\nstatus: backlog\npriority: medium\ncreated_at: '${created}'\nupdated_at: '${created}'\nstakeholders: []\ndeliverables: []\n---\nBody\n`,
    );
  }

  // Sunday 15 March, 00:30: 7 * 24 hours earlier is 23:30 on Saturday 7 March, because
  // that week was an hour short, so the week of 8 March went missing. One hour later is fine.
  for (const now of [new Date(2026, 2, 15, 0, 30), new Date(2026, 2, 15, 1, 30)]) {
    t.mock.timers.enable({ apis: ['Date'], now });
    try {
      const { weekly } = await new InsightsService().getInsightsData(30);
      assert.deepEqual(weekly.map((w) => w.week), ['2026-02-15', '2026-02-22', '2026-03-01', '2026-03-08', '2026-03-15'], now.toString());
      assert.equal(weekly.find((w) => w.week === '2026-03-08')?.created, 2, now.toString());
    } finally {
      t.mock.timers.reset();
    }
  }

  // The autumn change makes a week an hour long: late on Saturday 7 November, 7 * 24
  // hours back is already Sunday 1 November, the current week, listed twice.
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 7, 23, 30) });
  try {
    const { weekly } = await new InsightsService().getInsightsData(30);
    assert.deepEqual(weekly.map((w) => w.week), ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01']);
  } finally {
    t.mock.timers.reset();
  }
});
