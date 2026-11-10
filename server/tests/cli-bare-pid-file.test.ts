import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The CLI keeps its PID file in ~/.gtd: point HOME at a temporary folder before it is loaded.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-pid-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;

// Older versions wrote only the PID, which is valid JSON, so the fallback for it never ran (#366).
test('a bare PID file from an older version is read with the old default port', async (t) => {
  const { readDaemonState } = await import('../../src/cli/utils/daemon');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.gtd'), { recursive: true });

  fs.writeFileSync(path.join(home, '.gtd', 'gtd.pid'), '12345\n');
  assert.deepEqual(readDaemonState(), { pid: 12345, port: 3001, workspace: '', startedAt: '' });

  const state = { pid: 12345, port: 4417, workspace: '/tmp/northwind', startedAt: '2026-11-09T08:00:00.000Z' };
  fs.writeFileSync(path.join(home, '.gtd', 'gtd.pid'), JSON.stringify(state));
  assert.deepEqual(readDaemonState(), state, 'the current format is read as before');
});
