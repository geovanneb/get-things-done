import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SituationService } from '../src/services/situationService';
import { InsightsService } from '../src/services/insightsService';

// A bare due date is a day in the user's own zone. East of UTC (Tokyo), on UTC and
// west of it (New York, whose clocks go back on 1 November 2026, inside the 7- and 14-day windows below).
const ZONES = ['Asia/Tokyo', 'UTC', 'America/New_York'];

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-situation-'));
  const previous = { ws: process.env.ESB_WORKSPACE_PATH, tz: process.env.TZ };
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous.ws === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous.ws;
    if (previous.tz === undefined) delete process.env.TZ;
    else process.env.TZ = previous.tz;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeTask(ws: string, n: number, fields: Record<string, string>): Promise<string> {
  const id = `TASK-2026-${String(n).padStart(4, '0')}`;
  const dir = path.join(ws, 'tasks/active', id);
  await fsp.mkdir(path.join(dir, 'executions'), { recursive: true });
  const extra = Object.entries(fields).map(([k, v]) => `${k}: '${v}'`).join('\n');
  await fsp.writeFile(path.join(dir, 'task.md'), `---
id: ${id}
title: Fictional task ${n}
status: in_progress
priority: medium
created_at: '2026-10-01T00:00:00.000Z'
updated_at: '2026-10-01T00:00:00.000Z'
${extra}
stakeholders: []
deliverables: []
---
Body
`);
  return id;
}

test('Situation: a task is not overdue on its own due date, in any time zone, and agrees with Insights', async (t) => {
  const ws = await workspace(t);
  const today = await writeTask(ws, 1, { due_date: '2026-10-28' });
  const yesterday = await writeTask(ws, 2, { due_date: '2026-10-27' });
  const inSeven = await writeTask(ws, 3, { due_date: '2026-11-04' });
  const inEight = await writeTask(ws, 4, { due_date: '2026-11-05' });
  const inFourteen = await writeTask(ws, 5, { due_date: '2026-11-11' });
  await writeTask(ws, 6, { due_date: '2026-11-12' });
  const unreadable = await writeTask(ws, 7, { due_date: 'next week' });

  for (const zone of ZONES) {
    process.env.TZ = zone;
    // Mid-morning, late evening and just after midnight of the due day, local time.
    for (const hour of [10, 23.5, 0.5]) {
      const now = new Date(2026, 9, 28, Math.floor(hour), (hour % 1) * 60);
      t.mock.timers.enable({ apis: ['Date'], now });
      try {
        const label = `${zone} ${now.toString()}`;
        const s = await new SituationService().getSituationData();
        const reasons = new Map(s.attention_queue.map((a) => [a.id, a.reason]));
        assert.equal(s.overdue_count, 1, `${label}: only yesterday's task is overdue`);
        assert.equal(reasons.get(yesterday), 'overdue', label);
        assert.equal(reasons.get(today), 'due_soon', `${label}: due today is due soon, not overdue`);
        assert.equal(s.due_soon_count, 2, `${label}: today and 7 days out`);
        assert.equal(reasons.get(inSeven), 'due_soon', label);
        assert.ok(!reasons.has(inEight), `${label}: 8 days out is not due soon`);
        assert.ok(!reasons.has(unreadable), `${label}: an unreadable due date is neither overdue nor due soon`);
        assert.deepEqual(
          s.upcoming_commitments.map((u) => u.id),
          [today, inSeven, inEight, inFourteen],
          `${label}: the next 14 calendar days, soonest first`,
        );

        const insights = await new InsightsService().getInsightsData(30);
        assert.equal(insights.summary.overdue, s.overdue_count, `${label}: Situation and Insights agree on overdue`);
      } finally {
        t.mock.timers.reset();
      }
    }
  }
});

test('Situation: current focus lists the earliest due day first, then tasks without a usable due date', async (t) => {
  const ws = await workspace(t);
  const later = await writeTask(ws, 1, { due_date: '2026-11-12' });
  const none = await writeTask(ws, 2, {});
  const sooner = await writeTask(ws, 3, { due_date: '2026-11-11' });

  process.env.TZ = 'Asia/Tokyo';
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 10, 12) });
  try {
    const s = await new SituationService().getSituationData();
    assert.deepEqual(s.current_focus.map((f) => f.id), [sooner, later, none]);
  } finally {
    t.mock.timers.reset();
  }
});

test('Situation: progress counts the whole due day, in any time zone', async (t) => {
  const ws = await workspace(t);
  for (const zone of ZONES) {
    process.env.TZ = zone;
    // Started at local midnight the day before, due today: at noon, 36 of the 48 hours have passed.
    const id = await writeTask(ws, 1, { start_date: new Date(2026, 9, 27).toISOString(), due_date: '2026-10-28' });
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 28, 12) });
    try {
      const s = await new SituationService().getSituationData();
      const focus = s.current_focus.find((f) => f.id === id);
      assert.equal(focus?.progress, 75, `${zone}: noon on the due day is 75%, not past the deadline`);
    } finally {
      t.mock.timers.reset();
    }
  }
});
