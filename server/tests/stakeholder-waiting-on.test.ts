import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskService } from '../src/services/taskService';
import { StakeholderService } from '../src/services/stakeholderService';
import { waitingOn } from '../src/services/stakeholderWaiting';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-waiting-on-'));
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

async function waitOn(title: string, waiting: Record<string, unknown>, statusAfter?: string) {
  const created = await tasks.createTask({ title });
  const set = await tasks.setWaiting(created.id, { waiting, seen_updated_at: created.updated_at });
  if (statusAfter) await tasks.updateTask(created.id, { status: statusAfter } as never);
  return set.id;
}

test('a stakeholder lists the open tasks waiting on them: due follow-ups first, then the longest wait', async (t) => {
  await workspace(t);
  const people = new StakeholderService();
  const priya = await people.createStakeholder({ name: 'Priya Natarajan', influence: 'influencer' } as never);
  const dana = await people.createStakeholder({ name: 'Dana Patel', influence: 'influencer' } as never);

  const later = await waitOn('Fictional budget sign-off', { for: 'Budget figures', party: { ref: priya.id }, since: day(-10), follow_up: day(3) });
  const dueToday = await waitOn('Fictional supplier contract', { for: 'Signed pricing sheet', party: { ref: priya.id }, since: day(-2), follow_up: day(0) });
  const overdue = await waitOn('Fictional board pack', { for: 'Slide review', party: { ref: priya.id }, since: day(-1), follow_up: day(-1) });
  const noFollowUp = await waitOn('Fictional hiring plan', { for: 'Headcount answer', party: { ref: priya.id }, since: day(-20) });
  // Not listed: another person, a free-text name that happens to match, a finished task.
  await waitOn('Fictional other wait', { for: 'Something', party: { ref: dana.id }, since: day(0) });
  await waitOn('Fictional named wait', { for: 'Something', party: { name: 'Priya Natarajan' }, since: day(0) });
  await waitOn('Fictional finished wait', { for: 'Something', party: { ref: priya.id }, since: day(0) }, 'done');

  const list = await waitingOn(priya.id);
  assert.deepEqual(list.map((w) => w.task_id), [overdue, dueToday, noFollowUp, later]);
  assert.deepEqual(list.map((w) => w.follow_up_due), [true, true, false, false], 'a follow-up due today is due, as in Situation');
  assert.deepEqual([list[1]!.for, list[1]!.title, list[1]!.since, list[1]!.follow_up], ['Signed pricing sheet', 'Fictional supplier contract', day(-2), day(0)]);
  assert.equal(list[2]!.follow_up, null);

  // Resolving the waiting takes the task off the list; nothing is stored on the stakeholder.
  const task = await tasks.getTask(overdue);
  await tasks.resolveWaiting(overdue, { seen_updated_at: task.updated_at });
  assert.ok(!(await waitingOn(priya.id)).some((w) => w.task_id === overdue));
  assert.deepEqual(await waitingOn(dana.id).then((l) => l.length), 1);
});

test('waiting-on refuses a bad id and an unknown stakeholder, and reads odd hand-written records safely', async (t) => {
  const dir = await workspace(t);
  await assert.rejects(waitingOn('../x'), status(400));
  await assert.rejects(waitingOn('STK-0999'), status(404));

  const person = await new StakeholderService().createStakeholder({ name: 'Priya Natarajan', influence: 'influencer' } as never);
  const created = await tasks.createTask({ title: 'Fictional hand-edited task' });
  const file = path.join(dir, 'tasks', 'active', created.id, 'task.md');
  const text = await fsp.readFile(file, 'utf8');
  // An agent wrote a party with the ref but no "for", then a since that is not a day.
  await fsp.writeFile(file, text.replace(/^---\n/, `---\nwaiting:\n  party:\n    ref: ${person.id}\n`));
  assert.deepEqual(await waitingOn(person.id), [], 'a record without what it waits for is not listed');
  await fsp.writeFile(file, text.replace(/^---\n/, `---\nwaiting:\n  for: Quote\n  party:\n    ref: ${person.id}\n  since: soon\n  follow_up: later\n`));
  const [item] = await waitingOn(person.id);
  assert.deepEqual([item?.for, item?.since, item?.follow_up, item?.follow_up_due], ['Quote', '', null, false]);
  // Shaped like a day but not one: never NaN days, never a due badge.
  await fsp.writeFile(file, text.replace(/^---\n/, `---\nwaiting:\n  for: Quote\n  party:\n    ref: ${person.id}\n  since: '2026-13-01'\n  follow_up: '2026-00-01'\n`));
  const [odd] = await waitingOn(person.id);
  assert.deepEqual([odd?.since, odd?.follow_up, odd?.follow_up_due], ['', null, false]);
});
