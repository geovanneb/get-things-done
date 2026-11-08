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
