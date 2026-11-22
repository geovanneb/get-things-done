import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';

// Opening a meeting reads GET /api/tasks for the tasks that use it (#483): a read must never write to the workspace.
test('listing tasks never creates tasks/active: a missing folder is an empty list', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-task-list-'));
  const ws = path.join(root, 'ws');
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ESB_WORKSPACE_PATH: process.env.ESB_WORKSPACE_PATH };
  process.env.HOME = path.join(root, 'home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.ESB_WORKSPACE_PATH = ws;
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(path.join(ws, 'workspace.yaml'), 'name: Fictional read-only workspace\n');

  const { registerRoutes } = await import('../src/routes');
  const { errorHandler } = await import('../src/middleware/errorHandler');
  const { TaskService } = await import('../src/services/taskService');
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const exists = (p: string) => fs.access(p).then(() => true, () => false);

  assert.deepEqual(await new TaskService().listTasks(), []);
  const res = await fetch(`${base}/api/tasks`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
  assert.equal(await exists(path.join(ws, 'tasks', 'active')), false, 'the read created tasks/active');
  assert.equal(await exists(path.join(ws, 'tasks')), false);

  // Only a missing folder is an empty list: a file where tasks/active should be fails, as it did before.
  await fs.mkdir(path.join(ws, 'tasks'));
  await fs.writeFile(path.join(ws, 'tasks', 'active'), 'not a folder');
  await assert.rejects(new TaskService().listTasks(), (err: NodeJS.ErrnoException) => err.code === 'ENOTDIR');
  assert.notEqual((await fetch(`${base}/api/tasks`)).status, 200, 'a broken task folder is not shown as an empty board');
  await fs.rm(path.join(ws, 'tasks'), { recursive: true });

  // A folder that cannot be read fails too (no access: chmod is POSIX only, and root reads it anyway).
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = path.join(ws, 'tasks', 'active');
    await fs.mkdir(locked, { recursive: true });
    await fs.chmod(locked, 0o000);
    t.after(async () => { await fs.chmod(locked, 0o755).catch(() => {}); });
    await assert.rejects(new TaskService().listTasks(), (err: NodeJS.ErrnoException) => err.code === 'EACCES');
    assert.notEqual((await fetch(`${base}/api/tasks`)).status, 200, 'an unreadable task folder is not shown as an empty board');
    await fs.chmod(locked, 0o755);
    await fs.rm(path.join(ws, 'tasks'), { recursive: true });
  }

  // Creating a task still makes the folders it needs, and the list then finds it.
  const created = await new TaskService().createTask({ title: 'Fictional task' });
  assert.deepEqual((await new TaskService().listTasks()).map((task) => task.id), [created.id]);
});
