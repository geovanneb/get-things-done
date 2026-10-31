import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AddressInfo } from 'node:net';
import express from 'express';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-sidebar-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-sidebar-ws-'));
fs.writeFileSync(path.join(workspace, 'workspace.yaml'), 'name: "Northwind Labs"\n');
fs.mkdirSync(path.join(workspace, '.situation-board'));
const prefsFile = path.join(workspace, '.situation-board', 'ui-preferences.json');
process.env['ESB_WORKSPACE_PATH'] = workspace;

async function sidebarServer(t: { after: (fn: () => void) => void }) {
  const { default: router } = await import('../src/routes/workspace');
  const { errorHandler } = await import('../src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/workspace', router);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspace/sidebar`;
  const put = (body: unknown) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { url, put };
}

test('the sidebar order is saved in the workspace and keeps the other preferences', async (t) => {
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(prefsFile, JSON.stringify({ theme: 'system', default_view: 'situation' }));
  const { url, put } = await sidebarServer(t);

  assert.deepEqual(await (await fetch(url)).json(), { order: {}, hidden: [] }, 'no saved order means the default sidebar');

  const prefs = { order: { work: ['board', 'situation', 'meetings', 'insights'] }, hidden: ['insights'] };
  const saved = await put(prefs);
  assert.equal(saved.status, 200);
  assert.deepEqual(await (await fetch(url)).json(), prefs);
  const file = JSON.parse(fs.readFileSync(prefsFile, 'utf-8'));
  assert.equal(file.theme, 'system', 'other keys stay');
  assert.deepEqual(file.sidebar, prefs);

  // Two quick saves in a row: the last one wins and the file stays valid JSON.
  await Promise.all([put({ order: {}, hidden: ['routines'] }), put({ order: {}, hidden: ['agents'] })]);
  assert.deepEqual(JSON.parse(fs.readFileSync(prefsFile, 'utf-8')).sidebar, { order: {}, hidden: ['agents'] });

  // Request values are checked at runtime, and a rejected save leaves the file alone.
  const before = fs.readFileSync(prefsFile, 'utf-8');
  for (const bad of [
    [], 'board', { order: [] }, { hidden: 'board' }, { hidden: ['Board'] }, { hidden: ['../x'] },
    { hidden: ['board', 'board'] }, { order: { 'no good': ['board'] } }, { order: { work: [1] } },
    { hidden: Array.from({ length: 41 }, (_, i) => `item-${i}`) },
  ]) {
    assert.equal((await put(bad)).status, 400, `rejects ${JSON.stringify(bad).slice(0, 60)}`);
  }
  assert.equal(fs.readFileSync(prefsFile, 'utf-8'), before);

  // A broken file (for example after a bad merge) shows the default sidebar, and the next save repairs it.
  fs.writeFileSync(prefsFile, '{ "sidebar": ');
  assert.deepEqual(await (await fetch(url)).json(), { order: {}, hidden: [] });
  assert.equal((await put({ order: {}, hidden: [] })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(prefsFile, 'utf-8')).sidebar, { order: {}, hidden: [] });

  // A symlinked .situation-board would write outside the workspace: refused, and the target stays untouched.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-sidebar-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(path.join(workspace, '.situation-board'), { recursive: true });
  fs.symlinkSync(outside, path.join(workspace, '.situation-board'), 'dir');
  assert.equal((await put({ order: {}, hidden: ['routines'] })).status, 400);
  assert.deepEqual(fs.readdirSync(outside), []);
});
