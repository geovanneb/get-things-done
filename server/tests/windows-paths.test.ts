import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the watcher ignores .git folders with Windows and POSIX separators', async () => {
  const { IGNORED_PATH } = await import('../src/services/watcherService');
  assert.ok(IGNORED_PATH.test('C:\\Users\\demo\\Northwind\\.git\\index'));
  assert.ok(IGNORED_PATH.test('C:\\Users\\demo\\Northwind\\.git'));
  assert.ok(IGNORED_PATH.test('/home/demo/northwind/.git/index'));
  assert.ok(IGNORED_PATH.test('C:\\Users\\demo\\Northwind\\node_modules\\x\\README.md'));
  assert.ok(!IGNORED_PATH.test('C:\\Users\\demo\\Northwind\\.github\\copilot-instructions.md'));
  assert.ok(!IGNORED_PATH.test('C:\\Users\\demo\\Northwind\\tasks\\T-0001\\task.md'));
});

test('the Windows Claude Code launch keeps the workspace path out of the cmd line', async () => {
  const { windowsClaudeLaunch } = await import('../src/routes/workspace');
  const workspace = 'C:\\Users\\demo\\R&D 100% Plan';
  const launch = windowsClaudeLaunch(workspace);
  assert.equal(launch.options.cwd, workspace);
  assert.ok(launch.args.every((arg) => !arg.includes('R&D') && !arg.includes('%')));
  assert.deepEqual(launch.args.slice(-2), ['/k', 'claude']);
});
