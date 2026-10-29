import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// node:sqlite is built into Node 22.13+ (and into the desktop app's Node). Older versions use the in-memory scan.
const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
const hasBuiltInSqlite = major > 22 || (major === 22 && minor >= 13);

test('the search index is a SQLite file built with node:sqlite, with prefix search and type filters', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-search-'));
  const previous = process.env.ESB_WORKSPACE_PATH;
  process.env.ESB_WORKSPACE_PATH = dir;
  await fsp.mkdir(path.join(dir, 'tasks', 'active'), { recursive: true });

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
  const carrier = await tasks.createTask({ title: 'Decision brief: second freight carrier', body: 'Compare Dual Lane and Northwind Freight.' });
  const quote = await tasks.createTask({ title: 'Ask for a "quoted" rate', body: 'Carrier pricing for Q4.' });
  await search.buildIndex();

  const dbFile = path.join(dir, '.situation-board', 'cache', 'search.db');
  assert.equal(fs.existsSync(dbFile), hasBuiltInSqlite, `index file on Node ${process.versions.node}`);

  // A word prefix finds both tasks; the type filter keeps only tasks.
  const prefix = await search.search('carri');
  assert.deepEqual(prefix.map((row) => row.id).sort(), [carrier.id, quote.id].sort());
  assert.deepEqual(await search.search('carri', ['stakeholder']), []);
  assert.equal((await search.search('carri', ['task'])).length, 2);

  // Quotes in a query are not FTS syntax errors.
  assert.deepEqual((await search.search('"quoted')).map((row) => row.id), [quote.id]);

  // Rebuilding replaces the index instead of adding duplicates.
  await search.buildIndex();
  assert.equal((await search.search('freight')).length, 1);

  // Updates and removals reach the index.
  await search.indexEntity({ id: carrier.id, title: 'Decision brief: second freight carrier', description: 'Now about zephyrlogistics.' }, 'task');
  assert.deepEqual((await search.search('zephyrlogistics')).map((row) => row.id), [carrier.id]);
  await search.invalidateEntity(carrier.id);
  assert.deepEqual(await search.search('zephyrlogistics'), []);
});
