import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describeSchedule, nextOccurrences, occurrencesBetween, parseSchedule } from '../src/services/routineSchedule';
import { RoutineService, fillTitle, occurrenceKey, routineId } from '../src/services/routineService';
import { TaskService } from '../src/services/taskService';

/** A throwaway fictional workspace; services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-rt-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await fsp.mkdir(path.join(dir, 'tasks', 'active'), { recursive: true });
  return dir;
}

const local = (s: string) => new Date(s); // "YYYY-MM-DDTHH:MM" without a zone is local time
const keys = (dates: Date[]) => dates.map(occurrenceKey);

const biweeklyPrep = {
  title: 'Steering sync prep',
  schedule: { frequency: 'weekly', interval: 2, weekdays: ['mon'], time: '08:00', starts_on: '2026-10-26' },
  task: { title: 'Prepare steering sync ({{due_date}})', priority: 'high', due_offset_days: 2, body: 'Collect the open decisions.' },
};

test('weekly schedules count intervals from the week of starts_on', () => {
  const s = parseSchedule(biweeklyPrep.schedule);
  assert.deepEqual(keys(occurrencesBetween(s, local('2026-10-01T00:00'), local('2026-12-01T00:00'))),
    ['2026-10-26T08:00', '2026-11-09T08:00', '2026-11-23T08:00']);
  assert.equal(describeSchedule(s), 'Every 2 weeks on Monday at 08:00');

  const weekdays = parseSchedule({ frequency: 'weekly', weekdays: ['fri', 'mon', 'tue', 'wed', 'thu'], time: '07:30', starts_on: '2026-10-28' });
  assert.equal(describeSchedule(weekdays), 'Every weekday at 07:30');
  assert.equal(nextOccurrences(weekdays, local('2026-10-30T08:00'), 1).map(occurrenceKey)[0], '2026-11-02T07:30');
});

test('monthly schedules clamp to short months and support "first/last weekday"', () => {
  const day31 = parseSchedule({ frequency: 'monthly', month_day: 31, time: '09:00', starts_on: '2026-01-31' });
  assert.deepEqual(keys(occurrencesBetween(day31, local('2026-01-01T00:00'), local('2026-04-01T00:00'))),
    ['2026-01-31T09:00', '2026-02-28T09:00', '2026-03-31T09:00']);

  const firstMonday = parseSchedule({ frequency: 'monthly', month_week: 1, month_weekday: 'mon', time: '09:00', starts_on: '2026-01-01' });
  assert.deepEqual(keys(nextOccurrences(firstMonday, local('2026-10-01T00:00'), 3)), ['2026-10-05T09:00', '2026-11-02T09:00', '2026-12-07T09:00']);
  assert.equal(describeSchedule(firstMonday), 'Every month on the first Monday at 09:00');

  const lastFriday = parseSchedule({ frequency: 'monthly', month_week: -1, month_weekday: 'fri', time: '16:00', starts_on: '2026-01-01' });
  assert.deepEqual(keys(nextOccurrences(lastFriday, local('2026-10-01T00:00'), 2)), ['2026-10-30T16:00', '2026-11-27T16:00']);
});

test('schedules from requests are validated', () => {
  for (const bad of [
    null, {}, { frequency: 'hourly', starts_on: '2026-01-01' },
    { frequency: 'daily', starts_on: '2026-02-30' },
    { frequency: 'daily', starts_on: '2026-01-01', time: '25:00' },
    { frequency: 'daily', starts_on: '2026-01-01', interval: 0 },
    { frequency: 'weekly', starts_on: '2026-01-01', weekdays: [] },
    { frequency: 'weekly', starts_on: '2026-01-01', weekdays: ['funday'] },
    { frequency: 'monthly', starts_on: '2026-01-01', month_day: 0 },
    { frequency: 'daily', starts_on: '2026-02-01', ends_on: '2026-01-01' },
  ]) assert.throws(() => parseSchedule(bad), JSON.stringify(bad));

  assert.equal(routineId('RT-0001'), 'RT-0001');
  for (const bad of ['../RT-0001', 'RT-1', 'rt-0001', 'RT-0001.md', '']) assert.throws(() => routineId(bad));
  assert.equal(fillTitle('Prep ({{due_date}}) {{ date }}', '2026-10-26', '2026-10-28'), 'Prep (2026-10-28) 2026-10-26');
});

test('a routine creates its task when due, with the due date offset and the occurrence recorded', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  const created = await service.create(biweeklyPrep, local('2026-10-25T12:00'));
  assert.equal(created.id, 'RT-0001');
  assert.equal(created.next_run_at, local('2026-10-26T08:00').toISOString());

  // Not yet due: nothing happens.
  assert.deepEqual(await service.runDue('timer', local('2026-10-26T07:59')), []);

  const [run] = await service.runDue('timer', local('2026-10-26T08:01'));
  assert.equal(run!.status, 'ok');
  assert.equal(run!.created.length, 1);
  const task = await new TaskService().getTask(run!.created[0]!);
  assert.equal(task.title, 'Prepare steering sync (2026-10-28)');
  assert.equal(task.due_date, '2026-10-28');
  assert.equal(task.priority, 'high');
  assert.equal(task.status, 'backlog');
  assert.equal(task['routine_ref'], 'RT-0001');
  assert.equal(task['routine_occurrence'], '2026-10-26T08:00');
  assert.match(String(task.body), /Collect the open decisions/);

  // The next tick has nothing new.
  assert.deepEqual(await service.runDue('timer', local('2026-10-26T08:02')), []);
  const file = await fsp.readFile(path.join(ws, 'routines', 'RT-0001.md'), 'utf-8');
  assert.match(file, /type: routine/);
});

test('after the computer was off, "latest" creates one task and reports the skipped runs', async (t) => {
  await workspace(t);
  const service = new RoutineService();
  await service.create({ ...biweeklyPrep, schedule: { ...biweeklyPrep.schedule, interval: 1 } }, local('2026-10-25T12:00'));

  // Off for three Mondays.
  const [run] = await service.runDue('startup', local('2026-11-10T10:00'));
  assert.deepEqual(run!.occurrences, ['2026-10-26T08:00', '2026-11-02T08:00', '2026-11-09T08:00']);
  assert.deepEqual(run!.skipped, ['2026-10-26T08:00', '2026-11-02T08:00']);
  assert.equal(run!.created.length, 1);
  const task = await new TaskService().getTask(run!.created[0]!);
  assert.equal(task['routine_occurrence'], '2026-11-09T08:00');
});

test('"all" creates every missed run and "skip" only creates on the scheduled day', async (t) => {
  await workspace(t);
  const service = new RoutineService();
  const daily = { frequency: 'daily', time: '09:00', starts_on: '2026-10-01' };
  await service.create({ title: 'All', catch_up: 'all', schedule: daily, task: { title: 'All {{date}}' } }, local('2026-10-01T00:00'));
  await service.create({ title: 'Skip', catch_up: 'skip', schedule: daily, task: { title: 'Skip {{date}}' } }, local('2026-10-01T00:00'));

  const runs = await service.runDue('startup', local('2026-10-03T08:00'));
  const all = runs.find((r) => r.routine_id === 'RT-0001')!;
  const skip = runs.find((r) => r.routine_id === 'RT-0002')!;
  assert.equal(all.created.length, 2);
  assert.equal(skip.created.length, 0);
  assert.equal(skip.skipped.length, 2);

  const tasks = await new TaskService().listTasks();
  assert.deepEqual(tasks.map((x) => x.title).sort(), ['All 2026-10-01', 'All 2026-10-02']);
});

test('an occurrence that already has a task is never created again (lost state, second machine)', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  await service.create(biweeklyPrep, local('2026-10-25T12:00'));
  await service.runDue('timer', local('2026-10-26T08:01'));

  // State lost, e.g. a fresh clone of a synced workspace.
  await fsp.rm(path.join(ws, '.situation-board', 'routines', 'state.json'));
  const runs = await service.runDue('startup', local('2026-10-26T09:00'));
  assert.equal(runs[0]!.created.length, 0);
  assert.equal((await new TaskService().listTasks()).length, 1);
});

test('concurrent runs from two triggers produce one task', async (t) => {
  await workspace(t);
  const a = new RoutineService();
  const b = new RoutineService();
  await a.create(biweeklyPrep, local('2026-10-25T12:00'));
  await Promise.all([a.runDue('timer', local('2026-10-26T08:01')), b.runDue('cli', local('2026-10-26T08:01'))]);
  assert.equal((await new TaskService().listTasks()).length, 1);
});

test('fresh heartbeats protect old live locks; abandoned ownerless locks are taken over', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  await service.create(biweeklyPrep, local('2026-10-25T12:00'));
  const lock = path.join(ws, '.situation-board', 'routines', 'run.lock');

  await fsp.writeFile(lock, JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
  assert.deepEqual(await service.runDue('cli', local('2026-10-26T08:01')), []);
  assert.equal((await new TaskService().listTasks()).length, 0);

  await fsp.writeFile(lock, JSON.stringify({ pid: process.ppid, at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
  assert.deepEqual(await service.runDue('cli', local('2026-10-26T08:01')), []);
  // A creator may not have written its PID yet: a fresh empty lock is occupied.
  await fsp.writeFile(lock, '');
  assert.deepEqual(await service.runDue('cli', local('2026-10-26T08:01')), []);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  await fsp.utimes(lock, old, old);
  const runs = await service.runDue('cli', local('2026-10-26T08:01'));
  assert.equal(runs[0]!.created.length, 1);
  await assert.rejects(fsp.access(lock));
});

test('pausing and resuming does not back-fill the paused weeks', async (t) => {
  await workspace(t);
  const service = new RoutineService();
  await service.create({ ...biweeklyPrep, schedule: { ...biweeklyPrep.schedule, interval: 1 } }, local('2026-10-25T12:00'));
  await service.update('RT-0001', { enabled: false }, local('2026-10-25T13:00'));
  assert.deepEqual(await service.runDue('timer', local('2026-11-05T10:00')), []);
  await service.update('RT-0001', { enabled: true }, local('2026-11-05T10:00'));
  assert.deepEqual(await service.runDue('timer', local('2026-11-05T10:01')), []);
  const [run] = await service.runDue('timer', local('2026-11-09T08:01'));
  assert.deepEqual(run!.occurrences, ['2026-11-09T08:00']);
});

test('run now creates a task immediately; history lists runs newest first', async (t) => {
  await workspace(t);
  const service = new RoutineService();
  await service.create(biweeklyPrep, local('2026-10-25T12:00'));
  const run = await service.runNow('RT-0001', local('2026-10-25T12:30'));
  assert.equal(run.created.length, 1);
  const again = await service.runNow('RT-0001', local('2026-10-25T12:30'));
  assert.equal(again.created.length, 0);
  await service.runDue('timer', local('2026-10-26T08:01'));
  const history = await service.history();
  assert.deepEqual(history.map((r) => r.trigger), ['timer', 'manual', 'manual']);
  assert.equal((await service.get('RT-0001')).state.last_status, 'ok');
});

test('invalid input is refused and a broken routine file is reported, not hidden', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  await assert.rejects(service.create({ ...biweeklyPrep, task: { title: '' } }), /task.title/);
  await assert.rejects(service.create({ ...biweeklyPrep, task: { ...biweeklyPrep.task, stakeholders: [{ ref: '../x' }] } }), /stakeholders/);
  await assert.rejects(service.create({ ...biweeklyPrep, catch_up: 'sometimes' }), /catch_up/);
  await assert.rejects(service.get('../../etc/passwd'), /Invalid routine id/);

  await fsp.mkdir(path.join(ws, 'routines'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'routines', 'RT-0009.md'), '---\ntitle: Broken\nschedule:\n  frequency: hourly\n---\n');
  const list = await service.list();
  assert.equal(list.length, 1);
  assert.match(String(list[0]!.problem), /frequency/);
  assert.deepEqual(await service.runDue('timer'), []);
});

test('a routine without a name is named after its task title, without placeholders', async (t) => {
  await workspace(t);
  const created = await new RoutineService().create({ schedule: biweeklyPrep.schedule, task: { title: 'Prepare steering sync ({{due_date}})' } });
  assert.equal(created.title, 'Prepare steering sync');
});

test('long-interval and future schedules still have upcoming runs', () => {
  const s = parseSchedule({ frequency: 'monthly', interval: 99, starts_on: '2035-01-01' });
  assert.deepEqual(keys(nextOccurrences(s, local('2026-01-01T00:00'), 2)),
    ['2035-01-01T09:00', '2043-04-01T09:00']);
});

test('broken routines can be deleted and deleted ids are not reused', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  const original = await service.create(biweeklyPrep);
  await fsp.writeFile(path.join(ws, 'routines', `${original.id}.md`), '---\nschedule: broken\n---\n');
  await service.remove(original.id);
  await assert.rejects(fsp.access(path.join(ws, 'routines', `${original.id}.md`)));
  assert.notEqual((await service.create(biweeklyPrep)).id, original.id);
});

test('concurrent creates retain each routine check time', async (t) => {
  await workspace(t);
  const service = new RoutineService();
  const now = local('2026-10-25T12:00');
  const created = await Promise.all(Array.from({ length: 8 }, () => service.create(biweeklyPrep, now)));
  for (const routine of created) assert.equal((await service.get(routine.id)).state.checked_at, now.toISOString());
});

test('preview validates due offsets with the same rules as saving', () => {
  const service = new RoutineService();
  for (const offset of [-1, 366, 1.5, true, [], 'invalid', 1e20]) {
    assert.throws(() => service.preview(biweeklyPrep.schedule, offset), /due_offset_days/);
  }
});


test('an invalid cached check time does not permanently disable a routine', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  await service.create(biweeklyPrep, local('2026-10-25T12:00'));
  await fsp.writeFile(path.join(ws, '.situation-board', 'routines', 'state.json'),
    JSON.stringify({ version: 1, routines: { 'RT-0001': { checked_at: 'invalid' } } }));
  assert.equal((await service.runDue('timer', local('2026-10-26T08:01')))[0]!.created.length, 1);
});

test('an abandoned lock expires even when its PID belongs to a live process', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  await service.create(biweeklyPrep, local('2026-10-25T12:00'));
  const lock = path.join(ws, '.situation-board', 'routines', 'run.lock');
  const old = new Date(Date.now() - 3 * 86_400_000);
  await fsp.writeFile(lock, JSON.stringify({ pid: process.pid, at: old.toISOString() }));
  await fsp.utimes(lock, old, old);
  const runs = await service.runDue('startup', local('2026-10-26T08:01'));
  assert.equal(runs[0]?.created.length, 1);
  await assert.rejects(fsp.access(lock));
});

test('a held lock renews its heartbeat and leaves a replacement owner alone', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  const lock = path.join(ws, '.situation-board', 'routines', 'run.lock');
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => t.mock.timers.reset());
  // Exercise the lease directly so no task write needs to be artificially delayed.
  const lease = service as unknown as { withLock: (fn: () => Promise<void>) => Promise<void> };
  const replacement = JSON.stringify({ pid: process.pid, token: 'replacement-owner' });
  await lease.withLock(async () => {
    const old = new Date(Date.now() - 3 * 86_400_000);
    await fsp.utimes(lock, old, old);
    t.mock.timers.tick(30_000);
    // Timer callbacks enqueue asynchronous filesystem work.
    for (let i = 0; i < 100 && (await fsp.stat(lock)).mtimeMs <= old.getTime(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok((await fsp.stat(lock)).mtimeMs > old.getTime());
    await fsp.unlink(lock);
    await fsp.writeFile(lock, replacement);
    await fsp.utimes(lock, old, old);
    t.mock.timers.tick(30_000);
  });
  assert.equal(await fsp.readFile(lock, 'utf-8'), replacement);
  assert.ok(Date.now() - (await fsp.stat(lock)).mtimeMs > 2 * 60_000,
    'the former owner must not refresh the replacement lock');
  await fsp.unlink(lock);
  await assert.rejects(lease.withLock(async () => { throw new Error('failed operation'); }), /failed operation/);
  await assert.rejects(fsp.access(lock));
});

test('a caught-up task is due relative to its scheduled run, and the run is marked as caught up', async (t) => {
  await workspace(t);
  const service = new RoutineService();
  await service.create(biweeklyPrep, local('2026-10-25T12:00'));
  // The Monday 08:00 run happens on Thursday, after the computer was off.
  const [run] = await service.runDue('startup', local('2026-10-29T10:00'));
  const task = await new TaskService().getTask(run!.created[0]!);
  assert.equal(task.due_date, '2026-10-28');
  assert.equal(task.title, 'Prepare steering sync (2026-10-28)');
  assert.deepEqual(run!.caught_up, ['2026-10-26T08:00']);
  assert.match(run!.message, /caught up/);

  const [onTime] = await service.runDue('timer', local('2026-11-09T08:01'));
  assert.equal(onTime!.caught_up, undefined);
});

test('the task template carries type, contexts, agent, confidentiality and the body verbatim', async (t) => {
  await workspace(t);
  const service = new RoutineService();
  const body = 'Use the format of [@TASK-2026-0003](/tasks/active/TASK-2026-0003/task.md).\n\n- keep it short';
  await service.create({
    ...biweeklyPrep,
    task: {
      ...biweeklyPrep.task, body, task_type: 'presentation', preferred_agent: 'meeting-prep', confidentiality: 'confidential',
      contexts: [{ ref: 'CTX-steering-committee', relevance: 'required' }],
    },
  }, local('2026-10-25T12:00'));
  const [run] = await service.runDue('timer', local('2026-10-26T08:01'));
  const task = await new TaskService().getTask(run!.created[0]!);
  assert.equal(task['task_type'], 'presentation');
  assert.equal(task['preferred_agent'], 'meeting-prep');
  assert.equal(task['confidentiality'], 'confidential');
  assert.deepEqual(task['contexts'], [{ ref: 'CTX-steering-committee', relevance: 'required' }]);
  assert.equal(String(task.body).trim(), body);

  // Without them, the task gets the same default type as New Task and nothing else.
  await service.create({ ...biweeklyPrep, task: { title: 'Plain' } }, local('2026-10-25T12:00'));
  const [plain] = (await service.runDue('timer', local('2026-11-09T08:01'))).filter((r) => r.routine_id === 'RT-0002');
  const plainTask = await new TaskService().getTask(plain!.created[0]!);
  assert.equal(plainTask['task_type'], 'ad_hoc');
  assert.equal(plainTask['contexts'], undefined);
  assert.equal(plainTask['preferred_agent'], undefined);

  for (const bad of [
    { task_type: 'novel' }, { confidentiality: 'secret' }, { preferred_agent: '../agent' },
    { contexts: [{ ref: '' }] }, { contexts: [{ ref: 'CTX-x', relevance: 'maybe' }] },
  ]) {
    await assert.rejects(service.create({ ...biweeklyPrep, task: { ...biweeklyPrep.task, ...bad } }), /Invalid task/, JSON.stringify(bad));
  }
});

test('pause until a date drops the runs before it and resumes on its own', async (t) => {
  await workspace(t);
  const service = new RoutineService();
  const weekly = { ...biweeklyPrep, schedule: { ...biweeklyPrep.schedule, interval: 1 }, paused_until: '2026-11-09' };
  const created = await service.create(weekly, local('2026-10-25T12:00'));
  assert.equal(created.paused_until, '2026-11-09');
  assert.equal(created.next_run_at, local('2026-11-09T08:00').toISOString());

  // Off during the whole pause and back on the resume day: only the resume-day run is created.
  const [run] = await service.runDue('startup', local('2026-11-09T09:00'));
  assert.deepEqual(run!.occurrences, ['2026-11-09T08:00']);
  assert.equal(run!.created.length, 1);
  assert.equal((await new TaskService().listTasks()).length, 1);

  await assert.rejects(service.update('RT-0001', { paused_until: '2026-13-01' }), /paused_until/);
  assert.equal((await service.update('RT-0001', { paused_until: null })).paused_until, null);
});

test('an occurrence whose task was deleted is not created again, even when the state is lost', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  await service.create(biweeklyPrep, local('2026-10-25T12:00'));
  const [run] = await service.runDue('timer', local('2026-10-26T08:01'));
  await new TaskService().deleteTask(run!.created[0]!);
  await fsp.rm(path.join(ws, '.situation-board', 'routines', 'state.json'));
  const again = await service.runDue('startup', local('2026-10-26T09:00'));
  assert.equal(again[0]?.created.length ?? 0, 0);
  assert.equal((await new TaskService().listTasks()).length, 0);
});

test('the editor preview starts after a pause', () => {
  const service = new RoutineService();
  const preview = service.preview(biweeklyPrep.schedule, 2, local('2026-10-25T12:00'), '2026-11-20');
  assert.equal(preview.next_runs[0]!.at, local('2026-11-23T08:00').toISOString());
  assert.throws(() => service.preview(biweeklyPrep.schedule, 2, new Date(), 'soon'), /paused_until/);
});

test('a run that created a task does not also say "nothing new to create"', async (t) => {
  await workspace(t);
  const service = new RoutineService();
  await service.create(biweeklyPrep, local('2026-10-25T12:00'));
  const [run] = await service.runDue('timer', local('2026-10-26T08:01'));
  assert.equal(run!.message, `Created ${run!.created[0]}.`);
  const manual = await service.runNow('RT-0001', local('2026-10-26T12:00'));
  assert.doesNotMatch(manual.message, /Nothing new/);
});

test('switching a routine off and on by editing its file does not back-fill the time it was off', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  await service.create({ ...biweeklyPrep, schedule: { ...biweeklyPrep.schedule, interval: 1 } }, local('2026-10-25T12:00'));
  const file = path.join(ws, 'routines', 'RT-0001.md');
  const original = await fsp.readFile(file, 'utf-8');
  await fsp.writeFile(file, original.replace('enabled: true', 'enabled: false'));
  assert.deepEqual(await service.runDue('timer', local('2026-10-25T12:01')), []);
  await fsp.writeFile(file, original);
  // Three Mondays later: the engine sees it switched back on and starts counting from now.
  assert.deepEqual(await service.runDue('timer', local('2026-11-12T10:00')), []);
  assert.equal((await new TaskService().listTasks()).length, 0);
  const [run] = await service.runDue('timer', local('2026-11-16T08:01'));
  assert.deepEqual(run!.occurrences, ['2026-11-16T08:00']);
});

test('an unquoted HH:MM in a hand-written routine file is read as that time', async (t) => {
  const ws = await workspace(t);
  await fsp.mkdir(path.join(ws, 'routines'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'routines', 'RT-0001.md'),
    '---\ntitle: Evening wrap-up\nschedule:\n  frequency: daily\n  time: 18:30\n  starts_on: 2026-10-01\ntask:\n  title: Wrap up\n---\n');
  const [routine] = await new RoutineService().list(local('2026-10-26T12:00'));
  assert.equal(routine!.problem, undefined);
  assert.equal(routine!.schedule.time, '18:30');
  assert.equal(routine!.next_run_at, local('2026-10-26T18:30').toISOString());
});

test('a routine file symlinked outside the workspace is refused, not read', async (t) => {
  const ws = await workspace(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-rt-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.writeFile(path.join(outside, 'secret.md'), '---\ntitle: Outside\nschedule:\n  frequency: daily\n  starts_on: 2026-10-01\ntask:\n  title: x\n---\n');
  await fsp.mkdir(path.join(ws, 'routines'), { recursive: true });
  await fsp.symlink(path.join(outside, 'secret.md'), path.join(ws, 'routines', 'RT-0001.md'));
  const service = new RoutineService();
  await assert.rejects(service.get('RT-0001'), /outside the workspace/);
  const [listed] = await service.list();
  assert.match(String(listed!.problem), /traversal/);
});

test('routine ids referenced by tasks or receipts are not reused after state.json is lost', async (t) => {
  const ws = await workspace(t);
  const service = new RoutineService();
  await service.create(biweeklyPrep, local('2026-10-25T12:00'));
  await service.runNow('RT-0001', local('2026-10-25T12:30'));
  await service.remove('RT-0001');
  await fsp.rm(path.join(ws, '.situation-board', 'routines', 'state.json'));
  assert.equal((await service.create(biweeklyPrep)).id, 'RT-0002');
});

test('tasks created through the API only keep well-formed routine markers', async (t) => {
  await workspace(t);
  const tasks = new TaskService();
  for (const bad of [
    { routine_ref: 'RT-0001' }, { routine_occurrence: '2026-11-02T08:00' },
    { routine_ref: '../x', routine_occurrence: '2026-11-02T08:00' }, { routine_ref: 'RT-0001', routine_occurrence: 'soon' },
  ]) {
    await assert.rejects(tasks.createTask({ title: 'x', ...bad } as never), /routine_ref/, JSON.stringify(bad));
  }
  const ok = await tasks.createTask({ title: 'x', routine_ref: 'RT-0001', routine_occurrence: '2026-11-02T08:00' } as never);
  assert.equal(ok['routine_occurrence'], '2026-11-02T08:00');
});


test('an in-flight routine stays in its original workspace after a switch', async (t) => {
  const first = await workspace(t);
  const second = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-rt-other-'));
  t.after(() => fsp.rm(second, { recursive: true, force: true }));
  const service = new RoutineService();
  const routine = await service.create(biweeklyPrep, local('2026-10-25T12:00'));
  const original = TaskService.prototype.createTask;
  t.mock.method(TaskService.prototype, 'createTask', async function (this: TaskService, data: Parameters<TaskService['createTask']>[0]) {
    process.env.ESB_WORKSPACE_PATH = second;
    return original.call(this, data);
  });
  const run = await service.runNow(routine.id, local('2026-10-26T10:00'));
  assert.equal(run.created.length, 1);
  assert.ok(await fsp.stat(path.join(first, 'tasks', 'active', run.created[0]!, 'task.md')));
  assert.deepEqual(await fsp.readdir(second), [], 'tasks and receipts must not leak into the newly selected workspace');
  assert.match(await fsp.readFile(path.join(first, '.situation-board', 'routines', 'receipts.jsonl'), 'utf-8'), /RT-0001/);
});
