import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';

test('switching workspaces isolates outstanding HTTP task creates and searches', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-workspace-operation-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ESB_WORKSPACE_PATH: process.env.ESB_WORKSPACE_PATH };
  process.env.HOME = path.join(root, 'home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.ESB_WORKSPACE_PATH = first;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const dir of [first, second]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'workspace.yaml'), 'name: Fictional review workspace\n');
  }
  const { registerRoutes } = await import('../src/routes');
  const { TaskService } = await import('../src/services/taskService');
  const { watcherService } = await import('../src/services/watcherService');
  const { errorHandler } = await import('../src/middleware/errorHandler');
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const original = TaskService.prototype.createTask;
  t.mock.method(TaskService.prototype, 'createTask', async function (this: TaskService, data: Parameters<TaskService['createTask']>[0]) {
    entered();
    await gate;
    return original.call(this, data);
  });
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(async () => {
    release();
    watcherService.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (url: string, body: unknown) => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const pending = post('/api/tasks', { title: 'Original workspace task' });
  await started;
  try {
    const switched = await post('/api/workspace/switch', { path: second });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json()).config.path, second);
  } finally { release(); }
  const response = await pending;
  assert.equal(response.status, 201);
  const task = await response.json();
  assert.ok(await fs.stat(path.join(first, 'tasks', 'active', task.id, 'task.md')));
  await assert.rejects(fs.stat(path.join(second, 'tasks', 'active', task.id, 'task.md')), { code: 'ENOENT' });
  const next = await post('/api/tasks', { title: 'New workspace task' });
  assert.equal(next.status, 201);
  assert.ok(await fs.stat(path.join(second, 'tasks', 'active', (await next.json()).id, 'task.md')));

  // A search that finishes indexing after another workspace is selected must use its own index.
  const { SearchService } = await import('../src/services/searchService');
  const build = SearchService.prototype.buildIndex;
  let finishSearch!: () => void;
  let indexed!: () => void;
  const searchGate = new Promise<void>((resolve) => { finishSearch = resolve; });
  const indexReady = new Promise<void>((resolve) => { indexed = resolve; });
  let holdFirst = true;
  t.mock.method(SearchService.prototype, 'buildIndex', async function (this: InstanceType<typeof SearchService>) {
    await build.call(this);
    if (holdFirst) {
      holdFirst = false;
      indexed();
      await searchGate;
    }
  });
  await post('/api/workspace/switch', { path: first });
  const oldSearch = fetch(`${base}/api/search?q=workspace`);
  await indexReady;
  try {
    await post('/api/workspace/switch', { path: second });
    const currentSearch = await (await fetch(`${base}/api/search?q=workspace`)).json();
    assert.deepEqual(currentSearch.results.map((row: { title: string }) => row.title), ['New workspace task']);
  } finally { finishSearch(); }
  const originalSearch = await (await oldSearch).json();
  assert.deepEqual(originalSearch.results.map((row: { title: string }) => row.title), ['Original workspace task']);

});
