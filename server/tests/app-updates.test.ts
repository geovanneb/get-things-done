import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import { checkNow, compareVersions, dismiss, feedFile, globalDirs, install, installKind, isVersion, npmInstallArgs, npmInstallBlocked, npmLatest, otherRuntimes, registerRuntime, admitRuntime, prepareDesktopRestart, cancelDesktopRestart, setAutoCheck, setInstallerForTests, setLatestSourceForTests, updateStatus, type Installer } from '../src/services/appUpdates';
import { getAppVersion } from '../src/services/scaffold';
import { startUpdateHelper } from '../src/services/updateHelper';
import { beginStart, refuseWhileUpdating } from '../src/services/appActivity';
import { RUN_RECORD } from '../src/services/watcherService';

/** A fresh state file, and the update environment restored afterwards. */
async function state(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-updates-'));
  const keep = Object.fromEntries(['GTD_UPDATES_PATH', 'GTD_INSTALL', 'GTD_UPDATES', 'GTD_UPDATE_CHANNEL', 'GTD_DISABLE_UPDATES', 'ESB_WORKSPACE_PATH', 'GTD_UPDATE_HELPER'].map((k) => [k, process.env[k]]));
  process.env['GTD_UPDATES_PATH'] = path.join(dir, 'updates.json');
  t.after(async () => {
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    setLatestSourceForTests(null);
    setInstallerForTests(null);
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const current = getAppVersion();
const bump = (v: string, by: [number, number, number]) => v.split('.').map((n, i) => String(Number(n) + by[i]!)).join('.');
const next = bump(current, [0, 1, 0]);

test('versions compare by semantic versioning, pre-releases included', () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0, 'by number, not as text');
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('0.9.0', '0.9.0'), 0);
  assert.ok(compareVersions('0.10.0-beta.1', '0.10.0') < 0, 'a pre-release comes before its release');
  assert.ok(compareVersions('1.0.0-beta.10', '1.0.0-beta.2') > 0, 'numeric identifiers by number');
  assert.ok(compareVersions('1.0.0-1', '1.0.0-alpha') < 0, 'numbers before words');
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0, 'a shorter set first');
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0+build.9'), 0, 'build metadata is not ordered');
  for (const bad of ['latest', '01.0.0', '1.0.0-01', '1.0.0-', '1.0.0-a..b', '1.0', 'v1.0.0']) assert.equal(isVersion(bad), false, bad);
  assert.equal(isVersion('1.0.0+20261104'), true);
  assert.ok(compareVersions('1.0.0-beta.2026110401', '1.0.0-beta.999999999') > 0, 'long numbers, without rounding');
  assert.ok(compareVersions('1.0.0-beta.2026110402', '1.0.0-beta.2026110401') > 0);
});

test('only a strictly newer version is offered: never the same or an older one', async (t) => {
  await state(t);
  for (const [latest, newer] of [[next, true], [current, false], ['0.0.1', false], [`${next}-beta.1`, true], [`${current}-beta.1`, false]] as const) {
    setLatestSourceForTests(async () => latest);
    const s = await checkNow();
    assert.deepEqual([s.latest, s.newer], [latest, newer], latest);
  }
});

test('a failed check is kept with its reason, and the version found before stays', async (t) => {
  await state(t);
  setLatestSourceForTests(async () => next);
  await checkNow();
  setLatestSourceForTests(async () => { throw new Error('offline'); });
  const s = await checkNow();
  assert.deepEqual([s.latest, s.newer, s.error], [next, true, 'offline']);
  setLatestSourceForTests(async () => 'latest');
  assert.equal((await checkNow()).error, 'No version was given', 'an answer that is not a version is never kept');
});

test('"Check now" asks once for many clicks, and not again within seconds', async (t) => {
  await state(t);
  let asked = 0;
  setLatestSourceForTests(async () => { asked++; await new Promise((r) => setTimeout(r, 50)); return current; });
  await Promise.all([checkNow(), checkNow(), checkNow()]);
  await checkNow();
  assert.equal(asked, 1);
});

test('where checks are turned off, even "Check now" never reaches the network', async (t) => {
  await state(t);
  process.env['GTD_DISABLE_UPDATES'] = '1';
  setLatestSourceForTests(null);
  const s = await checkNow();
  assert.deepEqual([s.latest, s.error], [null, 'Checking for updates is turned off here']);
});

test('Later puts off only the version found; automatic checks can be turned off', async (t) => {
  await state(t);
  setLatestSourceForTests(async () => next);
  await checkNow();
  await assert.rejects(dismiss('9.9.9'), /only the version found/);
  await assert.rejects(dismiss('../x'), /only the version found/);
  assert.equal((await dismiss(next)).dismissed, next);
  assert.equal((await updateStatus()).auto_check, true, 'on by default');
  assert.equal((await setAutoCheck(false)).auto_check, false);
  await assert.rejects(setAutoCheck('no'), /true or false/);
});

test('changes made at the same moment are all kept: turning checks off is never lost', async (t) => {
  await state(t);
  setLatestSourceForTests(async () => next);
  await checkNow();
  for (let i = 0; i < 20; i++) {
    await setAutoCheck(true);
    await Promise.all([setAutoCheck(false), dismiss(next), (setLatestSourceForTests(async () => next), checkNow())]);
    const s = await updateStatus();
    assert.deepEqual([s.auto_check, s.dismissed, s.latest], [false, next, next], `round ${i}`);
  }
});

test('a damaged settings file turns automatic checks off and says so, and turning them on again repairs it', async (t) => {
  const dir = await state(t);
  for (const content of ['{', 'null', '[]', '"text"', '{}', '{"auto_check":"false"}']) {
    await fsp.writeFile(path.join(dir, 'updates.json'), content);
    const s = await updateStatus();
    assert.deepEqual([s.auto_check, /could not be read/.test(s.error ?? '')], [false, true], content);
    const repaired = await setAutoCheck(true);
    assert.deepEqual([repaired.auto_check, repaired.error], [true, null], content);
  }
});

test('each kind of install keeps its own answer: npm and the desktop app never take each other\'s', async (t) => {
  await state(t);
  setLatestSourceForTests(async () => next);
  await checkNow();
  process.env['GTD_INSTALL'] = 'desktop';
  process.env['GTD_UPDATE_CHANNEL'] = 'latest-arm64';
  process.env['GTD_UPDATES'] = 'on';
  assert.deepEqual([(await updateStatus()).latest, (await updateStatus()).checked_at], [null, null], 'the npm answer is not the desktop\'s');
  setLatestSourceForTests(async () => current);
  assert.equal((await checkNow()).latest, current);
  delete process.env['GTD_INSTALL'];
  assert.equal((await updateStatus()).latest, next, 'npm\'s answer stayed');
});

test('how each install updates: global and local npm, npx, desktop by itself or not at all, source by hand', async (t) => {
  await state(t);
  const has = (...files: string[]) => (f: string) => files.includes(f);
  assert.equal(installKind('/opt/homebrew/lib/node_modules/@bertonha/getthingsdone', {}, has()), 'npm');
  assert.equal(installKind('C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@bertonha\\getthingsdone', {}, has()), 'npm');
  assert.equal(installKind('/Users/a/project/node_modules/@bertonha/getthingsdone', {}, has('/Users/a/project/package.json')), 'npm-local');
  assert.equal(installKind('C:\\work\\project\\node_modules\\@bertonha\\getthingsdone', {}, has('C:\\work\\project\\package.json')), 'npm-local');
  assert.equal(installKind('/Users/a/.npm/_npx/1a2b/node_modules/@bertonha/getthingsdone', {}, has()), 'npx');
  assert.equal(installKind('/Users/a/code/get-things-done', {}, has()), 'source');
  assert.equal(installKind('/anything', { GTD_INSTALL: 'desktop' }, has()), 'desktop');

  process.env['GTD_INSTALL'] = 'desktop';
  process.env['GTD_UPDATE_CHANNEL'] = 'latest-arm64';
  process.env['GTD_UPDATES'] = 'on';
  setLatestSourceForTests(async () => next);
  await checkNow();
  let s = await updateStatus();
  assert.deepEqual([s.kind, s.channel, s.how, s.commands], ['desktop', 'latest-arm64', 'self', []]);
  process.env['GTD_UPDATES'] = 'off';
  s = await updateStatus();
  assert.deepEqual([s.how, s.release_url], ['manual', 'https://github.com/geovanneb/get-things-done/releases/latest'], 'an unsigned or preview build links to the release');
  assert.equal(s.notes_url, `https://github.com/geovanneb/get-things-done/releases/tag/v${next}`);
  process.env['GTD_UPDATE_CHANNEL'] = 'not a channel!';
  assert.equal((await updateStatus()).channel, 'latest', 'an odd channel is never passed on');
});

test('the status says when something important runs, so no notice comes meanwhile', async (t) => {
  const dir = await state(t);
  const ws = path.join(dir, 'workspace');
  await fsp.mkdir(path.join(ws, '.situation-board', 'runs'), { recursive: true });
  assert.equal((await updateStatus(ws)).busy, null);
  // An AI tool run recorded as running by a process that is alive (this one stands in for it).
  await fsp.writeFile(path.join(ws, '.situation-board', 'runs', 'CU-2026-0001.json'), JSON.stringify({ status: 'running', pid: process.pid }));
  assert.equal((await updateStatus(ws)).busy, 'An AI tool run is going');
  // A damaged record before it never hides it.
  await fsp.writeFile(path.join(ws, '.situation-board', 'runs', 'CU-2026-0000.json'), '{');
  assert.equal((await updateStatus(ws)).busy, 'An AI tool run is going');
  await fsp.writeFile(path.join(ws, '.situation-board', 'runs', 'CU-2026-0001.json'), JSON.stringify({ status: 'done', pid: process.pid }));
  assert.equal((await updateStatus(ws)).busy, null);
});

test('a run\'s record is watched, so other dashboards learn at once that a run started or ended', () => {
  assert.ok(RUN_RECORD.test('/w/.situation-board/runs/CU-2026-0007.json'));
  assert.ok(RUN_RECORD.test('C:\\w\\.situation-board\\runs\\CU-2026-0007.json'));
  for (const other of ['/w/.situation-board/runs/runner-settings.json', '/w/.situation-board/runs/.CU-2026-0007.json.1f2e.tmp', '/w/context-updates/CU-2026-0007.json']) assert.equal(RUN_RECORD.test(other), false, other);
});

test('the desktop feed file follows the channel and the system, as the app\'s updater reads it', () => {
  assert.equal(feedFile('latest-arm64', 'darwin'), 'latest-arm64-mac.yml');
  assert.equal(feedFile('latest', 'darwin'), 'latest-mac.yml');
  assert.equal(feedFile('latest', 'win32'), 'latest.yml');
  assert.equal(feedFile('latest', 'linux'), 'latest-linux.yml');
});

/** An installer that installs nothing: it records what it was asked; the version "on disk" is the test's to set. */
function fakeInstaller(options: { blocked?: string | null; disk?: string; slow?: number } = {}) {
  const asked: { version: string; from: string; workspace: string }[] = [];
  const fake = { disk: options.disk ?? current };
  const installer: Installer = {
    blocked: async () => { if (options.slow) await new Promise((r) => setTimeout(r, options.slow)); return options.blocked ?? null; },
    // The helper's process: this one stands in for it, so the lock it holds is alive.
    start: (job) => { asked.push(job); return process.pid; },
    installedVersion: () => fake.disk,
  };
  return { installer, asked, fake };
}

/** A workspace folder, and the lock and result files next to the update state. */
async function setup(t: Parameters<typeof state>[0]) {
  const dir = await state(t);
  const ws = path.join(dir, 'workspace');
  await fsp.mkdir(path.join(ws, '.situation-board', 'runs'), { recursive: true });
  // The workspace the dashboard shows: an update restarts on it.
  process.env['ESB_WORKSPACE_PATH'] = ws;
  return { dir, ws, lock: path.join(dir, 'update.lock'), result: path.join(dir, 'update-result.json') };
}

test('Update starts the helper for the version found only, newer than the running one: never a downgrade', async (t) => {
  const { ws, lock } = await setup(t);
  const f = fakeInstaller();
  setInstallerForTests(f.installer, 'npm');
  setLatestSourceForTests(async () => next);
  let s = await checkNow(ws);
  assert.deepEqual([s.can_install, s.install_blocked, s.installing], [true, null, false]);
  await assert.rejects(install(bump(next, [0, 0, 1]), ws), /only the version the check found/, 'not a version the check did not find');
  await assert.rejects(install('latest', ws), /only the version the check found/);
  await assert.rejects(install(`${next} && rm x`, ws), /only the version the check found/);
  for (const older of [current, '0.0.1']) {
    setLatestSourceForTests(async () => older);
    await checkNow(ws);
    assert.equal((await updateStatus(ws)).can_install, false, older);
    await assert.rejects(install(older, ws), /never goes back/, older);
  }
  assert.deepEqual(f.asked, [], 'nothing was started');

  setLatestSourceForTests(async () => next);
  await checkNow(ws);
  s = await install(next, ws);
  assert.deepEqual(f.asked, [{ version: next, from: current, workspace: ws }]);
  assert.deepEqual([s.current, s.installing, s.can_install], [current, true, false], 'the dashboard restarts on the new version; until then it is going');
  assert.equal(JSON.parse(await fsp.readFile(lock, 'utf-8')).version, next, 'the lock names the update and its helper');
  await assert.rejects(install(next, ws), /being installed already/);
  assert.throws(refuseWhileUpdating, /restarting for an update/, 'no new run or recording starts while the dashboard stops');
});

test('never older than the version installed on disk either, and nothing when that can\'t be read', async (t) => {
  const { ws } = await setup(t);
  const f = fakeInstaller({ disk: bump(next, [0, 1, 0]) });
  setInstallerForTests(f.installer, 'npm');
  setLatestSourceForTests(async () => next);
  await checkNow(ws);
  assert.equal((await updateStatus(ws)).can_install, false, 'a newer copy was installed meanwhile');
  await assert.rejects(install(next, ws), /not newer than the installed/);
  f.fake.disk = 'unknown';
  await assert.rejects(install(next, ws), /could not be read/);
  assert.deepEqual(f.asked, []);
});

test('two Update clicks at once start one update; a lock from another dashboard is respected, a dead one taken over', async (t) => {
  const { ws, lock } = await setup(t);
  const f = fakeInstaller({ slow: 50 });
  setInstallerForTests(f.installer, 'npm');
  setLatestSourceForTests(async () => next);
  await checkNow(ws);
  const both = await Promise.allSettled([install(next, ws), install(next, ws)]);
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(f.asked.length, 1, 'one helper');

  setInstallerForTests(f.installer, 'npm');
  await fsp.writeFile(lock, JSON.stringify({ pid: process.pid, version: next, at: new Date().toISOString() }));
  const s = await updateStatus(ws);
  assert.deepEqual([s.installing, s.can_install], [true, false], 'another dashboard\'s update is seen');
  await assert.rejects(install(next, ws), /being installed already/);
  await fsp.writeFile(lock, JSON.stringify({ pid: process.pid, version: next, at: new Date(Date.now() - 31 * 60_000).toISOString() }));
  assert.equal((await updateStatus(ws)).installing, false, 'a lock older than an update takes does not count, whatever has its process number now');
  await fsp.writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, version: next, at: new Date().toISOString() }));
  const gone = await updateStatus(ws);
  assert.equal(gone.installing, false, 'a lock whose process is gone does not count');
  assert.match(gone.install_error ?? '', /stopped half way/, 'and says the update was stopped half way');
  await fsp.writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, npm: 'running', npm_pid: process.pid, version: next, at: new Date(Date.now() - 3 * 3600_000).toISOString() }));
  assert.equal((await updateStatus(ws)).installing, true, 'npm still running after its helper was stopped, however long ago: no second npm over it');
  await assert.rejects(install(next, ws), /being installed already/);
  if (process.platform !== 'win32') {
    // The helper (a process group's leader) was stopped while npm, in its group, still runs, its pid never recorded:
    // the group says the update is going, however long ago it started.
    const { spawn } = await import('node:child_process');
    const leader = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' }).unref(); setTimeout(() => process.exit(0), 300)"], { detached: true, stdio: 'ignore' });
    t.after(() => { try { process.kill(-leader.pid!, 'SIGKILL'); } catch { /* gone */ } });
    await new Promise((r) => leader.once('exit', r));
    await fsp.writeFile(lock, JSON.stringify({ pid: leader.pid, npm: 'starting', version: next, at: new Date(Date.now() - 3 * 3600_000).toISOString() }));
    const left = await updateStatus(ws);
    assert.deepEqual([left.installing, left.can_install], [true, false], 'npm left from a stopped helper still counts');
    await assert.rejects(install(next, ws), /being installed already/);
    process.kill(-leader.pid!, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    const over = await updateStatus(ws);
    assert.equal(over.installing, false, 'once nothing of it runs, it is over');
    assert.match(over.install_error ?? '', /stopped half way/);
  }
  await fsp.writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, version: next, at: new Date().toISOString() }));
  await install(next, ws);
  assert.equal(f.asked.length, 2);
});

test('Update is refused while something important runs, or where npm can\'t update from here, and says why', async (t) => {
  const { ws } = await setup(t);
  const f = fakeInstaller();
  setInstallerForTests(f.installer, 'npm');
  setLatestSourceForTests(async () => next);
  await checkNow(ws);
  await fsp.writeFile(path.join(ws, '.situation-board', 'runs', 'CU-2026-0001.json'), JSON.stringify({ status: 'running', pid: process.pid }));
  const s = await updateStatus(ws);
  assert.deepEqual([s.can_install, s.install_blocked], [false, 'An AI tool run is going']);
  await assert.rejects(install(next, ws), /An AI tool run is going: update when it is done/);
  await fsp.rm(path.join(ws, '.situation-board', 'runs', 'CU-2026-0001.json'));
  // A recording admitted but not saved yet is counted too.
  const release = beginStart('A recording is starting');
  await assert.rejects(install(next, ws), /A recording is starting/);
  release();
  const switching = beginStart('A workspace switch is going');
  await assert.rejects(install(next, ws), /A workspace switch is going/);
  switching();
  await assert.rejects(install(next, path.join(ws, 'other')), /workspace changed meanwhile/, 'the workspace to restart on is the one open now');
  assert.deepEqual(f.asked, []);

  const blocked = fakeInstaller({ blocked: 'This dashboard was not started with gtd start in the background, so it can\'t restart itself' });
  setInstallerForTests(blocked.installer, 'npm');
  const b = await updateStatus(ws);
  assert.equal(b.can_install, false);
  assert.match(b.install_blocked ?? '', /can't restart itself/);
  assert.equal(b.commands[0], `npm install -g @bertonha/getthingsdone@${next}`, 'the commands are the way then');
  await assert.rejects(install(next, ws), /can't restart itself/);
  await assert.rejects(install(next, null), /No workspace is open/);
  assert.deepEqual(blocked.asked, []);

  for (const kind of ['npm-local', 'npx', 'source', 'desktop'] as const) {
    setInstallerForTests(fakeInstaller().installer, kind);
    assert.equal((await updateStatus(ws)).can_install, false, kind);
    await assert.rejects(install(next, ws), /Only a global npm install/, kind);
  }
});

test('a dashboard does not start while an update replaces its install, except the one the update starts', async (t) => {
  const { lock } = await setup(t);
  const unregister = registerRuntime(3001);
  const root = JSON.parse(await fsp.readFile(path.join(path.dirname(lock), 'runtimes', `${process.pid}.json`), 'utf-8')).root;
  unregister();
  const { spawn } = await import('node:child_process');
  const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
  t.after(() => { helper.kill(); });
  await fsp.writeFile(lock, JSON.stringify({ pid: helper.pid, version: next, at: new Date().toISOString(), root }));
  assert.throws(() => admitRuntime(3005), /being updated to/);
  assert.equal(fs.existsSync(path.join(path.dirname(lock), 'runtimes', `${process.pid}.json`)), false, 'not left registered');
  process.env['GTD_UPDATE_HELPER'] = String(helper.pid);
  admitRuntime(3005)();
  delete process.env['GTD_UPDATE_HELPER'];
  await fsp.writeFile(lock, JSON.stringify({ pid: helper.pid, version: next, at: new Date().toISOString(), root: '/another/install' }));
  admitRuntime(3005)();
});

test('on Windows an update stopped while npm ran blocks updates and starts until its lock is removed by hand', async (t) => {
  const { ws, lock, result } = await setup(t);
  setInstallerForTests(fakeInstaller().installer, 'npm');
  setLatestSourceForTests(async () => next);
  await checkNow(ws);
  const unregister = registerRuntime(3001);
  const root = JSON.parse(await fsp.readFile(path.join(path.dirname(lock), 'runtimes', `${process.pid}.json`), 'utf-8')).root;
  unregister();
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => { Object.defineProperty(process, 'platform', platform); });
  await fsp.writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, npm: 'unresolved', version: next, at: new Date(Date.now() - 5 * 24 * 3600_000).toISOString(), root }));
  // A result written after it says nothing about whether npm stopped.
  await fsp.writeFile(result, JSON.stringify({ version: next, from: current, ok: false, error: 'stopped', upgrade_error: null, repaired: false, restarted: false, start_error: null, port: null, finished_at: new Date().toISOString() }));
  const s = await updateStatus(ws);
  assert.equal(s.can_install, false);
  assert.match(s.install_blocked ?? '', /delete .*update\.lock/);
  await assert.rejects(install(next, ws), /stopped while npm ran/);
  assert.throws(() => admitRuntime(3005), (err: Error) => /stopped while npm ran/.test(err.message) && err.message.includes(lock), 'a dashboard does not start either, and says how to recover');
  await fsp.rm(lock);
  admitRuntime(3005)();
  assert.equal((await updateStatus(ws)).can_install, true, 'removed by hand: updates again');
});

test('before the desktop app restarts to update, the server closes admission and checks again what runs', async (t) => {
  const { ws } = await setup(t);
  setInstallerForTests(fakeInstaller().installer, 'npm');
  await assert.rejects(prepareDesktopRestart(ws), /Only the desktop app/);
  setInstallerForTests(fakeInstaller().installer, 'desktop');
  await fsp.writeFile(path.join(ws, '.situation-board', 'runs', 'CU-2026-0001.json'), JSON.stringify({ status: 'running', pid: process.pid }));
  await assert.rejects(prepareDesktopRestart(ws), /An AI tool run is going: restart to update when it is done/);
  assert.doesNotThrow(refuseWhileUpdating, 'refused: admission is open again');
  await fsp.rm(path.join(ws, '.situation-board', 'runs', 'CU-2026-0001.json'));
  await prepareDesktopRestart(ws);
  assert.throws(refuseWhileUpdating, /restarting for an update/, 'ready: nothing new starts');
  assert.throws(() => beginStart('A recording is starting'), /restarting for an update/);
  cancelDesktopRestart();
  assert.doesNotThrow(refuseWhileUpdating, 'the restart did not go ahead: open again');
});

test('an earlier restart try never opens a later one\'s hold', async (t) => {
  const { ws } = await setup(t);
  setInstallerForTests(fakeInstaller().installer, 'desktop');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await prepareDesktopRestart(ws); // try A: its timer would open admission a minute later
  cancelDesktopRestart();
  t.mock.timers.tick(30_000);
  await prepareDesktopRestart(ws); // try B
  t.mock.timers.tick(30_000); // A's minute is up
  assert.throws(refuseWhileUpdating, /restarting for an update/, 'still closed for B');
  t.mock.timers.tick(30_000); // B's minute is up
  assert.doesNotThrow(refuseWhileUpdating, 'B\'s own timer opens it');
});

test('another dashboard running from the same install is known, until it stops', async (t) => {
  await setup(t);
  const { spawn } = await import('node:child_process');
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
  t.after(() => { other.kill(); });
  const mine = registerRuntime(3001);
  assert.deepEqual(otherRuntimes(), [], 'this dashboard is not another one');
  const dir = path.join(path.dirname(process.env['GTD_UPDATES_PATH']!), 'runtimes');
  const root = JSON.parse(await fsp.readFile(path.join(dir, `${process.pid}.json`), 'utf-8')).root;
  await fsp.writeFile(path.join(dir, `${other.pid}.json`), JSON.stringify({ pid: other.pid, port: 3002, root }));
  await fsp.writeFile(path.join(dir, '7.json'), JSON.stringify({ pid: other.pid, port: 3003, root: '/another/install' }));
  assert.deepEqual(otherRuntimes(), [3002], 'only one running from this install');
  other.kill();
  await new Promise((r) => other.once('exit', r));
  assert.deepEqual(otherRuntimes(), [], 'gone once it stopped');
  mine();
  assert.equal(fs.existsSync(path.join(dir, `${process.pid}.json`)), false);
});

test('after a restart the helper\'s result is said: why it failed (the old version runs), or what is left to do', async (t) => {
  const { ws, result } = await setup(t);
  setInstallerForTests(fakeInstaller().installer, 'npm');
  setLatestSourceForTests(async () => next);
  await checkNow(ws);
  const wrote = (r: object) => fsp.writeFile(result, JSON.stringify({ version: next, from: current, ok: false, error: null, upgrade_error: null, restarted: true, start_error: null, finished_at: new Date().toISOString(), ...r }));
  await wrote({ error: 'EBUSY: resource busy or locked' });
  let s = await updateStatus(ws);
  assert.deepEqual([s.install_error, s.updated, s.can_install], ['EBUSY: resource busy or locked', null, true], 'it can be tried again');
  await wrote({ error: 'EBUSY', repaired: true, restarted: false, start_error: 'port in use' });
  assert.equal((await updateStatus(ws)).install_error, `EBUSY ${current} was put back. Starting the dashboard did not work either (port in use).`);
  await wrote({ version: current, from: '0.0.1', ok: false, error: 'npm finished, but the version installed is 0.0.2' });
  assert.match((await updateStatus(ws)).install_error ?? '', /0\.0\.2/, 'a failure is said whatever version started');
  await wrote({ version: current, from: '0.0.1', ok: true, upgrade_error: 'a file is locked' });
  s = await updateStatus(ws);
  assert.match(s.install_error ?? '', /Run gtd upgrade/);
  assert.equal(s.updated, current);
  await wrote({ version: current, from: '0.0.1', ok: true, finished_at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString() });
  assert.deepEqual([(await updateStatus(ws)).updated, (await updateStatus(ws)).install_error], [null, null], 'an old result is not said again');
});

test('npm is run with fixed arguments for that exact version, into its global folder', () => {
  assert.deepEqual(npmInstallArgs('1.2.3'), ['install', '--global', '@bertonha/getthingsdone@1.2.3', '--update-notifier=false', '--no-audit', '--no-fund', '--no-progress']);
  for (const bad of ['latest', '1.2.3 --prefix=/tmp', '1.2', '']) assert.throws(() => npmInstallArgs(bad), /Not a version/, bad);
  assert.deepEqual(globalDirs('/opt/homebrew', 'darwin'), { modules: path.join('/opt/homebrew', 'lib', 'node_modules'), bin: path.join('/opt/homebrew', 'bin') });
  assert.deepEqual(globalDirs('C:\\Users\\a\\AppData\\Roaming\\npm', 'win32').bin, 'C:\\Users\\a\\AppData\\Roaming\\npm');
});

/** npm's own script next to this node, as the app finds it; tests that run real npm are skipped without it. */
function npmNextToNode(): string | null {
  const bin = path.dirname(fs.realpathSync(process.execPath));
  return [path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(bin, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    .find((c) => fs.existsSync(c)) ?? null;
}

test('real npm asks the user\'s registry one question, and nothing else (no update notice of its own)', { skip: npmNextToNode() ? false : 'npm is not next to this node' }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-registry-'));
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (/getthingsdone/.test(req.url ?? '')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ name: '@bertonha/getthingsdone', 'dist-tags': { latest: '9.9.9' }, versions: { '9.9.9': { name: '@bertonha/getthingsdone', version: '9.9.9' } } }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const keep = Object.fromEntries(['npm_config_registry', 'npm_config_cache', 'npm_config_userconfig', 'npm_config_update_notifier'].map((k) => [k, process.env[k]]));
  t.after(async () => {
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await new Promise((r) => server.close(r));
    await fsp.rm(dir, { recursive: true, force: true });
  });
  process.env['npm_config_registry'] = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  process.env['npm_config_cache'] = path.join(dir, 'cache');
  process.env['npm_config_userconfig'] = path.join(dir, 'npmrc');
  // npm would otherwise check for its own update now: the notifier is on and has never run in this cache.
  delete process.env['npm_config_update_notifier'];
  assert.equal(await npmLatest(npmNextToNode()), '9.9.9');
  assert.deepEqual(seen.map((s) => s.replace(/%2f/i, '/')), ['GET /@bertonha/getthingsdone'], 'one request, for this package only');
});

test('the helper waits for the dashboard to stop, installs with real npm, upgrades and starts; when npm fails the old version starts again', { skip: npmNextToNode() ? false : 'npm is not next to this node' }, async (t) => {
  const cli = npmNextToNode()!;
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-install-')));
  const { execFileSync, spawn } = await import('node:child_process');
  const crypto = await import('node:crypto');
  // Two fictional versions of the package, packed as npm would publish them. Their gtd command records how it was run.
  const calls = path.join(dir, 'calls.log');
  const tarballs: Record<string, Buffer> = {};
  for (const version of ['1.0.0', '9.9.9']) {
    const pkg = path.join(dir, `src-${version}`);
    await fsp.mkdir(path.join(pkg, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@bertonha/getthingsdone', version, bin: { gtd: './bin/gtd.js' } }));
    // gtd start records "the dashboard" as gtd start does: this test's process stands in for it.
    await fsp.writeFile(path.join(pkg, 'bin', 'gtd.js'), `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(calls)}, '${version} ' + process.argv.slice(2).join(' ') + ' ' + (process.env.ESB_WORKSPACE_PATH || '-') + '\\n');
if (process.argv[2] === 'start' && fs.existsSync(${JSON.stringify(path.join(dir, 'fail-start'))}) && '${version}' === '9.9.9') process.exit(1);
if (process.argv[2] === 'start') fs.writeFileSync(${JSON.stringify(path.join(dir, 'gtd.pid'))}, JSON.stringify({ pid: ${process.pid}, port: Number(process.argv[5]), workspace: process.env.ESB_WORKSPACE_PATH }));
`);
    const name = execFileSync(process.execPath, [cli, 'pack', '--pack-destination', dir, '--update-notifier=false'], { cwd: pkg, encoding: 'utf-8', env: { ...process.env, npm_config_cache: path.join(dir, 'pack-cache') } }).trim().split('\n').pop()!;
    tarballs[version] = await fsp.readFile(path.join(dir, name));
  }
  let broken = false;
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const tar = /\/-\/getthingsdone-(\d+\.\d+\.\d+)\.tgz$/.exec(req.url ?? '');
    if (tar) {
      if (broken && tar[1] === '9.9.9') { res.statusCode = 500; res.end(); return; }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(tarballs[tar[1]!]);
      return;
    }
    if (/getthingsdone/.test(req.url ?? '')) {
      const versions = Object.fromEntries(Object.entries(tarballs).map(([v, b]) => [v, {
        name: '@bertonha/getthingsdone', version: v, bin: { gtd: './bin/gtd.js' },
        dist: { tarball: `${base}/@bertonha/getthingsdone/-/getthingsdone-${v}.tgz`, shasum: crypto.createHash('sha1').update(b).digest('hex'), integrity: `sha512-${crypto.createHash('sha512').update(b).digest('base64')}` },
      }]));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ name: '@bertonha/getthingsdone', 'dist-tags': { latest: '9.9.9' }, versions }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const keep = Object.fromEntries(['npm_config_registry', 'npm_config_cache', 'npm_config_userconfig', 'npm_config_prefix', 'npm_config_fetch_retries'].map((k) => [k, process.env[k]]));
  const prefix = path.join(dir, 'prefix');
  t.after(async () => {
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await new Promise((r) => server.close(r));
    await fsp.chmod(globalDirs(prefix).modules, 0o755).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  });
  process.env['npm_config_registry'] = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  process.env['npm_config_cache'] = path.join(dir, 'cache');
  process.env['npm_config_userconfig'] = path.join(dir, 'npmrc');
  process.env['npm_config_prefix'] = prefix;
  process.env['npm_config_fetch_retries'] = '0';
  const { modules } = globalDirs(prefix);
  const copy = path.join(modules, '@bertonha', 'getthingsdone');
  const version = async () => JSON.parse(await fsp.readFile(path.join(copy, 'package.json'), 'utf-8')).version;
  // Asynchronously: the registry answering npm runs in this process.
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const execFileP = promisify(execFile);
  await execFileP(process.execPath, [cli, ...npmInstallArgs('1.0.0')], { env: process.env, timeout: 60_000 });
  assert.equal(await version(), '1.0.0');
  assert.equal(await npmInstallBlocked(cli, copy), null, 'this copy, in a writable global folder');
  assert.match(await npmInstallBlocked(cli, path.join(dir, 'src-1.0.0')) ?? '', /not the one in npm's global folder/, 'npm would install somewhere else');

  const ws = path.join(dir, 'workspace');
  await fsp.mkdir(ws);
  /** Runs the helper as the dashboard would, waiting for `dashboard` to end, and returns what it wrote. */
  const helper = async (dashboard: number) => {
    const resultFile = path.join(dir, 'update-result.json');
    await fsp.rm(resultFile, { force: true });
    const helperPid = startUpdateHelper({ waitPid: dashboard, version: '9.9.9', from: '1.0.0', node: process.execPath, npmCli: cli, npmArgs: npmInstallArgs('9.9.9'), repairArgs: npmInstallArgs('1.0.0'),
      packageJson: path.join(copy, 'package.json'), bin: path.join(copy, 'bin', 'gtd.js'), workspace: ws, port: 3999,
      resultFile, lockFile: path.join(dir, 'update.lock'), logFile: path.join(dir, 'update.log'), pidFile: path.join(dir, 'gtd.pid'),
      runtimesDir: path.join(dir, 'runtimes'), root: copy });
    // Handed over as the dashboard does.
    await fsp.writeFile(path.join(dir, 'update.lock'), JSON.stringify({ pid: helperPid, version: '9.9.9', at: new Date().toISOString(), root: copy }));
    for (let i = 0; i < 600 && !fs.existsSync(resultFile); i++) await new Promise((r) => setTimeout(r, 100));
    return JSON.parse(await fsp.readFile(resultFile, 'utf-8')) as { ok: boolean; error: string | null; restarted: boolean; repaired: boolean; port: number | null };
  };
  // A stand-in dashboard: nothing is installed until it has ended.
  const dashboard = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)']);
  broken = true;
  let r = await helper(dashboard.pid!);
  assert.equal(dashboard.exitCode !== null || dashboard.signalCode !== null, true, 'it waited for the dashboard');
  assert.deepEqual([r.ok, r.restarted, r.repaired, r.port], [false, true, false, 3999]);
  assert.ok(r.error, 'npm\'s reason is kept');
  assert.equal(await version(), '1.0.0', 'a failed download leaves the installed version as it was');
  assert.deepEqual((await fsp.readFile(calls, 'utf-8')).trim().split('\n'), [`1.0.0 start --no-open --port 3999 ${ws}`], 'the version that was running starts again, in the same workspace');

  // npm fails with the package left unusable: the version that was running is installed again, then started.
  await fsp.rm(calls);
  await fsp.rm(path.join(copy, 'bin', 'gtd.js'));
  r = await helper(2 ** 22 + 12345);
  assert.deepEqual([r.ok, r.repaired, r.restarted], [false, true, true]);
  assert.equal(await version(), '1.0.0');
  assert.deepEqual((await fsp.readFile(calls, 'utf-8')).trim().split('\n'), [`1.0.0 start --no-open --port 3999 ${ws}`]);

  // The installed version changed after the dashboard checked: nothing replaced, the dashboard starts again.
  await fsp.rm(calls);
  const pkgJson = path.join(copy, 'package.json');
  const original = await fsp.readFile(pkgJson, 'utf-8');
  await fsp.writeFile(pkgJson, original.replace('"1.0.0"', '"1.5.0"'));
  r = await helper(2 ** 22 + 12345);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /changed to 1\.5\.0/);
  await fsp.writeFile(pkgJson, original);

  broken = false;
  await fsp.rm(calls, { force: true });
  r = await helper(2 ** 22 + 12345);
  assert.deepEqual([r.ok, r.error, r.restarted], [true, null, true]);
  assert.equal(await version(), '9.9.9');
  assert.deepEqual((await fsp.readFile(calls, 'utf-8')).trim().split('\n'), [`9.9.9 upgrade --dir ${ws} -`, `9.9.9 start --no-open --port 3999 ${ws}`], 'the new version upgrades the workspace and starts on it');
  assert.equal(fs.existsSync(path.join(dir, 'update.lock')), false, 'the lock is let go');

  // The new version installs but does not start: the version that was running is put back and started.
  await execFileP(process.execPath, [cli, ...npmInstallArgs('1.0.0')], { env: process.env, timeout: 60_000 });
  await fsp.rm(calls);
  await fsp.writeFile(path.join(dir, 'fail-start'), '');
  r = await helper(2 ** 22 + 12345);
  assert.deepEqual([r.ok, r.repaired, r.restarted], [false, true, true]);
  assert.match(r.error ?? '', /9\.9\.9 was installed but did not start/);
  assert.equal(await version(), '1.0.0');
  assert.deepEqual((await fsp.readFile(calls, 'utf-8')).trim().split('\n'), [`9.9.9 upgrade --dir ${ws} -`, `9.9.9 start --no-open --port 3999 ${ws}`, `1.0.0 start --no-open --port 3999 ${ws}`]);
  await fsp.rm(path.join(dir, 'fail-start'));

  await fsp.rm(copy, { recursive: true });
  await fsp.symlink(path.join(dir, 'src-1.0.0'), copy);
  assert.match(await npmInstallBlocked(cli, path.join(dir, 'src-1.0.0')) ?? '', /not the one/, 'a package linked from elsewhere is not updated in place');
  await fsp.rm(copy);
  await fsp.mkdir(copy);
  if (process.getuid?.() !== 0 && process.platform !== 'win32') {
    await fsp.chmod(path.join(modules, '@bertonha'), 0o555);
    assert.match(await npmInstallBlocked(cli, copy) ?? '', /can't be written/, 'the package\'s scope folder too');
    await fsp.chmod(path.join(modules, '@bertonha'), 0o755);
    await fsp.chmod(modules, 0o555);
    assert.match(await npmInstallBlocked(cli, copy) ?? '', /can't be written/, 'a folder the user can\'t write');
  }
});

test('an unreadable run directory blocks updates instead of treating activity as idle', async (t) => {
  const { ws } = await setup(t);
  const f = fakeInstaller();
  setInstallerForTests(f.installer, 'npm');
  setLatestSourceForTests(async () => next);
  await checkNow(ws);
  const runs = path.join(ws, '.situation-board', 'runs');
  await fsp.rm(runs, { recursive: true });
  await fsp.writeFile(runs, 'fictional damaged directory');
  const status = await updateStatus(ws);
  assert.equal(status.can_install, false);
  assert.match(status.busy ?? '', /could not be checked/);
  await assert.rejects(install(next, ws), /could not be checked/);
  assert.deepEqual(f.asked, []);
  setInstallerForTests(f.installer, 'desktop');
  await assert.rejects(prepareDesktopRestart(ws), /could not be checked/);
  assert.doesNotThrow(refuseWhileUpdating, 'failed preparation reopens admission');
});

test('an unreadable meeting queue blocks update restarts', async (t) => {
  const { ws } = await setup(t);
  const f = fakeInstaller();
  setInstallerForTests(f.installer, 'npm');
  setLatestSourceForTests(async () => next);
  await checkNow(ws);
  await fsp.mkdir(path.join(ws, 'context-updates'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'context-updates', 'meeting-queue'), 'fictional damaged queue');
  assert.match((await updateStatus(ws)).busy ?? '', /could not be checked/);
  await assert.rejects(install(next, ws), /could not be checked/);
  assert.deepEqual(f.asked, []);
});
