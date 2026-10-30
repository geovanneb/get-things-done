import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ContextUpdateService } from '../src/services/contextUpdateService';
import { isKaizenNote, openKaizenNotes } from '../src/services/kaizenIntake';
import { parseMarkdown, stringifyMarkdown } from '../src/utils/markdown';

/** A throwaway fictional workspace; the services read its path from ESB_WORKSPACE_PATH. */
async function workspace(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-kaizen-')));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await fsp.mkdir(path.join(dir, 'kaizen'), { recursive: true });
  return dir;
}

/** A note as /gtd-task Step 10 writes it after a rework. A field set to undefined is left out. */
function note(fields: Record<string, unknown> = {}): string {
  const data = {
    id: 'KAIZEN-2026-001', title: 'Totals were not checked', status: 'proposed', task_ref: 'TASK-2026-0007',
    symptom: 'The summary table added up wrong.', root_cause: 'No instruction says to check totals against the source.',
    proposed_fix: 'Add a rule to CLAUDE.md.', files_affected: ['CLAUDE.md'], area: 'instructions',
    created_at: '2026-10-20T09:00:00.000Z', ...fields,
  };
  return stringifyMarkdown('The executive asked for the totals to be fixed.', Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
}

async function readNote(ws: string, name: string): Promise<Record<string, unknown>> {
  return parseMarkdown(await fsp.readFile(path.join(ws, 'kaizen', name), 'utf-8')).data as Record<string, unknown>;
}

test('a new Kaizen note opens one Kaizen context update with the root cause, and the note points to it', async (t) => {
  const ws = await workspace(t);
  await fsp.writeFile(path.join(ws, 'kaizen', 'KAIZEN-2026-001.md'), note());

  const opened = await openKaizenNotes();
  assert.equal(opened.length, 1);
  const update = await new ContextUpdateService().get(opened[0]!);
  assert.equal(update.origin, 'kaizen');
  assert.equal(update.kind, 'kaizen');
  assert.equal(update.status, 'ready', 'never analyzed by itself');
  assert.equal(update.title, 'Totals were not checked');
  assert.equal(update.source_date, '2026-10-20');
  assert.deepEqual(update.kaizen, {
    note: 'KAIZEN-2026-001.md', task_ref: 'TASK-2026-0007', symptom: 'The summary table added up wrong.',
    root_cause: 'No instruction says to check totals against the source.', area: 'instructions',
  });
  assert.deepEqual(update.materials.map((m) => m.name), ['kaizen-note.md']);
  const material = await fsp.readFile(path.join(ws, 'context-updates', update.id, 'materials', 'kaizen-note.md'), 'utf-8');
  assert.match(material, /No instruction says to check totals/);

  const marked = await readNote(ws, 'KAIZEN-2026-001.md');
  assert.equal(marked['status'], 'moved');
  assert.equal(marked['context_update'], update.id);
  assert.equal(marked['root_cause'], 'No instruction says to check totals against the source.', 'the note keeps its content');

  assert.deepEqual(await openKaizenNotes(), [], 'a moved note is never opened again');
  assert.equal((await new ContextUpdateService().list()).length, 1);
});

test('a crash after opening the update but before marking the note never opens a second update', async (t) => {
  const ws = await workspace(t);
  await fsp.writeFile(path.join(ws, 'kaizen', 'KAIZEN-2026-001.md'), note());
  const [id] = await openKaizenNotes();
  // As if the dashboard stopped before it marked the note.
  await fsp.writeFile(path.join(ws, 'kaizen', 'KAIZEN-2026-001.md'), note());

  assert.deepEqual(await openKaizenNotes(), []);
  assert.equal((await new ContextUpdateService().list()).length, 1);
  assert.equal((await readNote(ws, 'KAIZEN-2026-001.md'))['context_update'], id);
});

test('applied, rejected, unreadable, oversized, linked and nested notes are left alone', async (t) => {
  const ws = await workspace(t);
  const dir = path.join(ws, 'kaizen');
  await fsp.writeFile(path.join(dir, 'KAIZEN-2026-001.md'), note({ status: 'applied' }));
  await fsp.writeFile(path.join(dir, 'KAIZEN-2026-002.md'), note({ status: 'rejected' }));
  await fsp.writeFile(path.join(dir, 'KAIZEN-2026-003.md'), '---\ntitle: [broken\n---\n');
  await fsp.writeFile(path.join(dir, 'KAIZEN-2026-004.md'), note({ symptom: 'x'.repeat(70 * 1024) }));
  await fsp.mkdir(path.join(dir, 'old'));
  await fsp.writeFile(path.join(dir, 'old', 'KAIZEN-2026-005.md'), note());
  await fsp.writeFile(path.join(dir, 'notes.txt'), 'not a note');
  if (process.platform !== 'win32') {
    const outside = path.join(ws, 'outside.md');
    await fsp.writeFile(outside, note());
    await fsp.symlink(outside, path.join(dir, 'KAIZEN-2026-006.md'));
  }

  assert.deepEqual(await openKaizenNotes(), []);
  assert.equal((await readNote(ws, 'KAIZEN-2026-001.md'))['status'], 'applied');
  assert.equal((await readNote(ws, 'KAIZEN-2026-002.md'))['status'], 'rejected');
  assert.equal(await fsp.readFile(path.join(dir, 'KAIZEN-2026-003.md'), 'utf-8'), '---\ntitle: [broken\n---\n');
});

test('what the agent wrote is checked: a bad task id or date is dropped, fields are text only', async (t) => {
  const ws = await workspace(t);
  await fsp.writeFile(path.join(ws, 'kaizen', 'KAIZEN-2026-001.md'), note({
    title: '', task_ref: '../TASK-2026-0007', created_at: '2026-02-31', symptom: ['not', 'text'], status: undefined,
  }));
  const [id] = await openKaizenNotes();
  const update = await new ContextUpdateService().get(id!);
  assert.equal(update.title, 'Kaizen');
  assert.equal(update.kaizen?.task_ref, '');
  assert.equal(update.kaizen?.symptom, '');
  assert.equal(update.source_date, new Date().toISOString().slice(0, 10), 'an impossible date falls back to today');
});

test('only files directly in kaizen/ count as notes for the watcher', async (t) => {
  const ws = await workspace(t);
  assert.equal(isKaizenNote(path.join(ws, 'kaizen', 'KAIZEN-2026-001.md')), true);
  assert.equal(isKaizenNote(path.join(ws, 'kaizen', 'old', 'KAIZEN-2026-001.md')), false);
  assert.equal(isKaizenNote(path.join(ws, 'context', 'KAIZEN-2026-001.md')), false);
  assert.equal(isKaizenNote(path.join(ws, 'kaizen', 'notes.txt')), false);
});
