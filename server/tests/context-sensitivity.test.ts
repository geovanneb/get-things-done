import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

test('context notes keep a whole-note sensitivity label; none counts as internal; unknown labels are refused', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-sensitivity-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  await fsp.mkdir(path.join(dir, 'context'), { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const { ContextService, effectiveSensitivity } = await import('../src/services/contextService');
  const service = new ContextService();

  // No label: nothing written, counts as internal.
  const plain = await service.createContextNote({ category: 'company', title: 'Plain note', body: 'x\n' });
  assert.equal(plain.sensitivity, undefined);
  assert.doesNotMatch(await fsp.readFile(plain.path!, 'utf-8'), /sensitivity/);
  assert.equal(effectiveSensitivity(plain.sensitivity), 'internal');

  // A label is saved on create and kept by an edit that does not mention it.
  const shared = await service.createContextNote({ category: 'company', title: 'Public facts', sensitivity: 'shareable', body: 'y\n' });
  assert.match(await fsp.readFile(shared.path!, 'utf-8'), /sensitivity: shareable/);
  const edited = await service.updateContextNote(shared.id, { title: 'Public facts', body: 'z\n' });
  assert.equal(edited.sensitivity, 'shareable');

  // Changed, then removed (null or '').
  assert.equal((await service.updateContextNote(shared.id, { sensitivity: 'personal' })).sensitivity, 'personal');
  const cleared = await service.updateContextNote(shared.id, { sensitivity: '' });
  assert.equal(cleared.sensitivity, undefined);
  assert.doesNotMatch(await fsp.readFile(cleared.path!, 'utf-8'), /sensitivity/);

  // Unknown labels are refused with 400 and change nothing.
  await assert.rejects(service.createContextNote({ category: 'company', title: 'Bad', sensitivity: 'public' }), (e: { statusCode?: number }) => e.statusCode === 400);
  assert.equal(await fsp.readdir(path.join(dir, 'context', 'company')).then((n) => n.includes('bad')), false);
  await assert.rejects(service.updateContextNote(shared.id, { sensitivity: 'Shareable' }), (e: { statusCode?: number }) => e.statusCode === 400);
  assert.equal((await service.getContextNote(shared.id)).sensitivity, undefined);

  // A label edited by hand into something unknown is reported as invalid, never shareable, and an unrelated edit keeps it visible.
  const file = plain.path!;
  await fsp.writeFile(file, (await fsp.readFile(file, 'utf-8')).replace('category: company', 'category: company\nsensitivity: Public'));
  const read = await service.getContextNote(plain.id);
  assert.equal(effectiveSensitivity(read.sensitivity), 'invalid');
  assert.equal((await service.updateContextNote(plain.id, { body: 'still\n' })).sensitivity, 'Public');

  // Non-string labels are refused too.
  for (const bad of [false, 1, ['shareable']]) {
    await assert.rejects(service.updateContextNote(plain.id, { sensitivity: bad as unknown as string }), (e: { statusCode?: number }) => e.statusCode === 400);
  }

  // An empty label in the file means none, and is never written back as `null`.
  await fsp.writeFile(file, (await fsp.readFile(file, 'utf-8')).replace('sensitivity: Public', 'sensitivity:'));
  assert.equal(effectiveSensitivity((await service.getContextNote(plain.id)).sensitivity), 'internal');
  assert.equal(effectiveSensitivity(''), 'internal');
  await service.updateContextNote(plain.id, { body: 'again\n' });
  assert.doesNotMatch(await fsp.readFile(file, 'utf-8'), /sensitivity/);

  // Moving a note to another category keeps its label.
  const personal = await service.createContextNote({ category: 'risks', title: 'Private view', sensitivity: 'personal' });
  const moved = await service.updateContextNote(personal.id, { category: 'strategy' });
  assert.match(moved.path!, /strategy/);
  assert.match(await fsp.readFile(moved.path!, 'utf-8'), /sensitivity: personal/);

  // Creating a note with the title of an existing one is refused, so it never replaces it (or drops its label).
  await assert.rejects(service.createContextNote({ category: 'strategy', title: 'Private view', body: 'other\n' }), (e: { statusCode?: number }) => e.statusCode === 409);
  assert.match(await fsp.readFile(moved.path!, 'utf-8'), /sensitivity: personal/);
});
