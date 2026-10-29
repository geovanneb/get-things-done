import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, createUpdateInstaller, updatesEnabled } from '../src/update-controller';

test('only packaged signed releases can check for updates', () => {
  assert.equal(updatesEnabled(true, true, undefined), true);
  for (const signed of [false, undefined, 'true']) assert.equal(updatesEnabled(true, signed, undefined), false);
  assert.equal(updatesEnabled(false, true, undefined), false);
  assert.equal(updatesEnabled(true, true, '1'), false);
});

test('restart waits for server shutdown and coalesces repeated requests', async () => {
  const events: string[] = [];
  let stopped!: () => void;
  const shutdown = new Promise<void>((resolve) => { stopped = resolve; });
  const restart = createUpdateInstaller(async () => { events.push('shutdown'); await shutdown; }, () => { events.push('install'); }, assert.fail);
  const first = restart();
  const second = restart();
  await Promise.resolve();
  assert.deepEqual(events, ['shutdown']);
  stopped();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['shutdown', 'install']);
});

test('shutdown failure never installs and permits a retry', async () => {
  let failures = 0, installs = 0, calls = 0;
  const restart = createUpdateInstaller(async () => { if (++calls === 1) throw new Error('shutdown'); }, () => { installs++; }, () => { failures++; });
  await restart();
  assert.equal(installs, 0);
  assert.equal(failures, 1);
  await restart();
  assert.equal(installs, 1);
});

test('offline checks and failed background downloads are handled without unhandled rejections', async () => {
  const errors: unknown[] = [];
  const report = (error: unknown) => { errors.push(error); };
  await checkForUpdate(async () => { throw new Error('offline'); }, report);
  await checkForUpdate(async () => ({ downloadPromise: Promise.reject(new Error('download failed')) }), report);
  await checkForUpdate(async () => null, report);
  await checkForUpdate(async () => ({ downloadPromise: Promise.resolve([]) }), report);
  assert.equal(errors.length, 2);
});
