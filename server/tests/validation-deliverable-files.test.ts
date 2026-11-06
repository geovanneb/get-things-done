import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ValidationService } from '../src/services/validationService';

test('a complete deliverable whose file the dashboard cannot open is reported, and says why', async (t) => {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-validation-deliverables-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = ws;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(ws, { recursive: true, force: true });
  });

  const folder = path.join(ws, 'tasks', 'active', 'TASK-2026-0001');
  await fsp.mkdir(path.join(folder, 'deliverables'), { recursive: true });
  await fsp.writeFile(path.join(folder, 'deliverables', 'board-pack.pdf'), 'pdf');
  await fsp.writeFile(path.join(folder, 'deliverables', 'summary.md'), 'md');
  await fsp.writeFile(path.join(folder, 'task.md'), [
    '---',
    'id: TASK-2026-0001',
    'title: Board pack',
    'status: in_review',
    'priority: high',
    'deliverables:',
    '  - { id: DEL-01, format: pdf, status: complete, file_path: tasks/active/TASK-2026-0001/deliverables/board-pack.pdf }',
    '  - { id: DEL-02, format: pdf, status: complete, file_path: tasks/active/TASK-2026-0001/deliverables/gone.pdf }',
    '  - { id: DEL-03, format: md, status: complete, file_path: deliverables/summary.md }',
    '  - { id: DEL-04, format: md, status: complete, file_path: ../outside.md }',
    '  - { id: DEL-05, format: md, status: pending, file_path: tasks/active/TASK-2026-0001/deliverables/later.md }',
    '  - { id: DEL-06, format: md, status: complete }',
    '---',
    '',
    'Body.',
    '',
  ].join('\n'));

  const issues = (await new ValidationService().validateWorkspace()).filter((r) => r.rule === 'missing_deliverable');
  const about = (id: string) => issues.filter((r) => r.message.includes(` ${id} `));

  assert.equal(about('DEL-01').length, 0, 'a file that opens is fine');
  assert.match(about('DEL-02')[0]?.message ?? '', /is complete, but its file is missing: .*gone\.pdf$/);
  assert.match(about('DEL-03')[0]?.message ?? '', /relative to the task folder; file_path must start at the workspace root/);
  assert.match(about('DEL-04')[0]?.message ?? '', /points outside the workspace/);
  assert.equal(about('DEL-05').length, 0, 'a deliverable not finished yet has no file to check');
  assert.equal(about('DEL-06').length, 0, 'no file_path: nothing to open');
  assert.ok(issues.every((r) => r.level === 'warning'));
  assert.equal(issues.length, 3);
});
