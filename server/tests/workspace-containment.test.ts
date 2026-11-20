import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { ContextService } from '../src/services/contextService';
import { createCategory } from '../src/services/contextCategories';
import { OutputService } from '../src/services/outputService';
import { ClaudeChatAdapter } from '../src/services/chat/claude';
import { CHAT_INSTRUCTIONS } from '../src/services/chat/chatService';
import { writeRunnerSettings } from '../src/services/agentRunner';
import { deleteAttachment, fileInside, isBelow, saveAttachment, workspaceEntry } from '../src/utils/files';
import { atomicCreate } from '../src/utils/atomicWrite';
import { StakeholderService } from '../src/services/stakeholderService';
import { spawn } from 'node:child_process';
import { FileService } from '../src/services/fileService';
import { createRequire, syncBuiltinESMExports } from 'node:module';

/** The shared fs/promises object, so a test can make one write fail for every importer. */
const fsPromises = createRequire(__filename)('fs/promises') as typeof import('fs/promises');

type T = { after: (fn: () => Promise<void> | void) => void; skip: (message?: string) => void };

/** A throwaway fictional workspace; the services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: T): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-contain-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await fsp.mkdir(path.join(dir, 'context'), { recursive: true });
  return dir;
}

/** A folder outside the workspace, removed after the test. */
async function outside(t: T): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-contain-outside-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Replaces `at` with a link to `target` (a junction on Windows). False when this system does not allow links. */
async function link(target: string, at: string): Promise<boolean> {
  await fsp.rm(at, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(at), { recursive: true });
  try {
    await fsp.symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw err;
  }
}

/** Every file below `dir`, relative, with its content: to prove nothing outside was written, moved or removed. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fsp.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full)] = await fsp.readFile(full, 'utf-8');
  }
  return out;
}

const TRAVERSAL = /Invalid path traversal/;

test('context notes are never discovered, migrated or created through a linked category or context folder', async (t) => {
  const ws = await workspace(t);
  await createCategory(ws, { label: 'Vendors' });
  const notes = new ContextService();
  for (const relative of ['context/vendors', 'context/situation', 'context']) {
    const away = await outside(t);
    // What the link would show: a legacy single-file note (listing would migrate it) and a note in the new layout.
    const category = relative === 'context' ? path.join(away, 'vendors') : away;
    await fsp.mkdir(path.join(category, 'outside-note'), { recursive: true });
    await fsp.writeFile(path.join(category, 'legacy-note.md'), '---\nid: CTX-legacy-note\ntitle: Legacy\n---\nFictional legacy text.\n');
    await fsp.writeFile(path.join(category, 'outside-note', 'note.md'), '---\nid: CTX-outside-note\ntitle: Outside\n---\nFictional.\n');
    const before = await snapshot(away);
    const restore = path.join(ws, relative);
    const saved = relative === 'context' ? null : await fsp.readdir(restore).catch(() => null);
    if (relative === 'context') await fsp.rename(restore, `${restore}.real`);
    if (!(await link(away, restore))) { t.skip('this system does not allow folder links'); return; }

    await assert.rejects(notes.listContextNotes(), TRAVERSAL, relative);
    // With the whole context folder linked, its category registry is not read either: only built-in categories exist.
    const target = relative === 'context' ? 'situation' : 'vendors';
    if (relative !== 'context/situation') await assert.rejects(notes.listContextNotes(target as never), TRAVERSAL, relative);
    else await notes.listContextNotes(target as never); // another category's link does not stop this one
    await assert.rejects(notes.getContextNote('CTX-outside-note'), TRAVERSAL, relative);
    await assert.rejects(notes.createContextNote({ category: target, title: 'New vendor' }), TRAVERSAL, relative);
    assert.deepEqual(await snapshot(away), before, `${relative}: nothing outside was read into, migrated or written`);

    await fsp.unlink(restore);
    if (relative === 'context') await fsp.rename(`${restore}.real`, restore);
    else if (saved) await fsp.mkdir(restore);
  }
});

test('a note cannot be moved into a linked category folder', async (t) => {
  const ws = await workspace(t);
  await createCategory(ws, { label: 'Vendors' });
  const notes = new ContextService();
  const note = await notes.createContextNote({ category: 'situation', title: 'Freight terms', body: 'Fictional.\n' });
  const away = await outside(t);
  if (!(await link(away, path.join(ws, 'context', 'vendors')))) { t.skip('this system does not allow folder links'); return; }
  // Discovery refuses the linked category before the move is even considered.
  await assert.rejects(notes.updateContextNote(note.id!, { category: 'vendors' }), TRAVERSAL);
  assert.deepEqual(await fsp.readdir(away), []);
  assert.ok((await fsp.stat(path.join(ws, 'context', 'situation', 'freight-terms', 'note.md'))).isFile(), 'the note stays where it was');
});

test('note and template attachments are never listed, read, zipped, written or deleted through a linked owner folder', async (t) => {
  const ws = await workspace(t);
  const notes = new ContextService();
  const templates = new OutputService();
  const note = await notes.createContextNote({ category: 'situation', title: 'Board pack', body: 'Fictional.\n' });
  const template = await templates.createTemplate({ name: 'Weekly memo' });
  // The owner's real folder moves out of the workspace, and a link takes its place in an ancestor.
  for (const [ancestor, ops] of [
    ['context/situation', {
      list: () => notes.listContextFiles(note.id!), zip: () => notes.contextArchive(note.id!), open: () => notes.contextFilePath(note.id!, 'form.txt'),
      save: () => notes.saveContextFile(note.id!, 'form.txt', Buffer.from('changed')), remove: () => notes.deleteContextFile(note.id!, 'form.txt'),
    }],
    ['outputs/templates', {
      list: () => templates.listTemplateFiles(template.id), zip: () => templates.templateArchive(template.id), open: () => templates.templateFilePath(template.id, 'form.txt'),
      save: () => templates.saveTemplateFile(template.id, 'form.txt', Buffer.from('changed')), remove: () => templates.deleteTemplateFile(template.id, 'form.txt'),
    }],
    ['outputs', {
      list: () => templates.listTemplateFiles(template.id), zip: () => templates.templateArchive(template.id), open: () => templates.templateFilePath(template.id, 'form.txt'),
      save: () => templates.saveTemplateFile(template.id, 'form.txt', Buffer.from('changed')), remove: () => templates.deleteTemplateFile(template.id, 'form.txt'),
    }],
  ] as const) {
    const real = path.join(ws, ancestor);
    const away = path.join(await outside(t), 'moved');
    await fsp.rename(real, away);
    if (!(await link(away, real))) { t.skip('this system does not allow folder links'); return; }
    const owner = (await fsp.readdir(away, { recursive: true, withFileTypes: true })).find((e) => e.name === 'note.md' || e.name === 'output.md')!;
    await fsp.writeFile(path.join(owner.parentPath, 'form.txt'), 'original');
    for (const [name, op] of Object.entries(ops)) await assert.rejects(op(), TRAVERSAL, `${ancestor}: ${name}`);
    assert.equal(await fsp.readFile(path.join(owner.parentPath, 'form.txt'), 'utf-8'), 'original', ancestor);
    await fsp.unlink(path.join(owner.parentPath, 'form.txt'));
    await fsp.unlink(real);
    await fsp.rename(away, real);
  }
  // Back in place, the same operations work again.
  await notes.saveContextFile(note.id!, 'form.txt', Buffer.from('fine'));
  assert.deepEqual((await notes.listContextFiles(note.id!)).map((f) => f.name), ['form.txt']);
  await templates.saveTemplateFile(template.id, 'form.txt', Buffer.from('fine'));
  await templates.deleteTemplateFile(template.id, 'form.txt');
});

test('attachment writes and deletes check the owner folder again right before they change anything', async (t) => {
  const ws = await workspace(t);
  // The owner folder passed the caller's check, then was swapped for a link before the write or delete.
  const owner = path.join(ws, 'tasks', 'active', 'TASK-2026-0901');
  const away = await outside(t);
  await fsp.writeFile(path.join(away, 'form.txt'), 'original');
  if (!(await link(away, owner))) { t.skip('this system does not allow folder links'); return; }
  await assert.rejects(saveAttachment(owner, 'form.txt', Buffer.from('changed'), 'task.md', ws), TRAVERSAL);
  await assert.rejects(saveAttachment(owner, 'new.txt', Buffer.from('changed'), 'task.md', ws), TRAVERSAL);
  await assert.rejects(deleteAttachment(owner, 'form.txt', ws), TRAVERSAL);
  assert.deepEqual(await snapshot(away), { 'form.txt': 'original' });
});

test('chat and runner metadata is never written through a linked .situation-board, chat or runs folder', async (t) => {
  const ws = await workspace(t);
  const adapter = new ClaudeChatAdapter(() => path.join(ws, 'no-such-claude'), () => ({}));
  const options = { workspace: ws, model: null, effort: null, resume: null, instructions: CHAT_INSTRUCTIONS };
  for (const relative of ['.situation-board/runs', '.situation-board/chat', '.situation-board']) {
    const away = await outside(t);
    const real = path.join(ws, relative);
    if (!(await link(away, real))) { t.skip('this system does not allow folder links'); return; }
    await assert.rejects(adapter.open(options), TRAVERSAL, relative);
    if (relative !== '.situation-board/chat') await assert.rejects(writeRunnerSettings(ws), TRAVERSAL, relative);
    assert.deepEqual(await fsp.readdir(away, { recursive: true }), [], `${relative}: nothing written outside`);
    await fsp.unlink(real);
  }
});

test('creating a note never overwrites an old single-file note that the id check just migrated into its folder', async (t) => {
  const ws = await workspace(t);
  const company = path.join(ws, 'context', 'company');
  await fsp.mkdir(company, { recursive: true });
  // An old single-file note at the slug "Agenda 2" turns into, with a different id.
  const old = '---\nid: CTX-older\ntitle: Older agenda\n---\nOlder text.\n';
  await fsp.writeFile(path.join(company, 'agenda-2.md'), old);
  const notes = new ContextService();
  await assert.rejects(notes.createContextNote({ category: 'company', title: 'Agenda 2' }), (e: { statusCode?: number }) => e.statusCode === 409);
  assert.equal(await fsp.readFile(path.join(company, 'agenda-2', 'note.md'), 'utf-8'), old, 'the migrated note keeps its bytes');
  assert.equal((await notes.getContextNote('CTX-older')).body.trim(), 'Older text.');
});

test('a linked trash folder never receives a deleted file or the previous version of an edited note', async (t) => {
  const ws = await workspace(t);
  const notes = new ContextService();
  const note = await notes.createContextNote({ category: 'situation', title: 'Board pack', body: 'Original.\n' });
  const file = path.join(ws, 'context', 'situation', 'board-pack', 'note.md');
  const before = await fsp.readFile(file, 'utf-8');
  for (const relative of ['.situation-board/trash', '.situation-board']) {
    const away = await outside(t);
    const real = path.join(ws, relative);
    const keep = `${real}.real`;
    await fsp.rename(real, keep).catch(() => { /* no trash folder yet */ });
    if (!(await link(away, real))) { t.skip('this system does not allow folder links'); return; }
    // Edit: the previous version would be copied into the trash first (with .situation-board itself linked, the
    // note's lock there is refused even earlier).
    await assert.rejects(notes.updateContextNote(note.id!, { body: 'Changed.\n' }), TRAVERSAL, relative);
    assert.equal(await fsp.readFile(file, 'utf-8'), before, `${relative}: the note is unchanged`);
    // Delete: the file would be moved into the trash.
    await assert.rejects(new FileService().deleteFile(file), TRAVERSAL, relative);
    assert.equal(await fsp.readFile(file, 'utf-8'), before, `${relative}: the file stays where it is`);
    assert.deepEqual(await fsp.readdir(away), [], `${relative}: nothing outside`);
    await fsp.unlink(real);
    await fsp.rename(keep, real).catch(() => {});
  }
  // With a real trash folder again, both work.
  await notes.updateContextNote(note.id!, { body: 'Changed.\n' });
  await new FileService().deleteFile(file);
  assert.equal((await fsp.readdir(path.join(ws, '.situation-board', 'trash'))).length, 2);
});

test('a workspace at the root of a volume is not mistaken for a path outside it', async (t) => {
  // The real root of this system's temporary folder, and an ordinary folder below it (no links on the way).
  const below = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-contain-root-')));
  t.after(() => fsp.rm(below, { recursive: true, force: true }));
  await fsp.writeFile(path.join(below, 'note.md'), 'fictional');
  const root = path.parse(below).root;
  assert.equal(await workspaceEntry(root, path.join(below, 'note.md')), path.join(below, 'note.md'));
  assert.equal(await fileInside(root, path.relative(root, path.join(below, 'note.md'))), path.join(below, 'note.md'));
  assert.equal(isBelow(root, root), false);
  // An ordinary workspace: its children are inside, a sibling with the same prefix and the folder itself are not.
  assert.equal(isBelow(below, path.join(below, 'note.md')), true);
  assert.equal(isBelow(below, `${below}-other`), false);
  assert.equal(isBelow(below, below), false);
  assert.equal(isBelow(below, path.dirname(below)), false);
  await assert.rejects(workspaceEntry(below, `${below}-other`), TRAVERSAL);
});

test('a create that fails after its file was opened leaves nothing behind, so the retry succeeds', async (t) => {
  const ws = await workspace(t);
  const notes = new ContextService();
  const writeFile = fsPromises.writeFile;
  let failed = 0;
  // The first exclusive write in the new note's folder opens its file, then the disk is full.
  (fsPromises as { writeFile: unknown }).writeFile = async (file: string, data: unknown, options: unknown) => {
    if (!failed && typeof file === 'string' && file.endsWith('.create-tmp') && path.basename(file).startsWith('.note.md.')) {
      failed++;
      await (writeFile as (...a: unknown[]) => Promise<void>)(file, '', options);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return (writeFile as (...a: unknown[]) => Promise<void>)(file, data, options);
  };
  syncBuiltinESMExports();
  t.after(() => { (fsPromises as { writeFile: unknown }).writeFile = writeFile; syncBuiltinESMExports(); });
  await assert.rejects(notes.createContextNote({ category: 'situation', title: 'Board pack', body: 'Fictional.\n' }), /ENOSPC/);
  assert.equal(failed, 1);
  const dir = path.join(ws, 'context', 'situation', 'board-pack');
  assert.deepEqual(await fsp.readdir(dir), [], 'no half-written note.md, no temporary file');
  assert.deepEqual(await fsp.readdir(path.join(ws, '.situation-board', 'tmp')), [], 'the staging file is removed too');
  (fsPromises as { writeFile: unknown }).writeFile = writeFile;
  syncBuiltinESMExports();
  const note = await notes.createContextNote({ category: 'situation', title: 'Board pack', body: 'Fictional.\n' });
  assert.equal((await notes.getContextNote(note.id!)).body.trim(), 'Fictional.');
});

test('a move with an edit refused by a linked trash folder leaves the note and its files where they were', async (t) => {
  const ws = await workspace(t);
  const notes = new ContextService();
  const note = await notes.createContextNote({ category: 'situation', title: 'Board pack', body: 'Original.\n' });
  await notes.saveContextFile(note.id!, 'minutes.txt', Buffer.from('attached'));
  const away = await outside(t);
  if (!(await link(away, path.join(ws, '.situation-board', 'trash')))) { t.skip('this system does not allow folder links'); return; }
  await assert.rejects(notes.updateContextNote(note.id!, { category: 'strategy', body: 'Changed.\n' }), TRAVERSAL);
  const kept = await notes.getContextNote(note.id!);
  assert.equal(kept.category, 'situation');
  assert.equal(kept.body.trim(), 'Original.');
  assert.deepEqual((await notes.listContextFiles(note.id!)).map((f) => f.name), ['minutes.txt']);
  assert.equal(await fsp.readdir(path.join(ws, 'context', 'strategy')).then((e) => e.length, () => 0), 0, 'nothing moved to the new category');
  assert.deepEqual(await fsp.readdir(away), []);
});

test('containment compares path components exactly, also for Windows paths', () => {
  const w = path.win32;
  assert.equal(isBelow('C:\\', 'C:\\Work\\a.md', w), true, 'a drive root');
  assert.equal(isBelow('C:\\', 'C:\\', w), false);
  assert.equal(isBelow('C:\\Work', 'C:\\Work\\a.md', w), true);
  assert.equal(isBelow('C:\\Work', 'C:\\work\\a.md', w), false, 'a folder differing only in case may be another folder');
  assert.equal(isBelow('C:\\Work', 'C:\\Work-other\\a.md', w), false);
  assert.equal(isBelow('C:\\Work', 'C:\\Work', w), false);
  assert.equal(isBelow('C:\\Work', 'D:\\Work\\a.md', w), false);
  assert.equal(isBelow('/', '/srv/a.md', path.posix), true);
  assert.equal(isBelow('/srv/Work', '/srv/work/a.md', path.posix), false);
});

/** Replaces one fs/promises function for every importer until `restore` (or the end of the test). */
function patchFs(t: T, name: 'link' | 'open' | 'copyFile', make: (real: (...a: unknown[]) => Promise<unknown>) => unknown): () => void {
  const real = fsPromises[name] as unknown as (...a: unknown[]) => Promise<unknown>;
  (fsPromises as Record<string, unknown>)[name] = make(real);
  syncBuiltinESMExports();
  let done = false;
  const restore = () => { if (done) return; done = true; (fsPromises as Record<string, unknown>)[name] = real; syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}

test('without hard links, a create whose write fails removes its own file, so the retry succeeds', async (t) => {
  const ws = await workspace(t);
  const notes = new ContextService();
  const unlinkable = patchFs(t, 'link', () => async () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); });
  // The exclusive fallback opens note.md, then the disk is full.
  const opened = patchFs(t, 'open', (open) => async (...args: unknown[]) => {
    const handle = await open(...args) as import('fs/promises').FileHandle;
    if (String(args[0]).endsWith(`${path.sep}note.md`) && args[1] === 'wx') {
      handle.writeFile = async () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
    }
    return handle;
  });
  await assert.rejects(notes.createContextNote({ category: 'situation', title: 'Board pack', body: 'Fictional.\n' }), /ENOSPC/);
  const dir = path.join(ws, 'context', 'situation', 'board-pack');
  assert.deepEqual(await fsp.readdir(dir), [], 'no zero-byte note.md, no temporary file');
  opened();
  // Still no hard links: the fallback itself works and the name is free again.
  const note = await notes.createContextNote({ category: 'situation', title: 'Board pack', body: 'Fictional.\n' });
  assert.equal((await notes.getContextNote(note.id!)).body.trim(), 'Fictional.');
  unlinkable();
});

test('only staging files of ended processes are removed, and only from the app staging folder', async (t) => {
  const ws = await workspace(t);
  const staging = path.join(ws, '.situation-board', 'tmp');
  const people = path.join(ws, 'stakeholders', 'people');
  await fsp.mkdir(staging, { recursive: true });
  await fsp.mkdir(people, { recursive: true });
  // A process id that is no longer in use: a child that has exited.
  const child = spawn(process.execPath, ['-e', '']);
  const dead = await new Promise<number>((resolve) => child.on('exit', () => resolve(child.pid!)));
  const ended = path.join(staging, `.stk-0001.md.${dead}.${crypto.randomUUID()}.create-tmp`);
  const running = path.join(staging, `.stk-0002.md.${process.pid}.${crypto.randomUUID()}.create-tmp`);
  const notUuid = path.join(staging, `.stk-0003.md.${dead}.${'a'.repeat(36)}.create-tmp`);
  // Files of the user's own in the owner folder, named like staging files: never the app's to remove.
  const lookAlike = path.join(people, `.recovered-stk-0004.md.${dead}.${crypto.randomUUID()}.create-tmp`);
  for (const f of [ended, running, notUuid, lookAlike]) await fsp.writeFile(f, '---\nid: fictional\n---\n');
  // However old a running process's file is, it stays.
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await fsp.utimes(running, longAgo, longAgo);
  await new StakeholderService().createStakeholder({ name: 'Fictional Person', role: 'Analyst', organization: 'Example Co.' } as never);
  assert.deepEqual((await fsp.readdir(staging)).sort(), [path.basename(notUuid), path.basename(running)].sort());
  const owner = await fsp.readdir(people);
  assert.ok(owner.includes(path.basename(lookAlike)), 'the look-alike in the owner folder is untouched');
  assert.deepEqual(owner.filter((n) => n.endsWith('.create-tmp') && n !== path.basename(lookAlike)), [], 'no staging file in the owner folder');
  assert.equal(owner.filter((n) => n.endsWith('.md')).length, 1, 'the stakeholder was created');
});

test('a create without a workspace stages beside the file and sweeps nothing there', async (t) => {
  const dir = await outside(t);
  const lookAlike = path.join(dir, `.x.md.999999.${crypto.randomUUID()}.create-tmp`);
  await fsp.writeFile(lookAlike, 'user file');
  await atomicCreate(path.join(dir, 'x.md'), 'fictional', null);
  assert.deepEqual((await fsp.readdir(dir)).sort(), [path.basename(lookAlike), 'x.md'].sort());
});

test('a move with an edit whose backup fails (a full trash) leaves the note and its files where they were', async (t) => {
  const ws = await workspace(t);
  const notes = new ContextService();
  const note = await notes.createContextNote({ category: 'situation', title: 'Board pack', body: 'Original.\n' });
  await notes.saveContextFile(note.id!, 'minutes.txt', Buffer.from('attached'));
  const trash = path.join(ws, '.situation-board', 'trash');
  const restore = patchFs(t, 'copyFile', (copyFile) => async (...args: unknown[]) => {
    if (String(args[1]).startsWith(trash)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return copyFile(...args);
  });
  await assert.rejects(notes.updateContextNote(note.id!, { category: 'strategy', body: 'Changed.\n' }), /ENOSPC/);
  const kept = await notes.getContextNote(note.id!);
  assert.equal(kept.category, 'situation');
  assert.equal(kept.body.trim(), 'Original.');
  assert.deepEqual((await notes.listContextFiles(note.id!)).map((f) => f.name), ['minutes.txt']);
  restore();
  // With room again, the move and edit save exactly one previous version.
  const before = await fsp.readdir(trash).catch(() => [] as string[]);
  const moved = await notes.updateContextNote(note.id!, { category: 'strategy', body: 'Changed.\n' });
  assert.equal(moved.category, 'strategy');
  assert.equal((await fsp.readdir(trash)).length, before.length + 1, 'backed up once, not twice');
  assert.deepEqual((await notes.listContextFiles(note.id!)).map((f) => f.name), ['minutes.txt']);
});

test('a linked staging folder is refused before a new file is written there', async (t) => {
  const ws = await workspace(t);
  const away = await outside(t);
  if (!(await link(away, path.join(ws, '.situation-board', 'tmp')))) { t.skip('this system does not allow folder links'); return; }
  await assert.rejects(new ContextService().createContextNote({ category: 'situation', title: 'Board pack' }), TRAVERSAL);
  assert.deepEqual(await fsp.readdir(away), []);
  assert.equal(await fsp.stat(path.join(ws, 'context', 'situation', 'board-pack', 'note.md')).then(() => true, () => false), false);
});
