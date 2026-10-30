import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AddressInfo } from 'node:net';
import express from 'express';

// Icons live in ~/.gtd: point HOME at a temporary folder before anything reads it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-icon-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
delete process.env['ESB_WORKSPACE_PATH'];

/** A 1 x 1 PNG. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function fakeWorkspace(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-icon-ws-'));
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), `name: "${name}"\n`);
  return dir;
}

async function iconServer(t: { after: (fn: () => void) => void }) {
  const { default: router } = await import('../src/routes/workspace');
  const { errorHandler } = await import('../src/middleware/errorHandler');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/workspace', router);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspace`;
  const put = (image: unknown) => fetch(`${base}/icon`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }),
  });
  return { base, put };
}

test('a picture is stored per workspace in the home config, never in the workspace folder', async (t) => {
  const { WorkspaceService } = await import('../src/services/workspace');
  const service = new WorkspaceService();
  const north = fakeWorkspace('Northwind Labs');
  const south = fakeWorkspace('Southwind Partners');
  t.after(() => { for (const d of [north, south]) fs.rmSync(d, { recursive: true, force: true }); });
  const { base, put } = await iconServer(t);

  service.setWorkspacePath(south);
  service.setWorkspacePath(north);
  assert.equal(service.getWorkspaceConfig().icon_version, null);
  assert.equal((await fetch(`${base}/icon`)).status, 404);

  const saved = await put(PNG);
  assert.equal(saved.status, 200);
  const { icon_version } = await saved.json();
  assert.ok(icon_version);
  assert.equal(service.getWorkspaceConfig().icon_version, icon_version);
  assert.deepEqual(fs.readdirSync(north).sort(), ['workspace.yaml'], 'nothing is written into the workspace');
  assert.equal(fs.readdirSync(path.join(home, '.gtd', 'workspace-icons')).length, 1);

  const recent = service.listRecentWorkspaces();
  assert.deepEqual(recent.map((w) => w.icon_version !== null), [true, false], 'only the workspace that got a picture has one');

  const image = await fetch(`${base}/icon`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/icon?path=${encodeURIComponent(north)}`)).status, 200);
  assert.equal((await fetch(`${base}/icon?path=${encodeURIComponent(south)}`)).status, 404);

  assert.equal((await fetch(`${base}/icon`, { method: 'DELETE' })).status, 200);
  assert.equal(service.getWorkspaceConfig().icon_version, null);
  assert.equal((await fetch(`${base}/icon`)).status, 404);
});

test('only a reasonably sized PNG is accepted, and a refused upload changes nothing', async (t) => {
  const { WorkspaceService } = await import('../src/services/workspace');
  const service = new WorkspaceService();
  const west = fakeWorkspace('Westwind Studio');
  t.after(() => fs.rmSync(west, { recursive: true, force: true }));
  service.setWorkspacePath(west);
  const { put } = await iconServer(t);

  const svg = `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
  const huge = Buffer.from(PNG.split(',')[1], 'base64');
  huge.writeUInt32BE(5000, 16); // claims 5000 px wide
  for (const bad of [
    undefined,
    42,
    'data:image/svg+xml;base64,PHN2Zy8+',
    svg,
    'data:image/png;base64,not base64!',
    `data:image/png;base64,${huge.toString('base64')}`,
    `data:image/png;base64,${Buffer.alloc(600 * 1024).toString('base64')}`,
  ]) {
    assert.equal((await put(bad)).status, 400, `refused: ${String(bad).slice(0, 40)}`);
  }
  assert.equal(service.getWorkspaceConfig().icon_version, null);
});

test('the picture route does not reveal pictures of folders outside the recent list', async (t) => {
  const { WorkspaceService } = await import('../src/services/workspace');
  const { saveWorkspaceIcon } = await import('../src/services/workspaceIcon');
  const service = new WorkspaceService();
  const current = fakeWorkspace('Eastwind Co');
  const stranger = fakeWorkspace('Not Opened Here');
  t.after(() => { for (const d of [current, stranger]) fs.rmSync(d, { recursive: true, force: true }); });
  service.setWorkspacePath(current);
  await saveWorkspaceIcon(stranger, Buffer.from(PNG.split(',')[1], 'base64'));
  const { base } = await iconServer(t);

  assert.equal((await fetch(`${base}/icon?path=${encodeURIComponent(stranger)}`)).status, 404);
  assert.equal((await fetch(`${base}/icon?path=${encodeURIComponent('../../etc/passwd')}`)).status, 404);
  assert.equal((await fetch(`${base}/icon?path=a&path=b`)).status, 400);
});
