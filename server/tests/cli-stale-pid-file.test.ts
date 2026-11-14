import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

// The CLI keeps its PID file in ~/.gtd: point HOME at a temporary folder before it is loaded.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-pid-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
delete process.env['ESB_WORKSPACE_PATH'];
const pidFile = path.join(home, '.gtd', 'gtd.pid');

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

function writePidFile(pid: number, port: number, startedAt = new Date().toISOString()): void {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, JSON.stringify({ pid, port, workspace: home, startedAt }));
}

// After a crash or a reboot a leftover gtd.pid can name an unrelated process (#364): the CLI must not report
// it as the dashboard, refuse to start because of it, or signal it on `gtd stop`. It drops the file only when
// it knows the process is not the dashboard, and keeps it when it cannot tell.
test('a PID file naming an unrelated process is stale, and gtd stop does not signal that process', async (t) => {
  const { getRunningDaemon } = await import('../../src/cli/utils/daemon');
  const { stopCommand } = await import('../../src/cli/commands/stop');
  const { startServer } = await import('../src/server');

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-pid-ws-'));
  fs.writeFileSync(path.join(workspace, 'workspace.yaml'), 'name: "Northwind Labs"\n');
  // Stands for the process that got the dashboard's old PID.
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => other.once('exit', resolve));
  const port = await freePort();
  const running = await startServer({ port, workspacePath: workspace, logRequests: false });
  const log = t.mock.method(console, 'log', () => {});
  t.after(async () => {
    log.mock.restore();
    other.kill();
    await running.close();
    for (const d of [home, workspace]) fs.rmSync(d, { recursive: true, force: true });
  });
  const stillRunning = async () => {
    const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
    return !gone && other.exitCode === null;
  };

  // Recorded before the last boot: that dashboard is gone, so `gtd start` goes ahead.
  const beforeBoot = new Date(Date.now() - os.uptime() * 1000 - 3_600_000).toISOString();
  writePidFile(other.pid!, await freePort(), beforeBoot);
  assert.equal(await getRunningDaemon(), null);
  assert.equal(fs.existsSync(pidFile), false, 'the stale file is removed');

  // A dashboard answers on the recorded port, but it is another process.
  writePidFile(other.pid!, port);
  assert.equal(await getRunningDaemon(), null);
  assert.equal(fs.existsSync(pidFile), false);

  // Nothing answers yet (a dashboard still booting, or hung): it may be ours, so the file is kept.
  const silent = await freePort();
  writePidFile(other.pid!, silent);
  assert.equal((await getRunningDaemon())?.pid, other.pid);
  assert.equal(fs.existsSync(pidFile), true);

  // The dashboard that answers with the recorded PID is recognised.
  writePidFile(process.pid, port);
  assert.equal((await getRunningDaemon())?.pid, process.pid);

  // gtd stop signals neither a process it cannot confirm nor another dashboard's.
  writePidFile(other.pid!, silent);
  await stopCommand.parseAsync([], { from: 'user' });
  assert.equal(await stillRunning(), true, 'an unconfirmed process is not signalled');
  assert.equal(fs.existsSync(pidFile), true, 'and its file is kept');
  assert.equal(process.exitCode, 1, 'and gtd stop does not report success');
  process.exitCode = undefined;

  writePidFile(other.pid!, port);
  await stopCommand.parseAsync([], { from: 'user' });
  assert.equal(await stillRunning(), true, 'the unrelated process is not signalled');
  assert.equal(fs.existsSync(pidFile), false);
});
