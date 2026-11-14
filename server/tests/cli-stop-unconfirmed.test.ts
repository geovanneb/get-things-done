import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

// The CLI keeps its PID file in ~/.gtd: point HOME at a temporary folder before it is loaded.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-stop-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-stop-ws-'));
process.env['ESB_WORKSPACE_PATH'] = workspace;
const pidFile = path.join(home, '.gtd', 'gtd.pid');

test.after(() => {
  for (const d of [home, workspace]) fs.rmSync(d, { recursive: true, force: true });
});

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

function writePidFile(pid: number, port: number): void {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, JSON.stringify({ pid, port, workspace, startedAt: new Date().toISOString() }));
}

/** Runs a CLI command in this process and returns what it printed and the exit code it set. */
async function run(command: { parseAsync(argv: string[], opts: { from: 'user' }): Promise<unknown> }) {
  const lines: string[] = [];
  const log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  const out = test.mock.method(console, 'log', log);
  const err = test.mock.method(console, 'error', log);
  const before = process.exitCode;
  try {
    await command.parseAsync([], { from: 'user' });
    return { output: lines.join('\n'), exitCode: process.exitCode };
  } finally {
    out.mock.restore();
    err.mock.restore();
    process.exitCode = before;
  }
}

/** A stand-in dashboard: answers /health with its own PID and takes `closeMs` to shut down after SIGTERM. */
async function fakeDashboard(
  closeMs: number,
): Promise<{ child: ChildProcess; port: number; exit: Promise<[number | null, string | null]> }> {
  const script = `
    const http = require('http');
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), ${closeMs}));
    setTimeout(() => process.exit(2), 60000);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exit = new Promise<[number | null, string | null]>((resolve) =>
    child.once('exit', (code, signal) => resolve([code, signal])),
  );
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake dashboard did not start')), 10_000);
    child.stdout!.once('data', (d: Buffer) => {
      clearTimeout(timer);
      resolve(Number(String(d).trim()));
    });
  });
  return { child, port, exit };
}

test('gtd stop waits longer than the server allows itself to shut down', async () => {
  const { GRACE_PERIOD_MS } = await import('../../src/cli/commands/stop');
  const { SHUTDOWN_TIMEOUT_MS } = await import('../src/server');
  assert.equal(typeof SHUTDOWN_TIMEOUT_MS, 'number');
  assert.ok(
    GRACE_PERIOD_MS > SHUTDOWN_TIMEOUT_MS,
    `stop waits ${GRACE_PERIOD_MS} ms, the server up to ${SHUTDOWN_TIMEOUT_MS} ms`,
  );
});

// SIGTERM ends a process at once on Windows, so there is no clean shutdown to wait for there.
test(
  'a dashboard that takes a few seconds to close is not force-killed',
  { skip: process.platform === 'win32', timeout: 30_000 },
  async (t) => {
    const { stopCommand } = await import('../../src/cli/commands/stop');
    const dashboard = await fakeDashboard(6_500);
    t.after(() => {
      dashboard.child.kill('SIGKILL');
    });
    writePidFile(dashboard.child.pid!, dashboard.port);

    const { output } = await run(stopCommand);
    assert.deepEqual(await dashboard.exit, [0, null], 'it exited on its own, not by SIGKILL');
    assert.match(output, /Server stopped\./);
    assert.equal(fs.existsSync(pidFile), false);
  },
);

// A process the CLI cannot confirm is left alone (#364), but the user is told what to do about it.
test('stop and start explain an unconfirmed process and do not report success', { timeout: 30_000 }, async (t) => {
  const { stopCommand } = await import('../../src/cli/commands/stop');
  const { startCommand } = await import('../../src/cli/commands/start');
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => other.once('exit', resolve));
  t.after(() => {
    other.kill('SIGKILL');
  });
  writePidFile(other.pid!, await freePort());

  const stop = await run(stopCommand);
  assert.equal(stop.exitCode, 1);
  assert.match(
    stop.output,
    new RegExp(`Process ${other.pid} could not be confirmed as the dashboard.*It was not stopped\\.`),
  );
  assert.match(stop.output, /older dashboard, a dashboard that is not responding, or another program/);
  assert.ok(stop.output.includes(`delete ${pidFile}`), stop.output);
  assert.doesNotMatch(stop.output, /--force/, 'no option that does not exist');

  const start = await run(startCommand);
  assert.equal(start.exitCode, 1);
  assert.match(start.output, /could not be confirmed as the dashboard.*A new dashboard was not started\./);
  assert.match(start.output, /Then run `gtd start` again\./);
  assert.doesNotMatch(start.output, /already running/);

  const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
  assert.equal(gone, false, 'the process was not signalled');
  assert.equal(fs.existsSync(pidFile), true, 'and its file is kept');
});
