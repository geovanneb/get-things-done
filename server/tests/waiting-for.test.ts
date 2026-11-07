import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskService } from '../src/services/taskService';
import { SituationService } from '../src/services/situationService';
import { StakeholderService } from '../src/services/stakeholderService';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-waiting-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'stakeholders/people', 'context']) await fsp.mkdir(path.join(dir, d), { recursive: true });
  return dir;
}

const status = (code: number) => (err: Error & { statusCode?: number }) => err.statusCode === code;
const tasks = new TaskService();
const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const waitingOf = async (id: string) => ((await tasks.getTask(id)) as Record<string, unknown>)['waiting'] as Record<string, unknown> | undefined;

test('a task records what it waits for, from whom and since when; resolving clears it and leaves the task as it is', async (t) => {
  await workspace(t);
  const person = await new StakeholderService().createStakeholder({ name: 'Priya Natarajan', influence: 'influencer' } as never);
  const created = await tasks.createTask({ title: 'Fictional supplier contract', body: 'Body.\n' });
  const task = await tasks.updateTask(created.id, { status: 'in_progress' });

  const set = await tasks.setWaiting(task.id, { waiting: { for: 'Signed pricing sheet', party: { ref: person.id }, since: day(-3), follow_up: day(2) }, seen_updated_at: task.updated_at });
  assert.equal(set.status, 'in_progress', 'waiting never changes the status');
  assert.equal(set.start_date, task.start_date);
  const w = await waitingOf(task.id);
  assert.deepEqual([w?.['for'], w?.['party'], w?.['since'], w?.['follow_up']], ['Signed pricing sheet', { ref: person.id }, day(-3), day(2)]);

  // An ordinary save never sets or clears it.
  await tasks.updateTask(task.id, { waiting: null } as never);
  assert.ok(await waitingOf(task.id), 'kept through a save');

  // Someone who is not a stakeholder, and a since date left empty (today).
  const again = await tasks.getTask(task.id);
  await tasks.setWaiting(task.id, { waiting: { for: 'Legal review', party: { name: 'Outside counsel' }, since: '' }, seen_updated_at: again.updated_at });
  assert.deepEqual([(await waitingOf(task.id))?.['party'], (await waitingOf(task.id))?.['since'], (await waitingOf(task.id))?.['follow_up']], [{ name: 'Outside counsel' }, day(0), undefined]);

  const before = await tasks.getTask(task.id);
  const resolved = await tasks.resolveWaiting(task.id, { seen_updated_at: before.updated_at });
  assert.equal(resolved.status, 'in_progress', 'resolving never finishes the task');
  assert.equal(await waitingOf(task.id), undefined);
});

test('waiting is refused for a stale view or bad input', async (t) => {
  await workspace(t);
  const task = await tasks.createTask({ title: 'Fictional board pack' });
  const seen = task.updated_at;
  await assert.rejects(tasks.setWaiting(task.id, { waiting: { for: 'x' }, seen_updated_at: '2020-01-01T00:00:00.000Z' }), status(409));
  await assert.rejects(tasks.setWaiting(task.id, { waiting: { for: '  ' }, seen_updated_at: seen }), status(400));
  await assert.rejects(tasks.setWaiting(task.id, { waiting: { for: 'x', since: '2026-13-40' }, seen_updated_at: seen }), status(400));
  await assert.rejects(tasks.setWaiting(task.id, { waiting: { for: 'x', since: day(0), follow_up: day(-1) }, seen_updated_at: seen }), status(400));
  await assert.rejects(tasks.setWaiting(task.id, { waiting: { for: 'x', party: { ref: '../STK' } }, seen_updated_at: seen }), status(400));
  await assert.rejects(tasks.setWaiting(task.id, { waiting: { for: 'x', party: { ref: 'STK-9999' } }, seen_updated_at: seen }), status(400), 'a stakeholder not on file');
  await assert.rejects(tasks.setWaiting(task.id, { waiting: { for: 'x', since: day(1) }, seen_updated_at: seen }), status(400), 'a since date in the future');
  await assert.rejects(tasks.setWaiting('TASK-2026-0999', { waiting: { for: 'x' }, seen_updated_at: seen }), status(404));
  assert.equal(await waitingOf(task.id), undefined, 'nothing was written');
});

test('the Situation screen shows a follow-up once its date has come, apart from the due date', async (t) => {
  await workspace(t);
  const due = await tasks.createTask({ title: 'Follow up today', due_date: day(30) });
  await tasks.setWaiting(due.id, { waiting: { for: 'Budget numbers', since: day(-7), follow_up: day(0) }, seen_updated_at: due.updated_at });
  const later = await tasks.createTask({ title: 'Follow up next week' });
  await tasks.setWaiting(later.id, { waiting: { for: 'A reply', since: day(0), follow_up: day(7) }, seen_updated_at: later.updated_at });

  const queue = (await new SituationService().getSituationData()).attention_queue;
  const item = queue.find((a) => a.id === due.id);
  assert.equal(item?.reason, 'follow_up');
  assert.deepEqual(item?.waiting, { for: 'Budget numbers', follow_up: day(0), since: day(-7) });
  assert.equal(item?.due_date, day(30), 'the task\'s own due date is unchanged');
  assert.ok(!queue.some((a) => a.id === later.id && a.reason === 'follow_up'), 'a follow-up not yet due is not shown');

  // Overdue and due for follow-up: listed once as overdue, and still says what needs chasing.
  const both = await tasks.createTask({ title: 'Late and waiting', due_date: day(-2) });
  await tasks.setWaiting(both.id, { waiting: { for: 'Sign-off', since: day(-5), follow_up: day(-1) }, seen_updated_at: both.updated_at });
  const again = (await new SituationService().getSituationData()).attention_queue.filter((a) => a.id === both.id);
  assert.deepEqual(again.map((a) => [a.reason, a.waiting?.for]), [['overdue', 'Sign-off']]);
});

test('stale waiting edits are rejected even when the clock has not advanced', async (t) => {
  await workspace(t);
  const task = await tasks.createTask({ title: 'Fictional same-clock task' });
  t.mock.timers.enable({ apis: ['Date'], now: new Date(task.updated_at) });
  t.after(() => t.mock.timers.reset());
  const first = await tasks.setWaiting(task.id, { waiting: { for: 'First reply' }, seen_updated_at: task.updated_at });
  assert.notEqual(first.updated_at, task.updated_at, 'each persisted version needs a different timestamp');
  await assert.rejects(tasks.setWaiting(task.id, { waiting: { for: 'Stale replacement' }, seen_updated_at: task.updated_at }), status(409));
  await tasks.updateTaskContent(task.id, 'A new body');
  await assert.rejects(tasks.resolveWaiting(task.id, { seen_updated_at: first.updated_at }), status(409));
  assert.equal((await waitingOf(task.id))?.for, 'First reply');
  const latest = await tasks.getTask(task.id);
  t.mock.timers.setTime(Date.parse(task.updated_at) - 60_000);
  const saved = await tasks.updateTask(task.id, { title: 'Fictional clock moved backwards' });
  assert.ok(saved.updated_at > latest.updated_at);
  await assert.rejects(tasks.resolveWaiting(task.id, { seen_updated_at: latest.updated_at }), status(409));
});

test('waiting writes refuse linked task folders and linked lock directories', { skip: process.platform === 'win32' }, async (t) => {
  const ws = await workspace(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-waiting-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  const task = await tasks.createTask({ title: 'Fictional linked task' });
  const folder = path.join(ws, 'tasks/active', task.id);
  const target = path.join(outside, 'task');
  await fsp.rename(folder, target);
  await fsp.symlink(target, folder);
  const before = await fsp.readFile(path.join(target, 'task.md'), 'utf8');
  await assert.rejects(tasks.setWaiting(task.id, { waiting: { for: 'A reply' }, seen_updated_at: task.updated_at }), /Invalid path traversal/);
  assert.equal(await fsp.readFile(path.join(target, 'task.md'), 'utf8'), before);
  await fsp.unlink(folder);
  await fsp.rename(target, folder);
  const locks = path.join(ws, '.situation-board/task-locks');
  await fsp.rm(locks, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(locks), { recursive: true });
  await fsp.symlink(outside, locks);
  await assert.rejects(tasks.setWaiting(task.id, { waiting: { for: 'A reply' }, seen_updated_at: task.updated_at }), /Invalid path traversal/);
  assert.equal(await fsp.readFile(path.join(folder, 'task.md'), 'utf8'), before);
  assert.deepEqual(await fsp.readdir(outside), []);
});
