import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-release-daemon-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('malformed PID files cannot select process groups or invalid ports', async () => {
  const { readDaemonState } = await import('../../src/cli/utils/daemon');
  fs.mkdirSync(path.join(home, '.gtd'), { recursive: true });
  for (const raw of [
    '0',
    '-1',
    '1.5',
    '123garbage',
    'null',
    '{"pid":123}',
    '{"pid":123,"port":-1}',
    '{"pid":123,"port":65536}',
  ]) {
    fs.writeFileSync(path.join(home, '.gtd', 'gtd.pid'), raw);
    assert.equal(readDaemonState(), null, raw);
  }
});

test('a generic or failed health response cannot authorize signalling a recorded PID', async (t) => {
  const { checkRecordedDaemon } = await import('../../src/cli/utils/daemon');
  let body: object = { status: 'ok' };
  let status = 200;
  const server = http.createServer((_req, res) => {
    res.writeHead(status);
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const state = { pid: process.pid, port: (server.address() as AddressInfo).port, workspace: home, startedAt: '' };
  assert.equal(await checkRecordedDaemon(state), 'unknown', 'legacy health has no proof of process identity');
  body = { status: 'ok', pid: process.pid };
  status = 500;
  assert.equal(await checkRecordedDaemon(state), 'unknown', 'failed health is not proof');
  status = 200;
  assert.equal(await checkRecordedDaemon(state), 'ours');
  body = { status: 'ok', pid: process.pid, padding: 'x'.repeat(32 * 1024) };
  assert.equal(await checkRecordedDaemon(state), 'unknown', 'oversized replies are refused');
});

test('a health endpoint that keeps streaming cannot hang CLI commands', async (t) => {
  const { checkRecordedDaemon } = await import('../../src/cli/utils/daemon');
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    const timer = setInterval(() => res.write(' '), 20);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const state = { pid: process.pid, port: (server.address() as AddressInfo).port, workspace: home, startedAt: '' };
  let timer: ReturnType<typeof setTimeout>;
  const outcome = await Promise.race([
    checkRecordedDaemon(state),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('hung'), 3000);
    }),
  ]);
  clearTimeout(timer!);
  assert.equal(outcome, 'unknown');
});
