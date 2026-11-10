import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

test('a note with the same title in another category is refused, so one id never reaches two notes', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-same-id-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  await fsp.mkdir(path.join(dir, 'context'), { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const { ContextService } = await import('../src/services/contextService');
  const service = new ContextService();
  const conflict = (e: { statusCode?: number }) => e.statusCode === 409;

  const strategy = await service.createContextNote({ category: 'strategy', title: 'Budget', sensitivity: 'personal', body: 'PERSONAL NOTE\n' });
  await assert.rejects(service.createContextNote({ category: 'risks', title: 'Budget', body: 'Risk text\n' }), conflict);
  assert.equal(await fsp.readdir(path.join(dir, 'context', 'risks')).then((n) => n.length).catch(() => 0), 0, 'nothing is created');
  assert.match(await fsp.readFile(strategy.path!, 'utf-8'), /PERSONAL NOTE/);

  // Concurrent creates must make the same decision as sequential ones.
  for (const categories of [['strategy', 'risks'], ['strategy', 'strategy']] as const) {
    const title = `Concurrent ${categories.join(' ')}`;
    const results = await Promise.allSettled(categories.map((category) => new ContextService().createContextNote({ category, title, body: category })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.statusCode, 409);
  }

  // A move never lands on another note's folder.
  const other = await service.createContextNote({ category: 'risks', title: 'Budget risks', body: 'x\n' });
  await fsp.mkdir(path.join(dir, 'context', 'strategy', 'budget-risks'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'context', 'strategy', 'budget-risks', 'note.md'), '---\nid: CTX-budget-risks-old\n---\nOlder note\n');
  await assert.rejects(service.updateContextNote(other.id, { category: 'strategy' }), conflict);
  assert.match(await fsp.readFile(path.join(dir, 'context', 'strategy', 'budget-risks', 'note.md'), 'utf-8'), /Older note/);
  assert.match(await fsp.readFile(other.path!, 'utf-8'), /x/);
});

test('changing a note category moves its whole folder, subfolders included', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-move-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  await fsp.mkdir(path.join(dir, 'context'), { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const { ContextService } = await import('../src/services/contextService');
  const service = new ContextService();

  const note = await service.createContextNote({ category: 'company', title: 'Supplier pricing', body: 'Notes.\n' });
  const oldDir = path.dirname(note.path!);
  await fsp.mkdir(path.join(oldDir, 'sources'));
  await fsp.writeFile(path.join(oldDir, 'sources', 'price-list.csv'), 'item,price\nwidget,10\n');
  await fsp.writeFile(path.join(oldDir, 'summary.txt'), 'top-level file');

  const moved = await service.updateContextNote(note.id, { category: 'strategy' });
  const newDir = path.join(dir, 'context', 'strategy', 'supplier-pricing');
  assert.equal(moved.path, path.join(newDir, 'note.md'));
  assert.equal(await fsp.readFile(path.join(newDir, 'sources', 'price-list.csv'), 'utf-8'), 'item,price\nwidget,10\n');
  assert.equal(await fsp.readFile(path.join(newDir, 'summary.txt'), 'utf-8'), 'top-level file');
  assert.match(await fsp.readFile(moved.path!, 'utf-8'), /Notes\./);
  assert.equal(await fsp.access(oldDir).then(() => true, () => false), false, 'the old folder is gone');
  assert.deepEqual((await service.listContextFiles(note.id)).map((f) => f.name).sort(), ['sources/price-list.csv', 'summary.txt']);
});

test('a title without ASCII letters gets its own ASCII id, and ASCII titles keep their slug', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-ja-title-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  await fsp.mkdir(path.join(dir, 'context'), { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const { ContextService } = await import('../src/services/contextService');
  const service = new ContextService();

  const overview = await service.createContextNote({ category: 'company', title: 'ノースウィンド社の概要', body: '概要\n' });
  assert.match(overview.id, /^CTX-note-[0-9a-f]{8}$/);
  assert.equal((await service.getContextNote(overview.id)).title, 'ノースウィンド社の概要', 'the title is kept as written');

  // Both titles reduce to "2026" in ASCII, but they are different notes.
  const strategy = await service.createContextNote({ category: 'strategy', title: 'ノースウィンド 2026', body: '戦略\n' });
  const hiring = await service.createContextNote({ category: 'organization', title: '採用計画 2026', body: '採用\n' });
  assert.match(strategy.id, /^CTX-note-2026-[0-9a-f]{8}$/);
  assert.match(hiring.id, /^CTX-note-2026-[0-9a-f]{8}$/);
  assert.notEqual(strategy.id, hiring.id);
  // The same title twice is still the same note.
  await assert.rejects(service.createContextNote({ category: 'risks', title: '採用計画 2026' }), (e: { statusCode?: number }) => e.statusCode === 409);

  assert.equal((await service.createContextNote({ category: 'strategy', title: 'Plan 2026' })).id, 'CTX-plan-2026');
  assert.equal((await service.createContextNote({ category: 'strategy', title: '2027' })).id, 'CTX-2027');
});

test('a category outside the eight is refused, so no note is written where it can never be read again', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-category-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  await fsp.mkdir(path.join(dir, 'context'), { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const { ContextService } = await import('../src/services/contextService');
  const service = new ContextService();
  const refused = (e: { statusCode?: number; message: string }) => e.statusCode === 400 && /category must be one of company, organization/.test(e.message);

  for (const category of ['Finance', 'situation/../finance', ' strategy', 7, ['strategy']] as unknown as string[]) {
    await assert.rejects(service.createContextNote({ category, title: 'Vendor pricing 2027', body: 'Quotes.\n' }), refused);
  }
  assert.deepEqual(await fsp.readdir(path.join(dir, 'context')), [], 'no folder is made');

  // Case still does not matter, and no category still means situation.
  assert.equal((await service.createContextNote({ category: 'Strategy', title: 'Hiring plan', body: 'Five roles.\n' })).category, 'strategy');
  assert.equal((await service.createContextNote({ title: 'Open questions', body: 'x\n' })).category, 'situation');

  await assert.rejects(service.updateContextNote('CTX-hiring-plan', { category: 'Strategic' }), refused);
  const note = await service.getContextNote('CTX-hiring-plan');
  assert.equal(note.category, 'strategy');
  assert.equal((await service.updateContextNote('CTX-hiring-plan', { category: 'RISKS' })).category, 'risks');
  assert.equal((await service.getContextNote('CTX-hiring-plan')).category, 'risks');
  await service.deleteContextNote('CTX-hiring-plan');
});
