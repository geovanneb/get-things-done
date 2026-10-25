// Run in a zone far from UTC, so any day key built through UTC lands on the wrong date.
process.env.TZ = 'Asia/Tokyo';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  buildCalendar,
  buildDayDetail,
  dayKey,
  daysInRange,
  parseDayKey,
  parseCalendarWindow,
  windowRange,
} from '../src/services/insightsCalendar';
import type { TaskFacts, RawTask } from '../src/services/insightsService';
import insightsRouter from '../src/routes/insights';

const at = (iso: string) => new Date(iso);

function facts(partial: Partial<TaskFacts> & { id: string; title?: string; due?: string }): TaskFacts {
  const task = {
    id: partial.id,
    title: partial.title ?? partial.id,
    status: partial.status ?? 'in_progress',
    priority: 'medium',
    due_date: partial.due,
  } as unknown as RawTask;
  return {
    task,
    status: partial.status ?? 'in_progress',
    createdAt: partial.createdAt ?? null,
    completedAt: partial.completedAt ?? null,
    lastExecutionAt: null,
    runs: partial.runTimes?.length ?? 0,
    runTimes: partial.runTimes ?? [],
    lastActivityAt: null,
    stakeholderRefs: partial.stakeholderRefs ?? [],
    templateRefs: [],
  };
}

const names = new Map([
  ['alex-morgan', 'Alex Morgan'],
  ['finance-team', 'Finance Team'],
]);

test('days are local days: 23:30 UTC is the next morning in Tokyo', () => {
  const now = at('2026-03-10T00:00:00Z');
  const cal = buildCalendar(
    [facts({ id: 'TASK-001', createdAt: at('2026-03-01T23:30:00Z') })],
    '2026-03-01',
    '2026-03-02',
    now,
    names,
  );
  assert.equal(cal.days[0].created, 0);
  assert.equal(cal.days[1].created, 1);
  assert.equal(cal.days[1].by_hour?.[8], 1);
  assert.equal(dayKey(at('2026-03-01T15:00:00Z')), '2026-03-02');
});

test('a day counts created, completed, runs, due and overdue, and ranks its tasks', () => {
  const now = at('2026-03-20T03:00:00Z'); // 12:00 on 20 March in Tokyo
  const day = '2026-03-05';
  const all = [
    facts({
      id: 'TASK-001',
      title: 'Board deck',
      createdAt: at('2026-03-05T00:00:00Z'),
      completedAt: at('2026-03-05T08:00:00Z'),
      runTimes: [at('2026-03-05T01:00:00Z'), at('2026-03-05T02:00:00Z')],
      stakeholderRefs: ['alex-morgan'],
      status: 'done',
    }),
    facts({
      id: 'TASK-002',
      title: 'Forecast',
      runTimes: [at('2026-03-05T05:00:00Z')],
      stakeholderRefs: ['alex-morgan', 'finance-team'],
    }),
    // Due that day, still open, and the day is over: overdue.
    facts({ id: 'TASK-003', title: 'Carrier review', due: day }),
    // Due that day but finished: due, not overdue.
    facts({ id: 'TASK-004', title: 'Archive memo', due: day, status: 'done' }),
    // Outside the range: ignored.
    facts({ id: 'TASK-005', createdAt: at('2026-04-01T00:00:00Z') }),
  ];

  const row = buildCalendar(all, day, day, now, names).days[0];
  assert.deepEqual(
    { ...row, by_hour: undefined },
    {
      date: day,
      created: 1,
      completed: 1,
      runs: 3,
      due: 2,
      overdue: 1,
      activity: 5,
      task_count: 4,
      top_tasks: [
        { id: 'TASK-001', title: 'Board deck' },
        { id: 'TASK-002', title: 'Forecast' },
        { id: 'TASK-004', title: 'Archive memo' },
      ],
      top_stakeholders: [
        { ref: 'alex-morgan', name: 'Alex Morgan' },
        { ref: 'finance-team', name: 'Finance Team' },
      ],
      by_hour: undefined,
    },
  );
  // Due dates have no time of day, so the hours only hold the five timed events.
  assert.equal(row.by_hour?.reduce((a, b) => a + b, 0), 5);

  const detail = buildDayDetail(all, day, now, names);
  assert.equal(detail.totals.activity, 5);
  assert.deepEqual(detail.tasks[0].events, ['created', 'ran', 'completed']);
  assert.equal(detail.tasks[0].runs, 2);
  assert.deepEqual(detail.tasks[1].stakeholders, ['Alex Morgan', 'Finance Team']);
  assert.deepEqual(detail.tasks.find((t) => t.id === 'TASK-003')?.events, ['due']);
  assert.equal(detail.tasks.find((t) => t.id === 'TASK-003')?.overdue, true);
  assert.equal(detail.tasks.find((t) => t.id === 'TASK-004')?.overdue, false);
  assert.deepEqual(detail.stakeholders[0], { ref: 'alex-morgan', name: 'Alex Morgan', count: 2 });
});

test('a task due today is not overdue until the day is over', () => {
  const now = at('2026-03-05T14:00:00Z'); // 23:00 on 5 March in Tokyo
  const row = buildCalendar([facts({ id: 'TASK-001', due: '2026-03-05' })], '2026-03-05', '2026-03-05', now, names).days[0];
  assert.equal(row.due, 1);
  assert.equal(row.overdue, 0);
});

test('every day in range is returned, across month ends and a leap day', () => {
  assert.deepEqual(daysInRange('2028-02-27', '2028-03-01'), [
    '2028-02-27',
    '2028-02-28',
    '2028-02-29',
    '2028-03-01',
  ]);
  assert.equal(daysInRange('2026-12-30', '2027-01-02').length, 4);
  const cal = buildCalendar([], '2026-01-01', '2026-12-31', at('2026-06-01T00:00:00Z'), names);
  assert.equal(cal.days.length, 365);
  assert.equal(cal.days[0].by_hour, undefined, 'long ranges skip the hourly breakdown');
  assert.equal(cal.today, '2026-06-01');
});

test('day keys must be real dates in strict YYYY-MM-DD', () => {
  assert.equal(parseDayKey('2028-02-29'), '2028-02-29');
  for (const bad of ['2027-02-29', '2026-02-30', '2026-13-01', '2026-1-01', '2026-01-01T00:00', ' 2026-01-01', '', 20260101, ['2026-01-01'], null, undefined]) {
    assert.equal(parseDayKey(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the calendar takes the same windows as the Insights filter', () => {
  assert.equal(parseCalendarWindow('7'), 7);
  assert.equal(parseCalendarWindow('90'), 90);
  assert.equal(parseCalendarWindow('all'), null);
  for (const bad of [undefined, '', '14', '30.0', ' 30', '-7', 'ALL', ['30', '90'], 30]) {
    assert.equal(parseCalendarWindow(bad), undefined, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a window is the last N whole local days, and all time starts at the first activity', () => {
  const now = at('2026-03-10T01:00:00Z'); // 10:00 on 10 March in Tokyo
  assert.deepEqual(windowRange(7, [], now), { from: '2026-03-04', to: '2026-03-10' });
  assert.deepEqual(windowRange(30, [], now), { from: '2026-02-09', to: '2026-03-10' });
  assert.deepEqual(windowRange(null, [], now), { from: '2026-03-10', to: '2026-03-10' });
  const old = [
    facts({ id: 'TASK-001', createdAt: at('2025-11-30T20:00:00Z') }), // 1 Dec in Tokyo
    facts({ id: 'TASK-002', runTimes: [at('2026-01-05T00:00:00Z')] }),
  ];
  assert.deepEqual(windowRange(null, old, now), { from: '2025-12-01', to: '2026-03-10' });
});

test('calendar endpoints read a workspace and reject bad input with 400', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-calendar-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const taskDir = path.join(dir, 'tasks', 'active', 'TASK-001');
  await fsp.mkdir(path.join(taskDir, 'executions'), { recursive: true });
  await fsp.writeFile(
    path.join(taskDir, 'task.md'),
    [
      '---',
      'id: TASK-001',
      'title: Prepare carrier review',
      'status: in_review',
      'priority: high',
      "created_at: '2026-03-04T23:30:00Z'",
      "updated_at: '2026-03-05T02:00:00Z'",
      "due_date: '2026-03-06'",
      '---',
      '',
      'Fictional task.',
      '',
    ].join('\n'),
  );
  await fsp.writeFile(path.join(taskDir, 'executions', '2026-03-05T01-00-00Z.md'), '# Run\n');

  // Archived work lives in its own folder and must still count.
  const archivedDir = path.join(dir, 'tasks', 'archive', 'TASK-002');
  await fsp.mkdir(path.join(archivedDir, 'executions'), { recursive: true });
  await fsp.writeFile(
    path.join(archivedDir, 'task.md'),
    [
      '---',
      'id: TASK-002',
      'title: Archived vendor memo',
      'status: archived',
      'priority: low',
      "created_at: '2026-03-02T00:00:00Z'",
      "updated_at: '2026-04-01T00:00:00Z'",
      "done_date: '2026-03-03T06:00:00Z'",
      '---',
      '',
    ].join('\n'),
  );
  await fsp.writeFile(path.join(archivedDir, 'executions', '2026-03-03T02-00-00Z.md'), '# Run\n');
  // A run log with no time anywhere: not in its name, not in its frontmatter.
  await fsp.writeFile(path.join(taskDir, 'executions', 'notes.md'), '# Run without a time\n');

  const app = express();
  app.use('/api/insights', insightsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/insights/calendar`;

  const week = await (await fetch(`${base}?days=7`)).json();
  assert.equal(week.days.length, 7);
  assert.equal(week.window_days, 7);
  assert.equal(week.days.at(-1).date, week.today);

  const range = await fetch(`${base}?days=all`);
  assert.equal(range.status, 200);
  const cal = await range.json();
  assert.equal(cal.from, '2026-03-02', 'all time starts at the first activity, not at a run with no time (1970)');
  assert.equal(cal.window_days, null);
  const fifth = cal.days.find((d: { date: string }) => d.date === '2026-03-05');
  assert.equal(fifth.created, 1, 'created at 08:30 Tokyo time on the 5th');
  assert.equal(fifth.runs, 1);
  assert.equal(cal.days.find((d: { date: string }) => d.date === '2026-03-06').due, 1);
  const third = cal.days.find((d: { date: string }) => d.date === '2026-03-03');
  assert.deepEqual([third.completed, third.runs], [1, 1], 'archived task counts on the day it finished');

  const all = await (await fetch(base.replace('/calendar', '?days=all'))).json();
  assert.equal(all.summary.completed, 1, 'Insights counts archived work too');

  const day = await (await fetch(`${base}/day/2026-03-05`)).json();
  assert.equal(day.tasks[0].id, 'TASK-001');
  assert.deepEqual(day.tasks[0].events, ['created', 'ran']);

  for (const url of [
    `${base}`,
    `${base}?days=14`,
    `${base}?days=30&days=90`,
    `${base}?days=..%2F`,
    `${base}/day/2026-02-30`,
    `${base}/day/..%2F..%2Fetc`,
  ]) {
    const res = await fetch(url);
    assert.equal(res.status, 400, url);
    assert.match((await res.json()).error, /^Invalid/);
  }
});
