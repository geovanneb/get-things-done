import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskService } from '../src/services/taskService';
import { parseMarkdown } from '../src/utils/markdown';

test('archiving moves a deliverable\'s path with its folder, so its file still opens; shared paths stay', async (t) => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-archive-paths-'));
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
  const own = `tasks/active/${created.id}/deliverables/summary.md`;
  const shared = 'outputs/shared/glossary.md';
  await fsp.mkdir(path.join(ws, 'tasks', 'active', created.id, 'deliverables'), { recursive: true });
  await fsp.writeFile(path.join(ws, own), 'summary');
  await tasks.updateTask(created.id, { deliverables: [
    { id: 'D1', format: 'md', status: 'complete', file_path: own },
    { id: 'D2', format: 'md', status: 'complete', file_path: shared },
  ] } as never);

  await tasks.archiveTask(created.id);
  const moved = `tasks/archive/${created.id}/deliverables/summary.md`;
  const onDisk = parseMarkdown(await fsp.readFile(path.join(ws, 'tasks', 'archive', created.id, 'task.md'), 'utf-8')).data;
  assert.deepEqual((onDisk['deliverables'] as { file_path: string }[]).map((d) => d.file_path), [moved, shared]);
  await fsp.access(path.join(ws, moved));
  assert.deepEqual((await tasks.getTask(created.id)).deliverables.map((d) => (d as { file_path?: string }).file_path), [moved, shared]);
  assert.deepEqual((await tasks.listArchivedTasks())[0]!.deliverables.map((d) => (d as { file_path?: string }).file_path), [moved, shared]);

  // A task archived before this: shown at the archive path, its file left as it is.
  const old = await tasks.createTask({ title: 'Fictional older pack' });
  await fsp.mkdir(path.join(ws, 'tasks', 'active', old.id, 'deliverables'), { recursive: true });
  await tasks.updateTask(old.id, { deliverables: [{ id: 'D1', format: 'md', status: 'complete', file_path: `tasks/active/${old.id}/deliverables/x.md` }] } as never);
  await fsp.rename(path.join(ws, 'tasks', 'active', old.id), path.join(ws, 'tasks', 'archive', old.id));
  const before = await fsp.readFile(path.join(ws, 'tasks', 'archive', old.id, 'task.md'), 'utf-8');
  assert.equal((await tasks.getTask(old.id)).deliverables.map((d) => (d as { file_path?: string }).file_path)[0], `tasks/archive/${old.id}/deliverables/x.md`);
  assert.equal(await fsp.readFile(path.join(ws, 'tasks', 'archive', old.id, 'task.md'), 'utf-8'), before, 'reading writes nothing');
});
