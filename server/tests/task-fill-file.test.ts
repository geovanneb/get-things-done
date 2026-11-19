import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { TaskService } from '../src/services/taskService';
import { parseMarkdown } from '../src/utils/markdown';

/** A throwaway fictional workspace; the service reads its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-fill-'));
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

async function frontmatter(ws: string, id: string): Promise<Record<string, unknown>> {
  return parseMarkdown(await fsp.readFile(path.join(ws, 'tasks', 'active', id, 'task.md'), 'utf-8')).data as Record<string, unknown>;
}

test('a deliverable answered in an attached file names the file as the upload saves it, in its format', async (t) => {
  const ws = await workspace(t);
  const service = new TaskService();
  // Picked in the New Task modal before the upload, which renames it.
  const created = await service.createTask({
    title: 'Answer the supplier questionnaire',
    deliverables: [
      { id: 'DEL-01', template_ref: 'executive-document', format: 'docx', status: 'pending' },
      { id: 'DEL-02', fill_file: 'Supplier Q&A (v2).XLSX', template_ref: 'executive-document', format: 'docx', status: 'pending' },
    ],
  } as never);
  const saved = await service.saveTaskFile(created.id, 'Supplier Q&A (v2).XLSX', Buffer.from('fictional sheet'));

  const deliverables = (await frontmatter(ws, created.id)).deliverables as Record<string, unknown>[];
  assert.deepEqual(deliverables[0], { id: 'DEL-01', template_ref: 'executive-document', format: 'docx', status: 'pending' });
  assert.deepEqual(deliverables[1], { id: 'DEL-02', fill_file: saved.name, format: 'xlsx', status: 'pending' }, 'no template, the file type as format');
  assert.equal(saved.name, 'Supplier_Q_A__v2_.XLSX');
  assert.ok((await service.listTaskFiles(created.id)).some((f) => f.name === deliverables[1]!.fill_file));
});

test('a deliverable can go back from an attached file to an output template', async (t) => {
  const ws = await workspace(t);
  const service = new TaskService();
  const created = await service.createTask({ title: 'Fill the form', deliverables: [{ id: 'DEL-01', fill_file: 'form.docx', status: 'pending' }] } as never);
  await service.updateTask(created.id, { deliverables: [{ id: 'DEL-01', fill_file: null, template_ref: 'plain-text', format: 'txt', status: 'pending' }] } as never);
  assert.deepEqual((await frontmatter(ws, created.id)).deliverables, [{ id: 'DEL-01', template_ref: 'plain-text', format: 'txt', status: 'pending' }]);
});

test('a file to answer in must be picked, be a file of the task folder and have a type', async (t) => {
  await workspace(t);
  const service = new TaskService();
  const created = await service.createTask({ title: 'Fill the form' });
  for (const fill_file of ['', '   ', 'notes', 'task.md', '.hidden.xlsx', 'sheet.', 42]) {
    await assert.rejects(
      service.updateTask(created.id, { deliverables: [{ id: 'DEL-01', fill_file, status: 'pending' }] } as never),
      (err: Error & { statusCode?: number }) => err.statusCode === 400 && err.message.startsWith('DEL-01:'),
      JSON.stringify(fill_file),
    );
  }
  // A path is reduced to the file's own name: never a file outside the task folder.
  await service.updateTask(created.id, { deliverables: [{ id: 'DEL-01', fill_file: '../../profile/secret.md', status: 'pending' }] } as never);
  assert.equal((await service.getTask(created.id)).deliverables[0]?.['fill_file' as never], 'secret.md');
});

test('the workspace task schema takes any file type for an attached file, and only output formats otherwise', async () => {
  const schema = JSON.parse(await fsp.readFile(path.join(__dirname, '..', '..', 'templates', 'workspace', '.schemas', 'task.schema.json'), 'utf-8'));
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const task = (deliverable: Record<string, unknown>) => ({
    schema_version: '1.0', id: 'TASK-2026-0001', type: 'task', title: 'Fictional', status: 'backlog', priority: 'medium',
    created_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z', deliverables: [{ id: 'DEL-01', ...deliverable }],
  });
  assert.equal(validate(task({ fill_file: 'answers.csv', format: 'csv' })), true, JSON.stringify(validate.errors));
  assert.equal(validate(task({ template_ref: 'executive-document', format: 'docx' })), true, JSON.stringify(validate.errors));
  assert.equal(validate(task({ template_ref: 'executive-document', format: 'csv' })), false, 'a template deliverable keeps the output formats');
  assert.equal(validate(task({ fill_file: 'answers.csv', format: 'CSV file' })), false);
});


test('file deliverables use the upload normalization for spaces, Unicode and long names', async (t) => {
  await workspace(t);
  const service = new TaskService();
  for (const name of [' Supplier.xlsx', 'Cafe\u0301.xlsx', '会'.repeat(100) + '.xlsx']) {
    const task = await service.createTask({ title: 'Answer the fictional form', deliverables: [{ id: 'DEL-01', fill_file: name, status: 'pending' }] } as never);
    const saved = await service.saveTaskFile(task.id, name, Buffer.from('fictional sheet'));
    const deliverable = (await service.getTask(task.id)).deliverables[0] as unknown as { fill_file: string };
    assert.equal(deliverable.fill_file, saved.name, name);
  }
});

test('task attachments never list, write or delete through a linked folder or ancestor', async (t) => {
  const ws = await workspace(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-attachment-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  const service = new TaskService();
  const id = 'TASK-2026-0900';
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const relative of ['tasks/active/' + id, 'tasks/active', 'tasks']) {
    const link = path.join(ws, relative);
    const tail = path.relative(link, path.join(ws, 'tasks/active', id));
    const target = path.join(outside, tail);
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, 'form.txt'), 'original');
    await fsp.rm(link, { recursive: true, force: true });
    await fsp.symlink(outside, link, linkType);
    try {
      await assert.rejects(service.listTaskFiles(id), /Invalid path traversal/);
      await assert.rejects(service.saveTaskFile(id, 'form.txt', Buffer.from('changed')), /Invalid path traversal/);
      await assert.rejects(service.deleteTaskFile(id, 'form.txt'), /Invalid path traversal/);
      assert.equal(await fsp.readFile(path.join(target, 'form.txt'), 'utf8'), 'original');
    } finally {
      await fsp.unlink(link);
    }
  }
});
