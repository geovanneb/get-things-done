import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

// Keep the test away from the real ~/.gtd config.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-limit-home-'));
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

test('the request budget covers the API only: the page and its files still load once it is spent', async (t) => {
  const { startServer } = await import('../src/server');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-limit-ws-'));
  fs.writeFileSync(path.join(workspace, 'workspace.yaml'), 'name: "Northwind Labs"\n');
  // A fictional built UI: the page and one of its scripts.
  const ui = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-limit-ui-'));
  fs.mkdirSync(path.join(ui, 'assets'));
  fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script>');
  fs.writeFileSync(path.join(ui, 'assets', 'app.js'), 'export const fictional = true;\n');
  t.after(() => { for (const d of [home, workspace, ui]) fs.rmSync(d, { recursive: true, force: true }); });

  const port = await freePort();
  const running = await startServer({ port, workspacePath: workspace, uiPath: ui, logRequests: false });
  t.after(() => running.close());
  const get = (url: string) => fetch(running.url + url).then(async (r) => { await r.arrayBuffer(); return r; });

  // The page's files carry no budget; an API answer says what is left.
  const script = await get('/assets/app.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('ratelimit-policy'), null, 'a script of the page is not counted');
  assert.equal((await get('/board')).headers.get('ratelimit-policy'), null, 'nor the page itself');
  assert.ok((await get('/api/workspace')).headers.get('ratelimit-policy'), 'the API is counted');

  // Spend the whole budget on the API, as a runaway script would.
  let refused = 0;
  for (let sent = 0; sent < 3000 && refused === 0; sent += 100) {
    const batch = await Promise.all(Array.from({ length: 100 }, () => get('/api/health-check-that-does-not-exist').then((r) => r.status)));
    refused += batch.filter((s) => s === 429).length;
  }
  assert.ok(refused > 0, 'the API is still limited');
  assert.equal((await get('/api/workspace')).status, 429);

  // The dashboard still opens: the page and its scripts load, and it can say why the API refused.
  assert.equal((await get('/board')).status, 200);
  assert.equal((await get('/assets/app.js')).status, 200);
});
