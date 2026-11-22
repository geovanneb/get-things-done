import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AddressInfo } from 'node:net';
import express from 'express';
import { TaskService } from '../src/services/taskService';
import { ContextService, contextMigrateHooks } from '../src/services/contextService';
import { OutputService } from '../src/services/outputService';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { parseMarkdown, stringifyMarkdown } from '../src/utils/markdown';

/**
 * Open folder for tasks, context notes, output templates and context update materials: the server names each folder,
 * relative to the workspace, so the page never builds a path itself (a task's folder moves when it is archived).
 */

/** A throwaway fictional workspace; services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-show-in-folder-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  for (const d of ['tasks/active', 'tasks/archive', 'context', 'outputs/templates', 'context-updates']) {
    await fsp.mkdir(path.join(dir, d), { recursive: true });
  }
  return dir;
}

async function server(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const { default: tasks } = await import('../src/routes/tasks');
  const { default: context } = await import('../src/routes/context');
  const { default: outputs } = await import('../src/routes/outputs');
  const { default: updates } = await import('../src/routes/contextUpdates');
  const { errorHandler } = await import('../src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasks);
  app.use('/api/context', context);
  app.use('/api/outputs', outputs);
  app.use('/api/context-updates', updates);
  app.use(errorHandler);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  t.after(() => listener.close());
  return `http://127.0.0.1:${(listener.address() as AddressInfo).port}/api`;
}

async function folderOf(url: string): Promise<{ status: number; folder?: string }> {
  const res = await fetch(url);
  const body = await res.json() as { folder?: string };
  return { status: res.status, folder: body.folder };
}

test('a task\'s folder is in tasks/active, then in tasks/archive once archived; a gone task is 404', async (t) => {
  const ws = await workspace(t);
  const api = await server(t);
  const tasks = new TaskService();
  const task = await tasks.createTask({ title: 'Fictional board pack' });

  assert.deepEqual(await folderOf(`${api}/tasks/${task.id}/folder`), { status: 200, folder: `tasks/active/${task.id}` });
  await tasks.archiveTask(task.id);
  assert.deepEqual(await folderOf(`${api}/tasks/${task.id}/folder`), { status: 200, folder: `tasks/archive/${task.id}` }, 'the archived folder');
  assert.equal(await tasks.taskFolder(task.id), `tasks/archive/${task.id}`);

  assert.equal((await folderOf(`${api}/tasks/TASK-2026-0999/folder`)).status, 404);
  // A folder without its task.md is not a task.
  await fsp.mkdir(path.join(ws, 'tasks', 'active', 'TASK-2026-0998'));
  assert.equal((await folderOf(`${api}/tasks/TASK-2026-0998/folder`)).status, 404);
  assert.equal((await folderOf(`${api}/tasks/..%2F..%2Fcontext/folder`)).status, 400);
});

test('a task folder that is a link to somewhere else is refused, never named', async (t) => {
  const ws = await workspace(t);
  const api = await server(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.writeFile(path.join(outside, 'task.md'), stringifyMarkdown('', { id: 'TASK-2026-0050', title: 'Fictional elsewhere' }));
  await fsp.symlink(outside, path.join(ws, 'tasks', 'archive', 'TASK-2026-0050'), 'dir');
  const res = await folderOf(`${api}/tasks/TASK-2026-0050/folder`);
  assert.equal(res.status, 400);
  assert.equal(res.folder, undefined);
});

test('a context note\'s folder follows it to another category; a template names its own folder', async (t) => {
  await workspace(t);
  const api = await server(t);
  const notes = new ContextService();
  const note = await notes.createContextNote({ title: 'Fictional pricing', category: 'strategy' });
  assert.deepEqual(await folderOf(`${api}/context/${note.id}/folder`), { status: 200, folder: 'context/strategy/fictional-pricing' });
  await notes.updateContextNote(note.id, { category: 'risks' });
  assert.deepEqual(await folderOf(`${api}/context/${note.id}/folder`), { status: 200, folder: 'context/risks/fictional-pricing' }, 'after a move');
  assert.equal((await folderOf(`${api}/context/CTX-not-there/folder`)).status, 404);

  const templates = new OutputService();
  const template = await templates.createTemplate({ name: 'Fictional memo', format: 'DOCX' });
  assert.deepEqual(await folderOf(`${api}/outputs/templates/${template.id}/folder`), { status: 200, folder: 'outputs/templates/fictional-memo' });
  await templates.deleteTemplate(template.id);
  assert.equal((await folderOf(`${api}/outputs/templates/${template.id}/folder`)).status, 404);
});

test('an update names its materials folder while files are kept, and not once they are deleted', async (t) => {
  const ws = await workspace(t);
  const api = await server(t);
  const service = new ContextUpdateService();
  const done = async (id: string, keep: boolean) => {
    const file = path.join(ws, 'context-updates', id, 'update.md');
    const parsed = parseMarkdown(await fsp.readFile(file, 'utf-8'));
    await fsp.writeFile(file, stringifyMarkdown(parsed.content, { ...parsed.data, status: 'done', ...(keep ? { keep_materials: true } : {}) }));
  };
  const detail = async (id: string) => (await (await fetch(`${api}/context-updates/${id}`)).json()) as { materials_folder: string | null; material_files: unknown[] };

  const open = await service.create({ text: 'A fictional note.' });
  assert.equal((await detail(open.id)).materials_folder, `context-updates/${open.id}/materials`, 'while ready');

  const empty = await service.create({});
  assert.equal((await detail(empty.id)).materials_folder, null, 'nothing to open without files');

  const kept = await service.create({ text: 'Kept fictional note.' });
  await done(kept.id, true);
  assert.equal((await detail(kept.id)).materials_folder, `context-updates/${kept.id}/materials`, 'done and kept');

  const released = await service.create({ text: 'Released fictional note.' });
  await done(released.id, false);
  const gone = await detail(released.id);
  assert.equal(gone.materials_folder, null, 'done and deleted');
  assert.equal(gone.material_files.length, 0);
});

test('looking up a note\'s folder moves nothing, and an old single file never overwrites a note of the same name', async (t) => {
  const ws = await workspace(t);
  const api = await server(t);
  const company = path.join(ws, 'context', 'company');
  await fsp.mkdir(path.join(company, 'memo'), { recursive: true });
  const legacy = path.join(company, 'memo.md');
  const current = path.join(company, 'memo', 'note.md');
  await fsp.writeFile(legacy, stringifyMarkdown('Legacy body', { id: 'CTX-legacy', title: 'Fictional legacy memo' }));
  await fsp.writeFile(current, stringifyMarkdown('Current body', { id: 'CTX-current', title: 'Fictional current memo' }));
  const intact = async () => {
    assert.match(await fsp.readFile(legacy, 'utf-8'), /CTX-legacy[\s\S]*Legacy body/);
    assert.match(await fsp.readFile(current, 'utf-8'), /CTX-current[\s\S]*Current body/);
  };

  // The folder route is read only: a note that is still a single file has no folder yet, and nothing is moved.
  assert.equal((await folderOf(`${api}/context/CTX-legacy/folder`)).status, 404);
  await intact();
  assert.deepEqual(await folderOf(`${api}/context/CTX-current/folder`), { status: 200, folder: 'context/company/memo' });
  await intact();

  // A scan that migrates (the list, a lookup by id) leaves the old file where it is instead of renaming it over note.md.
  const notes = new ContextService();
  const listed = (await notes.listContextNotes('company')).map((n) => n.id).sort();
  assert.deepEqual(listed, ['CTX-current', 'CTX-legacy']);
  await intact();
  assert.equal((await notes.getContextNote('CTX-legacy')).body?.trim(), 'Legacy body');
  assert.equal((await notes.getContextNote('CTX-current')).body?.trim(), 'Current body');
  await intact();
  // Folder actions on the single file are refused, never run on the whole category folder.
  await assert.rejects(notes.listContextFiles('CTX-legacy'), (err: { statusCode?: number }) => err.statusCode === 409);
  await assert.rejects(notes.updateContextNote('CTX-legacy', { category: 'risks' }), (err: { statusCode?: number }) => err.statusCode === 409);
  await intact();
  await fsp.access(path.join(ws, 'context', 'company'));

  // Without a clash, an old single file is still migrated as before.
  await fsp.writeFile(path.join(company, 'plan.md'), stringifyMarkdown('Plan body', { id: 'CTX-plan', title: 'Fictional plan' }));
  await notes.getContextNote('CTX-plan');
  await fsp.access(path.join(company, 'plan', 'note.md'));
  assert.deepEqual(await folderOf(`${api}/context/CTX-plan/folder`), { status: 200, folder: 'context/company/plan' });
});

test('a note saved into the folder while an old single file is being migrated is never overwritten', async (t) => {
  const ws = await workspace(t);
  const company = path.join(ws, 'context', 'company');
  await fsp.mkdir(company, { recursive: true });
  const legacy = path.join(company, 'draft.md');
  const saved = path.join(company, 'draft', 'note.md');
  await fsp.writeFile(legacy, stringifyMarkdown('Legacy body', { id: 'CTX-draft-old', title: 'Fictional old draft' }));
  // The other save lands after the migration made the folder, right before the move: created exclusively, as a save does.
  contextMigrateHooks.beforeMove = async (noteFile) => {
    contextMigrateHooks.beforeMove = undefined;
    assert.equal(noteFile, saved);
    await fsp.writeFile(saved, stringifyMarkdown('Concurrent save', { id: 'CTX-draft-new', title: 'Fictional new draft' }), { flag: 'wx' });
  };
  t.after(() => { contextMigrateHooks.beforeMove = undefined; });

  const notes = new ContextService();
  // This listing read the category before the other save; it still shows the old note, from where it stayed.
  assert.deepEqual((await notes.listContextNotes('company')).map((n) => n.id), ['CTX-draft-old']);
  assert.equal(contextMigrateHooks.beforeMove, undefined, 'the hook ran');
  assert.deepEqual((await notes.listContextNotes('company')).map((n) => n.id).sort(), ['CTX-draft-new', 'CTX-draft-old']);
  assert.match(await fsp.readFile(saved, 'utf-8'), /CTX-draft-new[\s\S]*Concurrent save/);
  assert.match(await fsp.readFile(legacy, 'utf-8'), /CTX-draft-old[\s\S]*Legacy body/);
  assert.equal((await notes.getContextNote('CTX-draft-new')).body?.trim(), 'Concurrent save');
  assert.equal((await notes.getContextNote('CTX-draft-old')).body?.trim(), 'Legacy body');
});

test('a migration that cannot remove the old file deletes nothing, lists the note once, and finishes later', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'folder permissions do not apply here' : false }, async (t) => {
  const ws = await workspace(t);
  const company = path.join(ws, 'context', 'company');
  await fsp.mkdir(path.join(company, 'draft'), { recursive: true });
  const legacy = path.join(company, 'draft.md');
  const noteFile = path.join(company, 'draft', 'note.md');
  const text = stringifyMarkdown('Draft body', { id: 'CTX-draft', title: 'Fictional draft' });
  await fsp.writeFile(legacy, text);
  // The category folder is read-only: the link into the writable note folder works, removing the old name does not.
  await fsp.chmod(company, 0o555);
  t.after(() => fsp.chmod(company, 0o755).catch(() => undefined));

  const notes = new ContextService();
  assert.deepEqual((await notes.listContextNotes('company')).map((n) => n.id), ['CTX-draft']);
  assert.equal(await fsp.readFile(legacy, 'utf-8'), text, 'the old name is untouched');
  assert.equal(await fsp.readFile(noteFile, 'utf-8'), text, 'nothing deleted: the claim stays');
  assert.deepEqual((await notes.listContextNotes('company')).map((n) => n.id), ['CTX-draft'], 'still once on the next scan');
  assert.equal((await notes.getContextNote('CTX-draft')).path, noteFile, 'found at its new place');

  // Writable again: the next scan finishes the move.
  await fsp.chmod(company, 0o755);
  assert.deepEqual((await notes.listContextNotes('company')).map((n) => n.id), ['CTX-draft']);
  assert.equal(await fsp.readFile(noteFile, 'utf-8'), text);
  await assert.rejects(fsp.access(legacy));
});

test('an interrupted migration (one file under both names) is listed once and finished', async (t) => {
  const ws = await workspace(t);
  const company = path.join(ws, 'context', 'company');
  await fsp.mkdir(path.join(company, 'draft'), { recursive: true });
  const legacy = path.join(company, 'draft.md');
  const noteFile = path.join(company, 'draft', 'note.md');
  const text = stringifyMarkdown('Draft body', { id: 'CTX-draft', title: 'Fictional draft' });
  await fsp.writeFile(noteFile, text);
  await fsp.link(noteFile, legacy);

  const notes = new ContextService();
  // The read-only folder route sees it once too, and moves nothing.
  assert.equal(await notes.contextFolder('CTX-draft'), 'context/company/draft');
  await fsp.access(legacy);
  assert.deepEqual((await notes.listContextNotes('company')).map((n) => n.id), ['CTX-draft']);
  await assert.rejects(fsp.access(legacy), 'the old name is removed');
  assert.equal(await fsp.readFile(noteFile, 'utf-8'), text);
});

test('an interrupted copy (the same bytes under both names) is listed once and finished; different bytes are a clash', async (t) => {
  const ws = await workspace(t);
  const company = path.join(ws, 'context', 'company');
  await fsp.mkdir(path.join(company, 'draft'), { recursive: true });
  const text = stringifyMarkdown('Draft body', { id: 'CTX-draft', title: 'Fictional draft' });
  await fsp.writeFile(path.join(company, 'draft', 'note.md'), text);
  await fsp.writeFile(path.join(company, 'draft.md'), text);
  const notes = new ContextService();
  assert.deepEqual((await notes.listContextNotes('company')).map((n) => n.id), ['CTX-draft']);
  await assert.rejects(fsp.access(path.join(company, 'draft.md')), 'the old copy is removed');

  await fsp.writeFile(path.join(company, 'draft.md'), stringifyMarkdown('Edited', { id: 'CTX-draft-old', title: 'Fictional old' }));
  assert.deepEqual((await notes.listContextNotes('company')).map((n) => n.id).sort(), ['CTX-draft', 'CTX-draft-old']);
  await fsp.access(path.join(company, 'draft.md'));
});

test('a note.md that is a link back to the old file is a clash: the only real copy is never removed', { skip: process.platform === 'win32' ? 'links need special rights on Windows' : false }, async (t) => {
  const ws = await workspace(t);
  const company = path.join(ws, 'context', 'company');
  await fsp.mkdir(path.join(company, 'draft'), { recursive: true });
  const legacy = path.join(company, 'draft.md');
  const text = stringifyMarkdown('Draft body', { id: 'CTX-draft', title: 'Fictional draft' });
  await fsp.writeFile(legacy, text);
  await fsp.symlink(legacy, path.join(company, 'draft', 'note.md'));
  const notes = new ContextService();
  assert.deepEqual((await notes.listContextNotes('company')).map((n) => n.id), ['CTX-draft']);
  assert.equal(await fsp.readFile(legacy, 'utf-8'), text, 'the real file stays');
  assert.ok((await fsp.lstat(path.join(company, 'draft', 'note.md'))).isSymbolicLink(), 'the link is left as it is');
  assert.equal(await fsp.readFile(legacy, 'utf-8'), text);
});
