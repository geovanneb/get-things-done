import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

test('global search finds words in the text of a context note, not only in its title and tags', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-search-notes-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  await fsp.mkdir(path.join(dir, 'context'), { recursive: true });

  const { ContextService } = await import('../src/services/contextService');
  const { SearchService } = await import('../src/services/searchService');
  const search = new SearchService();
  t.after(async () => {
    search.reset();
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const note = await new ContextService().createContextNote({
    category: 'decisions',
    title: 'Second freight carrier',
    body: 'Northwind Labs chose Dual Lane after the quillback pilot.\n',
  });
  await search.buildIndex();

  const hits = await search.search('quillback', ['context']);
  assert.deepEqual(hits.map((row) => row.id), [note.id]);
  assert.match(hits[0]!.excerpt, /quillback pilot/);

  // A note changed through the index keeps its text searchable as well.
  await search.indexEntity({ id: note.id, title: note.title, body: 'Now about the zephyrroute.', tags: [] }, 'context');
  assert.deepEqual((await search.search('zephyrroute')).map((row) => row.id), [note.id]);
});
