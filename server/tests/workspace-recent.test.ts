import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// The config lives in ~/.gtd: point HOME at a temporary folder before the service reads it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-recent-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
delete process.env['ESB_WORKSPACE_PATH'];

function fakeWorkspace(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-recent-ws-'));
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), `name: "${name}"\n`);
  return dir;
}

test('the switcher lists the current workspace first, then the others newest first', async (t) => {
  const { WorkspaceService } = await import('../src/services/workspace');
  const service = new WorkspaceService();
  const north = fakeWorkspace('Northwind Labs');
  const south = fakeWorkspace('Southwind Partners');
  const gone = fakeWorkspace('Old Project');
  t.after(() => { for (const d of [home, north, south, gone]) fs.rmSync(d, { recursive: true, force: true }); });

  service.setWorkspacePath(gone);
  service.setWorkspacePath(north);
  service.setWorkspacePath(south);
  service.setWorkspacePath(north);
  fs.rmSync(gone, { recursive: true, force: true });

  const list = service.listRecentWorkspaces();
  assert.deepEqual(list.map((w) => w.name), ['Northwind Labs', 'Southwind Partners', path.basename(gone)]);
  assert.deepEqual(list.map((w) => w.current), [true, false, false]);
  assert.deepEqual(list.map((w) => w.available), [true, true, false]);
  assert.equal(list.filter((w) => w.path === north).length, 1, 'switching back does not duplicate an entry');

  service.forgetWorkspace(gone);
  assert.deepEqual(service.listRecentWorkspaces().map((w) => w.path), [north, south]);
  assert.equal(service.getWorkspacePath(), north, 'forgetting another entry keeps the current workspace');
});

test('a workspace opened outside the dashboard is remembered when the server starts', async () => {
  const { WorkspaceService } = await import('../src/services/workspace');
  const service = new WorkspaceService();
  const west = fakeWorkspace('Westwind Studio');
  try {
    service.rememberWorkspace(west);
    assert.ok(service.listRecentWorkspaces().some((w) => w.path === west && w.name === 'Westwind Studio'));
  } finally {
    fs.rmSync(west, { recursive: true, force: true });
  }
});
