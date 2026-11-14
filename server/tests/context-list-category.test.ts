import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ContextService } from '../src/services/contextService';

test('listing by a category outside the eight is refused and never makes a folder; a known one in another case lists it', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-context-list-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await fsp.mkdir(path.join(dir, 'context'), { recursive: true });
  const service = new ContextService();
  await service.createContextNote({ title: 'Fictional supplier map', category: 'company', content: 'Three suppliers.' } as never);

  await assert.rejects(service.listContextNotes('Finance'), (e: { statusCode?: number }) => e.statusCode === 400);
  await assert.rejects(service.listContextNotes(['company', 'risks']), (e: { statusCode?: number }) => e.statusCode === 400, 'a repeated query parameter is not a category');
  const folders = await fsp.readdir(path.join(dir, 'context'));
  assert.ok(!folders.some((f) => f.toLowerCase() === 'finance'), `no folder made: ${folders.join(', ')}`);

  const listed = await service.listContextNotes('Company');
  assert.deepEqual(listed.map((n) => [n.title, n.category]), [['Fictional supplier map', 'company']], 'the category comes back as stored');
  assert.equal((await service.listContextNotes()).length, 1);
  assert.equal((await service.listContextNotes('')).length, 1, 'an empty filter lists everything, as before');
});
