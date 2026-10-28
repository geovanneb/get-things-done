import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskService } from '../src/services/taskService';
import { ValidationService } from '../src/services/validationService';

/** A throwaway fictional workspace; the services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-validation-'));
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

async function writeTask(ws: string, id: string, frontmatter: string): Promise<void> {
  await fsp.mkdir(path.join(ws, 'tasks', 'active', id), { recursive: true });
  await fsp.writeFile(path.join(ws, 'tasks', 'active', id, 'task.md'), `---\n${frontmatter}\n---\n\nBody.\n`);
}

test('validation reports a task.md that cannot be parsed instead of hiding it silently', async (t) => {
  const ws = await workspace(t);
  await writeTask(ws, 'TASK-2026-0001', "id: TASK-2026-0001\ntitle: Quarterly review\nstatus: backlog\npriority: high");
  await writeTask(ws, 'TASK-2026-0002', [
    'id: TASK-2026-0002',
    'title: Board pack',
    'status: backlog',
    'priority: medium',
    'contexts:',
    '  - ref: CTX-growth-plan',
    '    relevance: required',
    '    relevance: required',
  ].join('\n'));

  const tasks = await new TaskService().listTasks();
  assert.deepEqual(tasks.map((task) => task.id), ['TASK-2026-0001'], 'the board still skips the broken file');

  const results = await new ValidationService().validateWorkspace();
  const unreadable = results.filter((r) => r.rule === 'unreadable_file');
  assert.equal(unreadable.length, 1);
  assert.equal(unreadable[0]?.level, 'error');
  assert.match(unreadable[0]?.message ?? '', /TASK-2026-0002/);
  assert.match(unreadable[0]?.message ?? '', /duplicated mapping key/);
  assert.equal(unreadable[0]?.path, path.join(ws, 'tasks', 'active', 'TASK-2026-0002', 'task.md'));
});
