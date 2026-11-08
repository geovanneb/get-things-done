import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskService } from '../src/services/taskService';

async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-yaml-dates-'));
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

/** What an agent may write: the timestamp without quotes, which YAML reads as a date. */
async function unquote(file: string, extra = ''): Promise<void> {
  const text = await fsp.readFile(file, 'utf-8');
  await fsp.writeFile(file, text.replace(/^updated_at: .*$/m, 'updated_at: 2026-11-08T09:30:00Z' + extra));
}

test('an unquoted updated_at (a YAML date) never locks the task: save, Request changes and Waiting for still work', async (t) => {
  await workspace(t);
  const tasks = new TaskService();
  const created = await tasks.createTask({ title: 'Fictional board pack' });
  await tasks.updateTask(created.id, { status: 'in_progress' });
  const review = await tasks.updateTask(created.id, { status: 'in_review' });
  const file = review.path!;

  await unquote(file);
  let task = await tasks.getTask(review.id);
  assert.equal(task.updated_at, '2026-11-08T09:30:00.000Z', 'read back as the text the server writes');
  assert.equal((await tasks.listTasks()).find((x) => x.id === review.id)!.updated_at, '2026-11-08T09:30:00.000Z');

  // The task page's save, from the version it was shown.
  task = await tasks.updateTask(review.id, { priority: 'high', expected_updated_at: task.updated_at } as never);
  assert.equal(task.priority, 'high');

  // Request changes, from the version shown.
  await unquote(file);
  task = await tasks.getTask(review.id);
  const requested = await tasks.requestChanges(review.id, { feedback: 'Shorten it.', seen_updated_at: task.updated_at, request_id: 'req-00000001' });
  assert.equal(requested.task.status, 'in_progress');

  // Waiting for, set and resolved, from the version shown; unquoted dates in it read as days.
  await unquote(file);
  task = await tasks.getTask(review.id);
  await tasks.setWaiting(review.id, { waiting: { for: 'Signed sheet', since: '2026-11-01', follow_up: '2026-11-09' }, seen_updated_at: task.updated_at });
  const text = await fsp.readFile(file, 'utf-8');
  await fsp.writeFile(file, text.replace(/since: .*$/m, 'since: 2026-11-01').replace(/follow_up: .*$/m, 'follow_up: 2026-11-09').replace(/^updated_at: .*$/m, 'updated_at: 2026-11-08T10:00:00Z'));
  task = await tasks.getTask(review.id);
  assert.deepEqual([task.waiting?.since, task.waiting?.follow_up], ['2026-11-01', '2026-11-09']);
  task = await tasks.resolveWaiting(review.id, { seen_updated_at: task.updated_at });
  assert.equal(task.waiting, undefined);

  // A stale view is still refused.
  await assert.rejects(tasks.updateTask(review.id, { priority: 'low', expected_updated_at: '2020-01-01T00:00:00.000Z' } as never), (e: { statusCode?: number }) => e.statusCode === 409);
});
