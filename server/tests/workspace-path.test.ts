import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// The config lives in ~/.gtd: point HOME at a temporary folder before the service reads it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-path-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
delete process.env['ESB_WORKSPACE_PATH'];

// Claude Code runs with the workspace as its folder, so a relative path handed to it (its --settings file) would be
// read from inside the workspace a second time and not be found (#338).
test('a relative workspace path from ESB_WORKSPACE_PATH is made absolute', async (t) => {
  const { WorkspaceService } = await import('../src/services/workspace');
  t.after(() => { delete process.env['ESB_WORKSPACE_PATH']; });
  process.env['ESB_WORKSPACE_PATH'] = path.join('northwind', 'ws');
  assert.equal(new WorkspaceService().getWorkspacePath(), path.resolve('northwind', 'ws'));
});

test('a relative workspace path in ~/.gtd/config.json is made absolute', async (t) => {
  const { WorkspaceService } = await import('../src/services/workspace');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.gtd'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gtd', 'config.json'), JSON.stringify({ workspace_path: 'northwind-ws' }));
  assert.equal(new WorkspaceService().getWorkspacePath(), path.resolve('northwind-ws'));
});
