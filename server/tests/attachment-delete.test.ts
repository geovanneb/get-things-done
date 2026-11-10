import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';

test('deleting an attachment that is already gone answers 404, for tasks, context notes and templates', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-attachment-delete-'));
  const ws = path.join(root, 'ws');
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ESB_WORKSPACE_PATH: process.env.ESB_WORKSPACE_PATH };
  process.env.HOME = path.join(root, 'home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.ESB_WORKSPACE_PATH = ws;
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(path.join(ws, 'workspace.yaml'), 'name: Fictional board workspace\n');

  const { registerRoutes } = await import('../src/routes');
  const { errorHandler } = await import('../src/middleware/errorHandler');
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
  const post = async (url: string, body: unknown) => {
    const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 201, `${url}: ${await res.clone().text()}`);
    return (await res.json()) as { id: string };
  };
  const remove = async (url: string) => {
    const res = await fetch(base + url, { method: 'DELETE' });
    return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as { message: string }) };
  };

  const task = await post('/api/tasks', { title: 'Board pack' });
  const note = await post('/api/context', { title: 'Board pack notes', category: 'company', content: 'Fictional notes.' });
  const template = await post('/api/outputs/templates', { name: 'Board pack', description: 'Fictional template', format: 'md' });

  for (const owner of [`/api/tasks/${task.id}`, `/api/context/${note.id}`, `/api/outputs/templates/${template.id}`]) {
    const form = new FormData();
    form.append('file', new Blob(['draft']), 'draft.txt');
    assert.equal((await fetch(`${base}${owner}/files`, { method: 'POST', body: form })).status, 201, owner);

    assert.equal((await remove(`${owner}/files/draft.txt`)).status, 204, owner);
    assert.deepEqual(await remove(`${owner}/files/draft.txt`), { status: 404, body: { error: 'Error', message: 'File not found: draft.txt' } }, owner);
    assert.equal((await remove(`${owner}/files/never-uploaded.pdf`)).status, 404, owner);

    // Two tabs removing the same file at once: one removes it, the other is told it is gone.
    const again = new FormData();
    again.append('file', new Blob(['draft']), 'draft.txt');
    assert.equal((await fetch(`${base}${owner}/files`, { method: 'POST', body: again })).status, 201, owner);
    const both = await Promise.all([remove(`${owner}/files/draft.txt`), remove(`${owner}/files/draft.txt`)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [204, 404], owner);
  }

  // A task that does not exist has no files either.
  assert.equal((await remove('/api/tasks/TASK-2026-9999/files/draft.txt')).status, 404);
  await fs.writeFile(path.join(ws, 'tasks', 'active', 'TASK-2026-0099'), 'not a folder');
  assert.equal((await remove('/api/tasks/TASK-2026-0099/files/draft.txt')).status, 404);
  // The reserved files are still refused, not reported missing.
  assert.equal((await remove(`/api/tasks/${task.id}/files/task.md`)).status, 400);
});
