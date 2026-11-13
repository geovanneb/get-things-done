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

test('the SQLite index finds a Japanese word inside a title or text, as the in-memory scan does', { skip: !hasBuiltInSqlite && 'needs node:sqlite (Node 22.13+)' }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-search-ja-'));
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
  const strategy = await tasks.createTask({ title: 'ノースウィンド社の経営戦略', body: '毎週の定例会議の議事録をまとめる。' });
  const carrier = await tasks.createTask({ title: 'Decision brief: second freight carrier', body: 'Compare Dual Lane and Northwind Freight.' });
  await search.buildIndex();
  assert.ok(fs.existsSync(path.join(dir, '.situation-board', 'cache', 'search.db')), 'the SQLite path, not the fallback');

  // Inside a run of text (the index splits words only on spaces), in the title and in the body, one or more characters.
  for (const q of ['経営戦略', '会議', '議事録', 'ノースウィンド', '毎週', '週']) {
    assert.deepEqual((await search.search(q)).map((row) => row.id), [strategy.id], q);
  }
  const hit = (await search.search('経営戦略'))[0]!;
  assert.ok(hit.relevance > (await search.search('議事録'))[0]!.relevance, 'a title hit outranks a body hit');
  assert.deepEqual(await search.search('会議', ['stakeholder']), [], 'the type filter still applies');
  assert.deepEqual((await search.search('会議', ['task', 'context'])).map((row) => row.id), [strategy.id]);
  assert.deepEqual((await search.search('会議', [])).map((row) => row.id), [strategy.id], 'an empty type filter searches all types');
  assert.deepEqual(await search.search('会議', ["task') OR 1=1 --"]), [], 'type filters remain bound values');
  assert.match((await search.search('議事録'))[0]!.excerpt, /議事録/);

  // English still goes through the word index, by word prefix.
  assert.deepEqual((await search.search('northw')).map((row) => row.id), [carrier.id]);
  assert.deepEqual((await search.search('dual lane')).map((row) => row.id), [carrier.id]);
});

test('a Japanese query of several words finds each word, whatever space separates them', { skip: !hasBuiltInSqlite && 'needs node:sqlite (Node 22.13+)' }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-search-words-'));
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
  const meeting = await tasks.createTask({ title: 'ノースウィンド 経営会議の準備', body: '定例。' });
  const minutes = await tasks.createTask({ title: 'Weekly prep', body: 'Northwind\n経営会議の議事録をまとめる。' });
  const pack = await tasks.createTask({ title: 'Aa board pack', body: 'ノースウィンドの経営資料。' });
  await search.buildIndex();
  const ids = async (q: string) => (await search.search(q)).map((row) => row.id);

  // U+3000 is what a Japanese IME types between words; the words of the last query sit on two lines of the body.
  assert.deepEqual(await ids('ノースウィンド　経営'), [meeting.id, pack.id], 'ideographic space, all words in the title first');
  assert.deepEqual(await ids('ノースウィンド  経営'), [meeting.id, pack.id], 'two spaces');
  assert.deepEqual(await ids('northwind 経営'), [minutes.id], 'words on different lines of the body');
  assert.deepEqual(await ids(' 経営　ノースウィンド '), [meeting.id, pack.id], 'any order, outer spaces ignored');
  assert.deepEqual(await ids('ノースウィンド 予算'), [], 'every word must appear');
  assert.deepEqual(await ids('議事録 議事録'), [minutes.id], 'a repeated word counts once');
  assert.deepEqual(await search.search('northwind 経営', ['stakeholder']), [], 'the type filter still applies');
  assert.match((await search.search('northwind 議事録'))[0]!.excerpt, /議事録/, 'the excerpt shows a word of the query');

  // One word and English behave as before.
  assert.deepEqual(await ids('議事録'), [minutes.id]);
  assert.deepEqual(await ids('経営会議'), [meeting.id, minutes.id]);
  assert.deepEqual(await ids('weekly prep'), [minutes.id]);
});
