import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskService } from '../src/services/taskService';
import { parseMarkdown } from '../src/utils/markdown';

/** A throwaway fictional workspace; the service reads its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-task-'));
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

test('createTask keeps the optional schema fields it is given (contexts, confidentiality, ...)', async (t) => {
  const ws = await workspace(t);
  const created = await new TaskService().createTask({
    title: 'Quarterly review',
    slug: 'quarterly-review',
    task_type: 'analysis',
    contexts: [{ ref: 'CTX-growth-plan', relevance: 'required' }],
    preferred_agent: 'executive-report-writer',
    confidentiality: 'confidential',
    review_date: '2026-11-20',
    estimated_hours: 0,
  });

  const file = await fsp.readFile(path.join(ws, 'tasks', 'active', created.id, 'task.md'), 'utf-8');
  const data = parseMarkdown(file).data as Record<string, unknown>;
  assert.equal(data.slug, 'quarterly-review');
  assert.equal(data.task_type, 'analysis');
  assert.deepEqual(data.contexts, [{ ref: 'CTX-growth-plan', relevance: 'required' }]);
  assert.equal(data.preferred_agent, 'executive-report-writer');
  assert.equal(data.confidentiality, 'confidential');
  assert.equal(data.review_date, '2026-11-20');
  assert.equal(data.estimated_hours, 0, 'a falsy value like 0 is kept');
  assert.equal(created.confidentiality, 'confidential');
});

test('createTask does not add optional fields that were not given or are null', async (t) => {
  const ws = await workspace(t);
  const created = await new TaskService().createTask({ title: 'Plain task', confidentiality: null, contexts: null });
  const data = parseMarkdown(await fsp.readFile(path.join(ws, 'tasks', 'active', created.id, 'task.md'), 'utf-8')).data as Record<string, unknown>;
  for (const key of ['slug', 'task_type', 'contexts', 'preferred_agent', 'confidentiality', 'review_date', 'estimated_hours']) {
    assert.equal(key in data, false, key);
  }
});


test('concurrent manual and routine task creation reserves distinct folders', async (t) => {
  await workspace(t);
  const service = new TaskService();
  const titles = Array.from({ length: 12 }, (_, i) => `Concurrent task ${i}`);
  const created = await Promise.all(titles.map((title) => service.createTask({ title })));
  assert.equal(new Set(created.map((task) => task.id)).size, titles.length);
  assert.deepEqual((await service.listTasks()).map((task) => task.title).sort(), titles.sort());
});

test('invalid routine markers leave no task folders behind', async (t) => {
  const ws = await workspace(t);
  await assert.rejects(new TaskService().createTask({ title: 'Invalid', routine_ref: '../bad' }), /Invalid routine_ref/);
  assert.deepEqual(await fsp.readdir(path.join(ws, 'tasks', 'active')), []);
});

test('task objectives saved as Markdown remain searchable', async (t) => {
  await workspace(t);
  const service = new TaskService();
  const task = await service.createTask({ title: 'Review brief', body: 'Investigate the fictional zephyrbrief initiative.' });
  assert.deepEqual((await service.listTasks({ search: 'zephyrbrief' })).map((row) => row.id), [task.id]);
  const { SearchService } = await import('../src/services/searchService');
  const search = new SearchService();
  t.after(() => search.reset());
  await search.buildIndex();
  assert.deepEqual((await search.search('zephyrbrief')).map((row) => row.id), [task.id]);
});
