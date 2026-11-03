import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import { checkNow, compareVersions, dismiss, feedFile, installKind, isVersion, npmLatest, setAutoCheck, setLatestSourceForTests, updateStatus } from '../src/services/appUpdates';
import { getAppVersion } from '../src/services/scaffold';
import { RUN_RECORD } from '../src/services/watcherService';

/** A fresh state file, and the update environment restored afterwards. */
async function state(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-updates-'));
  const keep = Object.fromEntries(['GTD_UPDATES_PATH', 'GTD_INSTALL', 'GTD_UPDATES', 'GTD_UPDATE_CHANNEL', 'GTD_DISABLE_UPDATES'].map((k) => [k, process.env[k]]));
  process.env['GTD_UPDATES_PATH'] = path.join(dir, 'updates.json');
  t.after(async () => {
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    setLatestSourceForTests(null);
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
