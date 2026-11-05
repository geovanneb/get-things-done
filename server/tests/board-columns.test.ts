import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AddressInfo } from 'node:net';
import express from 'express';
import { parseMarkdown } from '../src/utils/markdown';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-board-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-board-ws-'));
fs.writeFileSync(path.join(workspace, 'workspace.yaml'), 'name: "Northwind Labs"\n');
fs.mkdirSync(path.join(workspace, '.situation-board'));
fs.mkdirSync(path.join(workspace, 'tasks', 'active'), { recursive: true });
const prefsFile = path.join(workspace, '.situation-board', 'ui-preferences.json');
process.env['ESB_WORKSPACE_PATH'] = workspace;

const DEFAULT = {
  columns: [
    { id: 'backlog', label: 'Backlog', status: 'backlog' },
    { id: 'in_progress', label: 'In Progress', status: 'in_progress' },
    { id: 'needs_review', label: 'Needs Review', status: 'in_review' },
    { id: 'done', label: 'Done', status: 'done' },
  ],
};

async function server(t: { after: (fn: () => void) => void }) {
  const { default: workspaceRouter } = await import('../src/routes/workspace');
  const { default: tasksRouter } = await import('../src/routes/tasks');
  const { errorHandler } = await import('../src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/workspace', workspaceRouter);
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/api`;
  const send = (method: string, url: string, body?: unknown) => fetch(`${base}${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { base, send };
}

test('board columns are saved in the workspace, checked, and keep the other preferences', async (t) => {
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(prefsFile, JSON.stringify({ theme: 'system', default_view: 'situation' }));
  const { base, send } = await server(t);
  const board = `${base}/workspace/board`;

  assert.deepEqual(await (await fetch(board)).json(), DEFAULT, 'no saved columns means the default board');

  const custom = {
    columns: [
      { id: 'backlog', label: 'Inbox', status: 'backlog' },
      { id: 'col-waiting', label: 'Waiting on others', status: 'in_progress' },
      { id: 'in_progress', label: 'In Progress', status: 'in_progress' },
      { id: 'col-blocked', label: 'Blocked', status: 'blocked' },
      { id: 'needs_review', label: 'Needs Review', status: 'in_review' },
    ],
  };
  const saved = await send('PUT', '/workspace/board', custom);
  assert.equal(saved.status, 200);
  assert.deepEqual(await (await fetch(board)).json(), custom);
  const file = JSON.parse(fs.readFileSync(prefsFile, 'utf-8'));
  assert.equal(file.theme, 'system', 'other keys stay');
  assert.deepEqual(file.board, custom);

  // Names are trimmed and only the known keys are kept.
  const tidy = await (await send('PUT', '/workspace/board', {
    columns: [{ id: 'backlog', label: '  Inbox  ', status: 'backlog', color: 'red' }],
  })).json();
  assert.deepEqual(tidy, { columns: [{ id: 'backlog', label: 'Inbox', status: 'backlog' }] });

  // The sidebar and the board share the file: saves of both at the same moment both land.
  await Promise.all([
    send('PUT', '/workspace/sidebar', { order: {}, hidden: ['routines'] }),
    send('PUT', '/workspace/board', custom),
  ]);
  const both = JSON.parse(fs.readFileSync(prefsFile, 'utf-8'));
  assert.deepEqual(both.sidebar, { order: {}, hidden: ['routines'] });
  assert.deepEqual(both.board, custom);

  // Request values are checked at runtime, and a rejected save leaves the file alone.
  const column = { id: 'backlog', label: 'Backlog', status: 'backlog' };
  const before = fs.readFileSync(prefsFile, 'utf-8');
  for (const bad of [
    [], 'board', {}, { columns: [] }, { columns: 'backlog' }, { columns: [null] },
    { columns: [{ ...column, id: 'Backlog' }] }, { columns: [{ ...column, id: '../x' }] },
    { columns: [{ ...column, label: '   ' }] }, { columns: [{ ...column, label: 'x'.repeat(41) }] },
    { columns: [{ ...column, label: 'Two\nlines' }] }, { columns: [{ ...column, status: 'archived' }] },
    { columns: [{ ...column, status: 'someday' }] }, { columns: [column, column] },
    { columns: [column, { ...column, id: 'other', label: 'BACKLOG' }] },
    { columns: Array.from({ length: 13 }, (_, i) => ({ id: `col-${i}`, label: `Column ${i}`, status: 'backlog' })) },
  ]) {
    assert.equal((await send('PUT', '/workspace/board', bad)).status, 400, `rejects ${JSON.stringify(bad).slice(0, 60)}`);
  }
  assert.equal(fs.readFileSync(prefsFile, 'utf-8'), before);

  // Reset removes the saved columns, so a later default applies; the other keys stay.
  const reset = await send('DELETE', '/workspace/board');
  assert.deepEqual(await reset.json(), DEFAULT);
  const afterReset = JSON.parse(fs.readFileSync(prefsFile, 'utf-8'));
  assert.equal('board' in afterReset, false);
  assert.deepEqual(afterReset.sidebar, { order: {}, hidden: ['routines'] });

  // A broken file or a hand-edited invalid value shows the default board, and the next save repairs it.
  fs.writeFileSync(prefsFile, '{ "board": ');
  assert.deepEqual(await (await fetch(board)).json(), DEFAULT);
  fs.writeFileSync(prefsFile, JSON.stringify({ board: { columns: [{ id: 'x', label: '', status: 'backlog' }] } }));
  assert.deepEqual(await (await fetch(board)).json(), DEFAULT);
  assert.equal((await send('PUT', '/workspace/board', custom)).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(prefsFile, 'utf-8')).board, custom);

  // A symlinked .situation-board would write outside the workspace: refused, and the target stays untouched.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-board-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(path.join(workspace, '.situation-board'), { recursive: true });
  fs.symlinkSync(outside, path.join(workspace, '.situation-board'), 'dir');
  assert.equal((await send('PUT', '/workspace/board', custom)).status, 400);
  assert.equal((await send('DELETE', '/workspace/board')).status, 400);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(workspace, '.situation-board'));

  // A task remembers the column it was dropped in; only a well-formed column id is written.
  const taskDirs = () => fs.readdirSync(path.join(workspace, 'tasks', 'active')).sort();
  const badCreate = await send('POST', '/tasks', { title: 'Supplier review', status: 'in_progress', board_column: '../x' });
  assert.equal(badCreate.status, 400);
  assert.deepEqual(taskDirs(), [], 'a refused task is not created');

  const created = await (await send('POST', '/tasks', { title: 'Supplier review', status: 'in_progress', board_column: 'col-waiting' })).json();
  const taskFile = path.join(workspace, 'tasks', 'active', created.id, 'task.md');
  const frontmatter = () => parseMarkdown(fs.readFileSync(taskFile, 'utf-8')).data as Record<string, unknown>;
  assert.equal(frontmatter().board_column, 'col-waiting');

  const moved = await send('PUT', `/tasks/${created.id}`, { status: 'blocked', board_column: 'col-blocked' });
  assert.equal(moved.status, 200);
  assert.equal(frontmatter().status, 'blocked');
  assert.equal(frontmatter().board_column, 'col-blocked');

  const beforeBad = fs.readFileSync(taskFile, 'utf-8');
  for (const bad of [42, 'In Progress', '', ['col-blocked']]) {
    assert.equal((await send('PUT', `/tasks/${created.id}`, { status: 'done', board_column: bad })).status, 400);
  }
  assert.equal(fs.readFileSync(taskFile, 'utf-8'), beforeBad, 'a refused update leaves the task as it was');

  // A status change on its own keeps the field (the board ignores a column that no longer fits); null removes it.
  await send('PUT', `/tasks/${created.id}`, { status: 'in_review' });
  assert.equal(frontmatter().board_column, 'col-blocked');
  await send('PUT', `/tasks/${created.id}`, { board_column: null });
  assert.equal('board_column' in frontmatter(), false);
  assert.equal(frontmatter().status, 'in_review');
});
