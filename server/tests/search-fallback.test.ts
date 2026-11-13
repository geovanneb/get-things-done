import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Its own file: once the index cannot be opened, search stays on the in-memory scan for the rest of the process.
test('the in-memory fallback splits only a Japanese query into words; any other query stays one substring', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-search-fallback-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  await fsp.mkdir(path.join(dir, 'tasks', 'active'), { recursive: true });
  // A file where the cache folder should be: the index cannot be created, so search falls back.
  await fsp.mkdir(path.join(dir, '.situation-board'), { recursive: true });
  await fsp.writeFile(path.join(dir, '.situation-board', 'cache'), '');

  const { TaskService } = await import('../src/services/taskService');
  const { SearchService } = await import('../src/services/searchService');
  const search = new SearchService();
  t.after(async () => {
    search.reset();
    if (previous === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const tasks = new TaskService();
  const meeting = await tasks.createTask({ title: 'ノースウィンド 経営会議の準備', body: '定例。' });
  const minutes = await tasks.createTask({ title: 'Weekly prep', body: 'Northwind Freight\n経営会議の議事録をまとめる。' });
  await search.buildIndex();
  assert.equal(fs.existsSync(path.join(dir, '.situation-board', 'cache', 'search.db')), false, 'the fallback, not the SQLite index');
  const ids = async (q: string) => (await search.search(q)).map((row) => row.id);

  // English: the whole query as one substring, as before.
  assert.deepEqual(await ids('weekly prep'), [minutes.id]);
  assert.deepEqual(await ids('northwind freight'), [minutes.id]);
  assert.deepEqual(await ids('prep weekly'), [], 'words in another order are not one substring');
  assert.deepEqual(await ids('northwind 　freight'), [], 'nor are words with other spaces between them');

  // Japanese: every word, in any order.
  assert.deepEqual(await ids('経営　ノースウィンド'), [meeting.id]);
  assert.deepEqual(await ids('northwind 議事録'), [minutes.id]);
});
