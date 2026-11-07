import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskService } from '../src/services/taskService';
import { parseMarkdown } from '../src/utils/markdown';

test('a save from the version editing started on is refused once the task changed, so it never undoes Request changes', async (t) => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-stale-save-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = ws;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(ws, { recursive: true, force: true });
  });
  await fsp.mkdir(path.join(ws, 'tasks', 'active'), { recursive: true });
  const tasks = new TaskService();
  const created = await tasks.createTask({ title: 'Fictional board pack' });
  await tasks.updateTask(created.id, { status: 'in_progress' });
  const draft = await tasks.updateTask(created.id, { status: 'in_review' });

  // Someone requests changes while a draft of the old version is open elsewhere.
  await tasks.requestChanges(created.id, { feedback: 'Shorten it.', seen_updated_at: draft.updated_at, request_id: 'req-stale-0001' });
  await assert.rejects(
    tasks.updateTask(created.id, { ...draft, title: 'Edited title', expected_updated_at: draft.updated_at } as never),
    (err: Error & { statusCode?: number }) => err.statusCode === 409,
  );
  const now = await tasks.getTask(created.id) as unknown as Record<string, unknown>;
  assert.equal(now['status'], 'in_progress', 'the rework stays');
  assert.equal(now['title'], 'Fictional board pack', 'nothing from the old draft was written');

  // From the current version it saves, and the marker is never written into the task.
  const ok = await tasks.updateTask(created.id, { title: 'Edited title', expected_updated_at: now['updated_at'] } as never);
  assert.equal(ok.title, 'Edited title');
  const onDisk = parseMarkdown(await fsp.readFile(path.join(ws, 'tasks', 'active', created.id, 'task.md'), 'utf-8')).data;
  assert.equal('expected_updated_at' in onDisk, false);

  // Without it (a board move, a script), a save applies as before.
  assert.equal((await tasks.updateTask(created.id, { priority: 'high' })).priority, 'high');
});
