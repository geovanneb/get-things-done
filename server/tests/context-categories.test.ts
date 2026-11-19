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

/** A promise and the function that settles it: a test gate, never a timer. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

const code = (status: number, value: string) => (e: { statusCode?: number; details?: { code?: string } }) =>
  e.statusCode === status && e.details?.code === value;

test('adding a category keeps everything else written in a hand-edited categories.md', async (t) => {
  const dir = await workspace(t, 'gtd-categories-keep-');
  const categories = await import('../src/services/contextCategories');
  const registry = path.join(dir, 'context', 'categories.md');

  await categories.createCategory(dir, { label: 'Vendors' });
  // Ordinary notes written below the list, well over the old 64 KiB read limit.
  const body = 'Notes about how we file vendors and partners.\n'.repeat(1600);
  assert.ok(Buffer.byteLength(body) > 64 * 1024);
  await fsp.writeFile(registry, [
    '---',
    'owner_note: kept by hand',
    'categories:',
    '  - id: vendors',
    '    label: Vendors',
    '    colour: teal',
    '  - id: Not valid',
    '    label: Skipped but kept',
    '---',
    body,
  ].join('\n'));

  await categories.createCategory(dir, { label: 'Budgets' });
  assert.deepEqual((await categories.customCategories(dir)).map((c) => c.id), ['vendors', 'budgets']);
  const after = await fsp.readFile(registry, 'utf-8');
  assert.ok(after.includes(body.trimEnd()), 'the body text is kept');
  assert.match(after, /owner_note: kept by hand/);
  assert.match(after, /colour: teal/);
  assert.match(after, /Skipped but kept/);

  // A rename keeps the entry's own fields; a removal takes only that entry.
  await categories.updateCategory(dir, 'vendors', { label: 'Suppliers' });
  assert.match(await fsp.readFile(registry, 'utf-8'), /colour: teal/);
  await categories.deleteCategory(dir, 'budgets');
  const final = await fsp.readFile(registry, 'utf-8');
  assert.deepEqual((await categories.customCategories(dir)).map((c) => [c.id, c.label]), [['vendors', 'Suppliers']]);
  assert.ok(final.includes(body.trimEnd()));
  assert.match(final, /Skipped but kept/);
});

test('a categories.md that cannot be read completely is never rewritten', async (t) => {
  const dir = await workspace(t, 'gtd-categories-refuse-');
  const categories = await import('../src/services/contextCategories');
  const registry = path.join(dir, 'context', 'categories.md');
  const valid = '---\ncategories:\n  - id: vendors\n    label: Vendors\n---\nBody.\n';

  const cases: Array<[string, () => Promise<void>]> = [
    ['malformed frontmatter', () => fsp.writeFile(registry, '---\ncategories: [unclosed\n  - id: vendors\n---\n')],
    ['categories is not a list', () => fsp.writeFile(registry, '---\ncategories: vendors\n---\n')],
    ['categories is null', () => fsp.writeFile(registry, '---\ncategories: null\n---\nBody.\n')],
    ['frontmatter never closed', () => fsp.writeFile(registry, '---\ncategories: []\n')],
    ['a "---" line that is not a delimiter', () => fsp.writeFile(registry, '---\ncategories: []\n---x\n---\nBody.\n')],
    ['not UTF-8', () => fsp.writeFile(registry, Buffer.concat([Buffer.from(valid), Buffer.from([0xff, 0xfe, 0x00])]))],
    ['over the size limit', () => fsp.writeFile(registry, valid + 'x'.repeat(1024 * 1024))],
    ['a folder', async () => { await fsp.mkdir(registry); await fsp.writeFile(path.join(registry, 'inside.md'), valid); }],
  ];
  if (process.platform !== 'win32') {
    cases.push(['a link', async () => { await fsp.writeFile(path.join(dir, 'elsewhere.md'), valid); await fsp.symlink(path.join(dir, 'elsewhere.md'), registry); }]);
    if (process.getuid?.() !== 0) cases.push(['unreadable', async () => { await fsp.writeFile(registry, valid); await fsp.chmod(registry, 0o000); }]);
  }

  for (const [name, make] of cases) {
    await fsp.rm(registry, { recursive: true, force: true });
    await make();
    const before = await fsp.lstat(registry);
    const bytes = before.isFile() && !before.isSymbolicLink() && (before.mode & 0o400) ? await fsp.readFile(registry) : null;
    // Display stays tolerant: whatever it can read, never an error.
    await categories.customCategories(dir);
    for (const attempt of [
      () => categories.createCategory(dir, { label: 'Budgets' }),
      () => categories.updateCategory(dir, 'vendors', { label: 'Suppliers' }),
      () => categories.deleteCategory(dir, 'vendors'),
    ]) {
      await assert.rejects(attempt(), code(409, 'category_registry_unreadable'), name);
    }
    const now = await fsp.lstat(registry);
    assert.equal(now.ino, before.ino, `${name}: the file is left in place`);
    if (bytes) assert.deepEqual(await fsp.readFile(registry), bytes, `${name}: the file is unchanged`);
    if (name === 'unreadable') await fsp.chmod(registry, 0o600);
  }
  await assert.rejects(fsp.stat(path.join(dir, 'context', 'budgets')), { code: 'ENOENT' }, 'no folder is made for a refused add');

  // Only a missing file is an empty list.
  await fsp.rm(registry, { recursive: true, force: true });
  await categories.createCategory(dir, { label: 'Budgets' });
  assert.deepEqual((await categories.customCategories(dir)).map((c) => c.id), ['budgets']);
});

test('a change that would make categories.md too large to read back changes nothing', async (t) => {
  const dir = await workspace(t, 'gtd-categories-grow-');
  const categories = await import('../src/services/contextCategories');
  const registry = path.join(dir, 'context', 'categories.md');
  await categories.createCategory(dir, { label: 'Vendors' });
  const head = '---\ncategories:\n  - id: vendors\n    label: Vendors\n---\n';
  // A valid file just under the limit: one more entry would push it over.
  await fsp.writeFile(registry, head + 'x'.repeat(1024 * 1024 - 2 - Buffer.byteLength(head)) + '\n');
  assert.ok((await fsp.stat(registry)).size < 1024 * 1024);
  const bytes = await fsp.readFile(registry);
  const listed = await categories.customCategories(dir);
  assert.deepEqual(listed.map((c) => c.id), ['vendors']);

  await assert.rejects(categories.createCategory(dir, { label: 'Budgets' }), code(409, 'category_registry_unreadable'));
  assert.deepEqual(await fsp.readFile(registry), bytes);
  assert.deepEqual(await categories.customCategories(dir), listed);
  await assert.rejects(fsp.stat(path.join(dir, 'context', 'budgets')), { code: 'ENOENT' }, 'no folder is made');
});

test('the body of categories.md is kept byte for byte', async (t) => {
  const dir = await workspace(t, 'gtd-categories-blank-');
  const categories = await import('../src/services/contextCategories');
  const registry = path.join(dir, 'context', 'categories.md');
  const head = '---\ncategories:\n  - id: vendors\n    label: Vendors\n---\n';
  // Whitespace-only and indented bodies after an ordinary closing line.
  for (const body of ['', '   ', '   \n', 'Text', 'Text\n', '\nText\n\n', 'Line one\r\nLine two\r\n', '  \nA body starting with a blank line of spaces']) {
    await fsp.writeFile(registry, head + body);
    await categories.createCategory(dir, { label: 'Budgets' });
    const after = await fsp.readFile(registry, 'utf-8');
    assert.ok(after.endsWith('\n---\n' + body), JSON.stringify(body));
    assert.doesNotMatch(after, /# Context categories/, 'the explanation is written only into a new file');
    assert.deepEqual((await categories.customCategories(dir)).map((c) => c.id), ['vendors', 'budgets']);
    await categories.deleteCategory(dir, 'budgets');
    assert.ok((await fsp.readFile(registry, 'utf-8')).endsWith('\n---\n' + body), JSON.stringify(body));
  }
  // A closing line padded with spaces: the body is what follows that whole line, nothing of the padding.
  for (const closing of ['---  \n', '---\t \r\n']) {
    await fsp.writeFile(registry, '---\ncategories:\n  - id: vendors\n    label: Vendors\n' + closing + 'Text');
    await categories.createCategory(dir, { label: 'Budgets' });
    assert.ok((await fsp.readFile(registry, 'utf-8')).endsWith('\n---\nText'), JSON.stringify(closing));
    await categories.deleteCategory(dir, 'budgets');
  }
  // A file with no frontmatter keeps all of its text below the new list.
  await fsp.writeFile(registry, 'Only notes, no list yet');
  await categories.createCategory(dir, { label: 'Budgets' });
  assert.ok((await fsp.readFile(registry, 'utf-8')).endsWith('\n---\nOnly notes, no list yet'));
});

test('every distinct category id stays listed, whatever its label', async (t) => {
  const dir = await workspace(t, 'gtd-categories-labels-');
  const categories = await import('../src/services/contextCategories');
  const { ContextService } = await import('../src/services/contextService');
  const registry = path.join(dir, 'context', 'categories.md');
  await fsp.writeFile(registry, [
    '---',
    'categories:',
    '  - id: first',
    '    label: Vendors',
    '  - id: vendors',
    '    label: Company',
    '  - id: second',
    '    label: vendors',
    '  - id: other',
    '    label: Vendors (vendors)',
    '---',
    '',
  ].join('\n'));
  const listed = await categories.customCategories(dir);
  // Labels listed before keep them; a built-in's label falls back to the id, and when that is taken to "label (id)".
  assert.deepEqual(listed.map((c) => [c.id, c.label]), [
    ['first', 'Vendors'],
    ['vendors', 'Company (vendors)'],
    ['second', 'second'],
    ['other', 'Vendors (vendors)'],
  ]);
  assert.equal(new Set(listed.map((c) => c.label.toLowerCase())).size, listed.length, 'labels stay unique');

  // The notes in a category whose label and id are both taken as names are still found.
  await fsp.mkdir(path.join(dir, 'context', 'vendors', 'carrier-terms'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'context', 'vendors', 'carrier-terms', 'note.md'), '---\nid: CTX-carrier-terms\ntitle: Carrier terms\n---\nText.\n');
  const service = new ContextService();
  assert.deepEqual((await service.listContextNotes()).map((n) => n.id), ['CTX-carrier-terms']);
  assert.equal((await service.getContextNote('CTX-carrier-terms')).category, 'vendors');
});

test('a rename never hides another category at the cap', async (t) => {
  const dir = await workspace(t, 'gtd-categories-cap-rename-');
  const categories = await import('../src/services/contextCategories');
  const { ContextService } = await import('../src/services/contextService');
  const registry = path.join(dir, 'context', 'categories.md');
  // c00 and "repeat" share a label, so "repeat" is not listed; c01 to c29 fill the cap of 30.
  const lines = ['---', 'categories:', '  - id: c00', '    label: Shared', '  - id: repeat', '    label: Shared'];
  for (let i = 1; i < 30; i++) lines.push(`  - id: c${String(i).padStart(2, '0')}`, `    label: Category ${i}`);
  lines.push('---', '');
  await fsp.writeFile(registry, lines.join('\n'));
  const notes = new ContextService();
  const note = await notes.createContextNote({ category: 'c29', title: 'Last category note' });
  const bytes = await fsp.readFile(registry);

  // Renaming c00 would let "repeat" in and push c29 (and its note) out: refused, nothing changes.
  await assert.rejects(categories.updateCategory(dir, 'c00', { label: 'New name' }), code(409, 'category_would_hide'));
  assert.deepEqual(await fsp.readFile(registry), bytes);
  assert.ok((await categories.customCategories(dir)).some((c) => c.id === 'c29'));
  assert.deepEqual((await notes.listContextNotes()).map((n) => n.id), [note.id]);
  assert.equal((await notes.getContextNote(note.id)).category, 'c29');

  // A rename that hides nothing still works, and removing a category may let the skipped one in.
  await categories.updateCategory(dir, 'c01', { label: 'Renamed one' });
  await notes.deleteContextNote(note.id);
  await categories.deleteCategory(dir, 'c29');
  assert.ok((await categories.customCategories(dir)).some((c) => c.id === 'repeat'));
});

test('the category cap never pushes out a category listed before', async (t) => {
  const dir = await workspace(t, 'gtd-categories-cap-');
  const categories = await import('../src/services/contextCategories');
  // An early entry earlier versions skipped (its label repeats the first one's), then 30 they listed.
  const lines = ['---', 'categories:', '  - id: c00', '    label: Shared', '  - id: repeat', '    label: Shared'];
  for (let i = 1; i < 30; i++) lines.push(`  - id: c${String(i).padStart(2, '0')}`, `    label: Category ${i}`);
  lines.push('---', '');
  await fsp.writeFile(path.join(dir, 'context', 'categories.md'), lines.join('\n'));
  const ids = (await categories.customCategories(dir)).map((c) => c.id);
  assert.equal(ids.length, 30);
  assert.deepEqual(ids, Array.from({ length: 30 }, (_, i) => `c${String(i).padStart(2, '0')}`));
});

test('a note whose hand-written id looks like a workspace lock still moves into a custom category', async (t) => {
  const dir = await workspace(t, 'gtd-categories-lockname-');
  const categories = await import('../src/services/contextCategories');
  const { ContextService } = await import('../src/services/contextService');
  await categories.createCategory(dir, { label: 'Vendors' });
  await fsp.mkdir(path.join(dir, 'context', 'company', 'odd-note'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'context', 'company', 'odd-note', 'note.md'), '---\nid: _categories\ntitle: Odd\n---\nText.\n');
  const moved = await new ContextService().updateContextNote('_categories', { category: 'vendors' });
  assert.equal(moved.category, 'vendors');
  assert.equal((await new ContextService().getContextNote('_categories')).category, 'vendors');
});

test('a hand-edited category never takes the name of a built-in one', async (t) => {
  const dir = await workspace(t, 'gtd-categories-builtin-label-');
  const categories = await import('../src/services/contextCategories');
  await fsp.writeFile(path.join(dir, 'context', 'categories.md'), [
    '---',
    'categories:',
    '  - id: dangers',
    '    label: risks',
    '  - id: company-two',
    '    label: COMPANY',
    '  - id: vendors',
    '    label: Vendors',
    '---',
    '',
  ].join('\n'));
  // It is shown by its id instead, so its notes stay listed.
  assert.deepEqual((await categories.customCategories(dir)).map((c) => [c.id, c.label]), [['dangers', 'dangers'], ['company-two', 'company-two'], ['vendors', 'Vendors']]);
  await assert.rejects(categories.updateCategory(dir, 'vendors', { label: 'Glossary' }), status(409));
});

test('a note saved into a category while it is removed is never hidden', async (t) => {
  const dir = await workspace(t, 'gtd-categories-race-');
  const categories = await import('../src/services/contextCategories');
  const { ContextService, contextSaveHooks } = await import('../src/services/contextService');
  t.after(() => { delete contextSaveHooks.pause; });
  const notes = new ContextService();
  const exists = (p: string) => fsp.stat(p).then(() => true, () => false);

  // 1. The category is removed after the request was checked, before the save: the save is refused, nothing is written.
  await categories.createCategory(dir, { label: 'Vendors' });
  let checked = gate();
  let release = gate();
  contextSaveHooks.pause = async (phase) => { if (phase === 'checked') { checked.open(); await release.wait; } };
  const creating = notes.createContextNote({ category: 'vendors', title: 'Agenda' });
  await checked.wait;
  await categories.deleteCategory(dir, 'vendors');
  release.open();
  await assert.rejects(creating, code(400, 'category_gone'));
  assert.equal(await exists(path.join(dir, 'context', 'vendors', 'agenda')), false);
  assert.deepEqual((await notes.listContextNotes()).map((n) => n.id), []);

  // 2. The removal starts while the save holds the category: it waits, then finds the note and refuses.
  await categories.createCategory(dir, { label: 'Vendors' });
  const held = gate();
  release = gate();
  contextSaveHooks.pause = async (phase) => { if (phase === 'held') { held.open(); await release.wait; } };
  const saving = notes.createContextNote({ category: 'vendors', title: 'Agenda' });
  await held.wait;
  const removing = categories.deleteCategory(dir, 'vendors');
  release.open();
  const note = await saving;
  await assert.rejects(removing, status(409));
  assert.deepEqual((await notes.listContextNotes()).map((n) => n.id), [note.id]);
  assert.equal((await notes.getContextNote(note.id)).category, 'vendors');

  // 3. A move into a category removed after the request was checked is refused; the note stays where it was.
  const other = await notes.createContextNote({ category: 'company', title: 'Freight terms' });
  await categories.createCategory(dir, { label: 'Partners' });
  checked = gate();
  release = gate();
  contextSaveHooks.pause = async (phase, category) => { if (phase === 'checked' && category === 'partners') { checked.open(); await release.wait; } };
  const moving = notes.updateContextNote(other.id, { category: 'partners' });
  await checked.wait;
  await categories.deleteCategory(dir, 'partners');
  release.open();
  await assert.rejects(moving, code(400, 'category_gone'));
  assert.equal((await notes.getContextNote(other.id)).category, 'company');
  assert.equal(await exists(path.join(dir, 'context', 'partners')), false);
});

test('removing a category whose folder cannot be read reports it and keeps the category', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const dir = await workspace(t, 'gtd-categories-scan-');
  const categories = await import('../src/services/contextCategories');
  const { ContextService } = await import('../src/services/contextService');
  await categories.createCategory(dir, { label: 'Vendors' });
  await new ContextService().createContextNote({ category: 'vendors', title: 'Carrier terms' });
  const folder = path.join(dir, 'context', 'vendors');
  await fsp.chmod(folder, 0o000);
  t.after(() => fsp.chmod(folder, 0o700).catch(() => {}));

  await assert.rejects(categories.deleteCategory(dir, 'vendors'), code(409, 'category_scan_failed'));
  await fsp.chmod(folder, 0o700);
  assert.deepEqual((await categories.customCategories(dir)).map((c) => c.id), ['vendors']);
  assert.equal((await new ContextService().listContextNotes()).length, 1);
});
