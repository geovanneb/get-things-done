import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, createQuitFlow, createUpdateInstaller, nextUpdateState, updatesEnabled, whyNotNow, type DesktopUpdateState } from '../src/update-controller';

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

test('the update state follows the updater, and a downloaded update stays ready until the restart (#284)', () => {
  const idle: DesktopUpdateState = { phase: 'idle', version: null, percent: null, error: null };
  let s = nextUpdateState(idle, { type: 'checking' });
  assert.equal(s.phase, 'checking');
  s = nextUpdateState(s, { type: 'available', version: '0.11.0' });
  assert.deepEqual(s, { phase: 'downloading', version: '0.11.0', percent: 0, error: null });
  s = nextUpdateState(s, { type: 'progress', percent: 41.6 });
  assert.equal(s.percent, 42);
  assert.equal(nextUpdateState(s, { type: 'progress', percent: 250 }).percent, 100);
  s = nextUpdateState(s, { type: 'downloaded', version: '0.11.0' });
  assert.deepEqual(s, { phase: 'ready', version: '0.11.0', percent: null, error: null });
  for (const later of [{ type: 'checking' }, { type: 'none' }, { type: 'error', message: 'offline' }, { type: 'available', version: '0.11.1' }, { type: 'progress', percent: 5 }] as const) {
    assert.deepEqual(nextUpdateState(s, later), s, later.type);
  }
  assert.equal(nextUpdateState(s, { type: 'downloaded', version: '0.11.1' }).version, '0.11.1', 'a newer download replaces it');
  const failed = nextUpdateState(idle, { type: 'error', message: 'net::ERR_INTERNET_DISCONNECTED\n  at stack\u202E' });
  assert.deepEqual([failed.phase, failed.error], ['error', 'net::ERR_INTERNET_DISCONNECTED at stack']);
  assert.equal(nextUpdateState(idle, { type: 'available', version: '<b>1</b>' }).phase, 'idle', 'an odd version is never shown');
  const off: DesktopUpdateState = { phase: 'off', version: null, percent: null, error: null };
  assert.deepEqual(nextUpdateState(off, { type: 'downloaded', version: '0.11.0' }), off, 'a build that does not update itself stays off');
});

test('a restart or quit waits for the same things as the npm update: a recording, a transcription, an AI tool run', () => {
  assert.equal(whyNotNow(true, null), 'A meeting is being recorded');
  assert.equal(whyNotNow(false, 'A transcription is running'), 'A transcription is running');
  assert.equal(whyNotNow(false, 'An AI tool run is going'), 'An AI tool run is going');
  assert.equal(whyNotNow(false, null), null);
  assert.equal(whyNotNow(false, undefined), null, 'a server that cannot be asked never keeps the app from quitting');
  assert.match(whyNotNow(false, undefined, true) ?? '', /could not be checked/, 'but a restart to update never goes ahead blindly');
  assert.equal(whyNotNow(false, 'A meeting is being recorded'), 'A meeting is being recorded', 'a recording from another page counts too');
});

test('a restart that did not go ahead stays ready and says why', () => {
  const ready: DesktopUpdateState = { phase: 'ready', version: '0.11.0', percent: null, error: null };
  const failed = nextUpdateState(ready, { type: 'restart-failed', message: 'The restart did not work: EACCES' });
  assert.deepEqual(failed, { ...ready, error: 'The restart did not work: EACCES' });
  const idle: DesktopUpdateState = { phase: 'idle', version: null, percent: null, error: null };
  assert.deepEqual(nextUpdateState(idle, { type: 'restart-failed', message: 'x' }), idle, 'nothing to say when nothing was ready');
});

test('one quit at a time, and none goes through while the server stops, for a quit or an update', async () => {
  const events: string[] = [];
  let stopped!: () => void;
  let answer!: (yes: boolean) => void;
  const flow = createQuitFlow({
    confirm: () => new Promise((r) => { answer = r; }),
    stop: () => new Promise((r) => { events.push('stop'); stopped = () => r(); }),
    quit: () => { events.push('quit'); },
  });
  assert.equal(flow.request(), false, 'the first quit is held while it asks');
  assert.equal(flow.request(), false, 'a second one joins it');
  answer(false);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(events, [], 'Keep running: nothing stops');
  assert.equal(flow.request(), false);
  answer(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(events, ['stop']);
  assert.equal(flow.request(), false, 'a quit while the server stops is held');
  stopped();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(events, ['stop', 'quit']);
  assert.equal(flow.request(), true, 'the final quit goes through');

  // An update's restart: quits wait while it stops the server, then the installer's quit goes through.
  const update = createQuitFlow({ confirm: async () => true, stop: async () => undefined, quit: () => undefined });
  let done!: () => void;
  const stopping = update.stopForUpdate(() => new Promise((r) => { done = r; }));
  assert.equal(update.request(), false, 'Quit during the update\'s shutdown is held');
  done();
  await stopping;
  assert.equal(update.request(), true);
  update.reset();
  assert.equal(update.request(), false, 'after a failed restart, quitting is asked again');
});

test('an asynchronous installer failure can reset a completed handoff and retry', async () => {
  let preparations = 0, installs = 0;
  const restart = createUpdateInstaller(async () => { preparations++; }, () => { installs++; }, assert.fail);
  await restart();
  await restart();
  assert.equal(installs, 1, 'a handed-off install stays coalesced until failure is reported');
  // electron-updater reports installation failures through an event after quitAndInstall returns.
  restart.reset();
  await Promise.all([restart(), restart()]);
  assert.equal(preparations, 2);
  assert.equal(installs, 2, 'a retry performs the handoff again exactly once');
});
