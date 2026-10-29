import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

// A computer without git: nothing on PATH, a workspace that still has a .git folder.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-nogit-home-'));
const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-nogit-bin-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-nogit-ws-'));
fs.writeFileSync(path.join(workspace, 'workspace.yaml'), 'name: "Northwind Labs"\n');
fs.mkdirSync(path.join(workspace, '.git'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
process.env['PATH'] = emptyBin;
process.env['ESB_WORKSPACE_PATH'] = workspace;

test('without git installed, git features report off and git routes answer 503 with a clear message', async (t) => {
  const express = (await import('express')).default;
  const { default: workspaceRouter } = await import('../src/routes/workspace');
  const app = express();
  app.use(express.json());
  app.use('/api/workspace', workspaceRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspace`;
  t.after(() => {
    server.close();
    for (const d of [home, emptyBin, workspace]) fs.rmSync(d, { recursive: true, force: true });
  });

  const info = await (await fetch(base)).json();
  assert.equal(info.git_enabled, false);
  assert.equal(info.git_installed, false);

  const status = await (await fetch(`${base}/git/status`)).json();
  assert.equal(status.is_repo, false);
  assert.equal(status.git_installed, false);

  for (const [method, route, body] of [
    ['GET', '/git/diff', undefined],
    ['GET', '/git/log', undefined],
    ['POST', '/git/stage', { file: 'tasks/demo.md' }],
    ['POST', '/git/commit', { message: 'Demo change' }],
  ] as const) {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(res.status, 503, `${method} ${route}`);
    assert.match((await res.json()).message, /Git is not installed/);
  }
});
