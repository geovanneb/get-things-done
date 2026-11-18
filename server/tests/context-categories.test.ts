import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

async function workspace(t: { after: (fn: () => Promise<void>) => void }, prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  await fsp.mkdir(path.join(dir, 'context'), { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const status = (code: number) => (e: { statusCode?: number }) => e.statusCode === code;

test('a category of the workspace own holds notes like a built-in one, everywhere notes are read', async (t) => {
  const dir = await workspace(t, 'gtd-categories-');
  const categories = await import('../src/services/contextCategories');
  const { ContextService } = await import('../src/services/contextService');
  const { previewContextShare } = await import('../src/services/contextShare');
  const { proposalTarget } = await import('../src/services/contextUpdateService');
  const { SearchService } = await import('../src/services/searchService');
  const notes = new ContextService();

  const vendors = await categories.createCategory(dir, { label: 'Vendors & partners', description: 'Suppliers, contracts and service levels.' });
  assert.deepEqual(vendors, { id: 'vendors-partners', label: 'Vendors & partners', description: 'Suppliers, contracts and service levels.', builtin: false });
  assert.ok((await fsp.stat(path.join(dir, 'context', 'vendors-partners'))).isDirectory(), 'its folder is made');
  const listed = await categories.listCategories(dir);
  assert.equal(listed.length, 9);
  assert.equal(listed[8]!.id, 'vendors-partners');
  assert.match(await fsp.readFile(path.join(dir, 'context', 'categories.md'), 'utf-8'), /id: vendors-partners/);

  // Create, read, list by category (any case), move in and out.
  const note = await notes.createContextNote({ category: 'Vendors-Partners', title: 'Freight carrier terms', sensitivity: 'shareable', body: 'Dual Lane ships within 48 hours.\n' });
  assert.equal(note.category, 'vendors-partners');
  assert.equal(note.path, path.join(dir, 'context', 'vendors-partners', 'freight-carrier-terms', 'note.md'));
  assert.equal((await notes.getContextNote(note.id)).category, 'vendors-partners');
  assert.deepEqual((await notes.listContextNotes('vendors-partners')).map((n) => n.id), [note.id]);
  assert.ok((await notes.listContextNotes()).some((n) => n.id === note.id));
  await notes.updateContextNote(note.id, { category: 'company' });
  await notes.updateContextNote(note.id, { category: 'vendors-partners' });

  // Export, search and context updates see it too.
  const preview = await previewContextShare({ notes: [note.id] });
  assert.match(preview.text ?? '', /Dual Lane ships within 48 hours/);
  const search = new SearchService();
  t.after(() => search.reset());
  await search.buildIndex();
  assert.deepEqual((await search.search('Dual Lane', ['context'])).map((r) => r.id), [note.id]);
  const target = 'context/vendors-partners/freight-carrier-terms/note.md';
  assert.equal(proposalTarget(target, null, await categories.categoryIds(dir)), target);
  assert.equal(proposalTarget(target), null, 'not a category unless the workspace has it');

  // Renaming keeps the id, so the folder and the note stay where they are.
  const renamed = await categories.updateCategory(dir, 'vendors-partners', { label: 'Suppliers', description: '' });
  assert.deepEqual(renamed, { id: 'vendors-partners', label: 'Suppliers', builtin: false });
  assert.equal((await notes.getContextNote(note.id)).path, note.path);

  // A category with a note is never removed; nothing changes.
  await assert.rejects(categories.deleteCategory(dir, 'vendors-partners'), status(409));
  assert.equal((await categories.categoryIds(dir)).includes('vendors-partners'), true);
  assert.ok(await fsp.stat(note.path!));

  // Once its note is gone, it goes, and its empty folder with it.
  await notes.deleteContextNote(note.id);
  await categories.deleteCategory(dir, 'vendors-partners');
  assert.deepEqual(await categories.categoryIds(dir), [...categories.BUILTIN_CATEGORIES]);
  await assert.rejects(fsp.stat(path.join(dir, 'context', 'vendors-partners')), { code: 'ENOENT' });
  await assert.rejects(notes.createContextNote({ category: 'vendors-partners', title: 'Late note' }), status(400));
});

test('category requests are checked before anything is written', async (t) => {
  const dir = await workspace(t, 'gtd-categories-bad-');
  const categories = await import('../src/services/contextCategories');
  const registry = path.join(dir, 'context', 'categories.md');

  for (const label of ['', '   ', 'x'.repeat(41), 'Bad\u0007name', 42, null]) {
    await assert.rejects(categories.createCategory(dir, { label }), status(400), String(label));
  }
  await assert.rejects(categories.createCategory(dir, { label: 'Fine', description: 'x'.repeat(301) }), status(400));
  // Built-in, reserved and Windows device names are never a custom category.
  for (const label of ['Risks', 'GLOSSARY', 'All', 'Categories', 'con', 'LPT1']) {
    await assert.rejects(categories.createCategory(dir, { label }), status(409), label);
  }
  await assert.rejects(fsp.stat(registry), { code: 'ENOENT' }, 'no file is written for a refused request');

  // Ids from a URL are checked before a path is made from them.
  for (const id of ['../tasks', '..', 'a/b', 'Vendors', '', 'x'.repeat(41)]) {
    await assert.rejects(categories.updateCategory(dir, id, { label: 'X' }), status(400), id);
    await assert.rejects(categories.deleteCategory(dir, id), status(400), id);
  }
  await assert.rejects(categories.deleteCategory(dir, 'risks'), status(400), 'a built-in category cannot be removed');
  await assert.rejects(categories.updateCategory(dir, 'risks', { label: 'Threats' }), status(400));
  await assert.rejects(categories.deleteCategory(dir, 'nothing-here'), status(404));

  // Names are unique without case; the same name twice at once makes one category.
  await categories.createCategory(dir, { label: 'Regulators' });
  await assert.rejects(categories.createCategory(dir, { label: 'regulators' }), status(409));
  const other = await categories.createCategory(dir, { label: 'Partners' });
  await assert.rejects(categories.updateCategory(dir, other.id, { label: 'REGULATORS' }), status(409));
  const results = await Promise.allSettled([categories.createCategory(dir, { label: 'Auditors' }), categories.createCategory(dir, { label: 'Auditors' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.deepEqual((await categories.customCategories(dir)).map((c) => c.id), ['regulators', 'partners', 'auditors']);
});

test('a hand-edited categories.md is read defensively, and folders it does not list stay hidden', async (t) => {
  const dir = await workspace(t, 'gtd-categories-hand-');
  const categories = await import('../src/services/contextCategories');
  const { ContextService } = await import('../src/services/contextService');

  await fsp.writeFile(path.join(dir, 'context', 'categories.md'), [
    '---',
    'categories:',
    '  - id: vendors',
    '    label: Vendors',
    '  - id: vendors',
    '    label: Second vendors',
    '  - id: ../tasks',
    '  - id: risks',
    '    label: My risks',
    '  - id: __proto__',
    '  - id: Upper',
    '  - just text',
    '  - id: no-label',
    '---',
    'Edited by hand.',
    '',
  ].join('\n'));
  const custom = await categories.customCategories(dir);
  assert.deepEqual(custom.map((c) => [c.id, c.label]), [['vendors', 'Vendors'], ['no-label', 'no-label']]);

  // Notes in a folder that is not a category are not listed, as before.
  await fsp.mkdir(path.join(dir, 'context', 'stray', 'old-note'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'context', 'stray', 'old-note', 'note.md'), '---\nid: CTX-old-note\ntitle: Old\n---\nText\n');
  const service = new ContextService();
  assert.equal((await service.listContextNotes()).length, 0);
  await assert.rejects(service.getContextNote('CTX-old-note'));

  // Adding the category shows them: nothing was lost.
  await categories.createCategory(dir, { label: 'Stray' });
  assert.deepEqual((await service.listContextNotes()).map((n) => n.id), ['CTX-old-note']);

  // A file that cannot be read as frontmatter means no custom categories, never an error.
  await fsp.writeFile(path.join(dir, 'context', 'categories.md'), '---\ncategories: [unclosed\n---\n');
  assert.deepEqual(await categories.customCategories(dir), []);
  assert.equal((await service.listContextNotes()).length, 0);
});

test('the memory review scans notes in custom categories', async (t) => {
  const dir = await workspace(t, 'gtd-categories-review-');
  const categories = await import('../src/services/contextCategories');
  const { ContextService } = await import('../src/services/contextService');
  const { SystemCleanupService, defaultSettings } = await import('../src/services/systemCleanupService');

  await categories.createCategory(dir, { label: 'Regulators' });
  await new ContextService().createContextNote({ category: 'regulators', title: 'Port authority', body: 'Short.' });
  const scan = await new SystemCleanupService().scanMemory(defaultSettings());
  assert.equal(scan.notes, 1);
  assert.deepEqual(scan.thin.map((n) => n.path), ['context/regulators/port-authority/note.md']);
});
