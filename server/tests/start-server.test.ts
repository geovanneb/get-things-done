import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

// Keep the test away from the real ~/.gtd config.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-start-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
delete process.env['ESB_WORKSPACE_PATH'];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

test('startServer runs in-process on the given workspace and closes without exiting', async (t) => {
  const { startServer } = await import('../src/server');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-start-ws-'));
  fs.writeFileSync(path.join(workspace, 'workspace.yaml'), 'name: "Northwind Labs"\n');
  t.after(() => { for (const d of [home, workspace]) fs.rmSync(d, { recursive: true, force: true }); });

  const port = await freePort();
  const running = await startServer({ port, workspacePath: workspace, logRequests: false });
  assert.equal(running.url, `http://127.0.0.1:${port}`);

  const health = await fetch(`${running.url}/health`);
  assert.equal(health.status, 200);

  const info = await fetch(`${running.url}/api/workspace`);
  assert.equal(info.status, 200);
  assert.match(await info.text(), /Northwind Labs/);

  // The request guard is bound to this port.
  const foreign = await fetch(`${running.url}/health`, { headers: { origin: 'http://example.test' } });
  assert.equal(foreign.status, 403);

  // An update opened from a run-finished notice is read only from the workspace the run was in (#246 follow-up).
  const asked = (where: string) => fetch(`${running.url}/api/context-updates/CU-2026-0001?${where}`).then((r) => r.status);
  assert.equal(await asked(`workspace=${encodeURIComponent(workspace)}`), 404, 'the right workspace gets past the check (there is no such update here)');
  assert.equal(await asked(`workspace=${encodeURIComponent(path.join(workspace, 'other'))}`), 409, 'another workspace is refused');
  assert.equal(await asked(`workspace=${encodeURIComponent(workspace)}&workspace=x`), 409, 'a list is not a workspace');
  assert.equal(await asked(''), 404, 'without it, read as before');
  // Every request of such a page says so in a header, changes included; checked before anything is read or changed.
  const other = encodeURIComponent(path.join(workspace, 'other'));
  const said = (method: string, url: string, header: string) => fetch(`${running.url}${url}`, { method, headers: { 'X-GTD-Workspace': header, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }).then((r) => r.status);
  assert.equal(await said('GET', '/api/context-updates/CU-2026-0001/run', other), 409);
  assert.equal(await said('POST', '/api/context-updates/CU-2026-0001/approve', other), 409, 'a change is refused too');
  assert.equal(await said('GET', '/api/context-updates/CU-2026-0001/run', '%E0%A4%A'), 409, 'an unreadable header is refused');
  assert.notEqual(await said('GET', '/api/context-updates/CU-2026-0001/run', encodeURIComponent(workspace)), 409, 'the right workspace goes through');
  assert.equal(await asked(`workspace=${other}`.replace('?', '')), 409);
  assert.equal(await fetch(`${running.url}/api/context-updates/CU-2026-0001/materials/notes.md?workspace=${other}`).then((r) => r.status), 409, 'a material link with another workspace is refused');

  await running.close();

  // The port is free again, so a host can start the server a second time.
  const again = await startServer({ port, workspacePath: workspace, logRequests: false });
  await again.close();
});

test('startServer rejects a busy port instead of crashing the host', async () => {
  const { startServer } = await import('../src/server');
  const blocker = net.createServer();
  const port = await new Promise<number>((resolve) => {
    blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as net.AddressInfo).port));
  });
  try {
    await assert.rejects(startServer({ port, logRequests: false }), /EADDRINUSE/);
  } finally {
    blocker.close();
  }
});

test('startServer rejects an invalid port', async () => {
  const { startServer } = await import('../src/server');
  await assert.rejects(startServer({ port: 0, logRequests: false }), /Invalid port/);
});
