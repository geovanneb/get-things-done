import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { MANIFEST_RELATIVE_PATH, readManifest, scaffoldWorkspace, upgradeWorkspace } from '../src/services/scaffold';
import { acknowledgeInstructionUpdate, compareInstructionUpdate, listInstructionUpdates } from '../src/services/instructionUpdates';
import { tryLock, unlock } from '../src/utils/fileLock';

const opts = { profile: { name: 'Alex Morgan', role: 'COO', organization: 'Northwind Labs' }, aiTools: ['codex' as const] };
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const status = (code: number) => (err: Error & { statusCode?: number }) => err.statusCode === code;

/** A workspace where the user changed AGENTS.md, after an upgrade wrote the app's version beside it. */
async function changed(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-instruction-updates-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  scaffoldWorkspace(dir, opts);
  const file = path.join(dir, 'AGENTS.md');
  const app = await fsp.readFile(file, 'utf8');
  await fsp.writeFile(file, `${app}\nMy own rule.\n`);
  // The app's version as an earlier release had it, so this release finds the file changed and writes its .new.
  const manifest = readManifest(dir)!;
  manifest.files.find((f) => f.path === 'AGENTS.md')!.sha256 = sha('an earlier release');
  await fsp.writeFile(path.join(dir, MANIFEST_RELATIVE_PATH), JSON.stringify(manifest));
  assert.ok(upgradeWorkspace(dir, opts).conflicted.includes('AGENTS.md'));
  return { dir, file, app };
}

test('a changed app file is listed, compared, and "I merged it" stops the .new until the app changes it again', async (t) => {
  const { dir, file, app } = await changed(t);

  const listed = await listInstructionUpdates(dir);
  assert.deepEqual(listed.map((u) => [u.path, u.state]), [['AGENTS.md', 'ready']]);
  const compared = await compareInstructionUpdate(dir, 'AGENTS.md');
  assert.equal(compared.app, app);
  assert.match(compared.mine, /My own rule\./);
  await assert.rejects(compareInstructionUpdate(dir, '../outside.md'), status(404), 'only listed files');

  // What the user compared must still be what is there.
  await assert.rejects(acknowledgeInstructionUpdate(dir, { path: 'AGENTS.md', mine_sha256: 'x', app_sha256: listed[0]!.app_sha256 }), status(409));
  assert.deepEqual(await acknowledgeInstructionUpdate(dir, { path: 'AGENTS.md', mine_sha256: listed[0]!.mine_sha256, app_sha256: listed[0]!.app_sha256 }), []);
  await assert.rejects(fsp.access(`${file}.new`), 'the app\'s own copy is removed');
  assert.match(await fsp.readFile(file, 'utf8'), /My own rule\./, 'the user\'s file is never written');
  assert.equal(readManifest(dir)!.files.find((f) => f.path === 'AGENTS.md')!.merged_sha256, sha(app));

  // The next start: no .new, reported as merged.
  const again = upgradeWorkspace(dir, opts);
  assert.deepEqual([again.merged, again.conflicted.includes('AGENTS.md')], [['AGENTS.md'], false]);
  await assert.rejects(fsp.access(`${file}.new`));

  // A later release changes the file: the acknowledgement no longer holds and the .new comes back.
  const manifest = readManifest(dir)!;
  manifest.files.find((f) => f.path === 'AGENTS.md')!.merged_sha256 = sha('an earlier release');
  await fsp.writeFile(path.join(dir, MANIFEST_RELATIVE_PATH), JSON.stringify(manifest));
  assert.ok(upgradeWorkspace(dir, opts).conflicted.includes('AGENTS.md'));
  await fsp.access(`${file}.new`);
});

test('a .new the user changed, or a link in its place, is shown as edited and never removed', async (t) => {
  const { dir, file, app } = await changed(t);
  await fsp.writeFile(`${file}.new`, `${app}\nHalf merged.\n`);
  const [row] = await listInstructionUpdates(dir);
  assert.equal(row!.state, 'edited');
  await assert.rejects(acknowledgeInstructionUpdate(dir, { path: 'AGENTS.md', mine_sha256: row!.mine_sha256, app_sha256: row!.app_sha256 }), status(409));
  assert.match(await fsp.readFile(`${file}.new`, 'utf8'), /Half merged\./);

  if (process.platform !== 'win32') {
    const target = path.join(dir, 'my-merge.md');
    await fsp.writeFile(target, app);
    await fsp.rm(`${file}.new`);
    await fsp.symlink(target, `${file}.new`);
    assert.equal((await listInstructionUpdates(dir))[0]!.state, 'edited', 'a link is not the app\'s copy, even with its text');
    assert.ok((await fsp.lstat(`${file}.new`)).isSymbolicLink());
  }
});

test('without a .new it can still be marked merged; an interrupted removal is finished by the next upgrade', async (t) => {
  const { dir, file } = await changed(t);
  await fsp.rm(`${file}.new`);
  const [row] = await listInstructionUpdates(dir);
  assert.equal(row!.state, 'no_copy');
  await acknowledgeInstructionUpdate(dir, { path: 'AGENTS.md', mine_sha256: row!.mine_sha256, app_sha256: row!.app_sha256 });
  assert.deepEqual(await listInstructionUpdates(dir), []);

  // Interrupted after the record, before the removal: the app's own unchanged copy goes on the next start.
  const app = await fsp.readFile(`${file}`, 'utf8').then(() => compareInstructionUpdate(dir, 'AGENTS.md').catch(() => null));
  assert.equal(app, null, 'nothing listed any more');
  const manifest = readManifest(dir)!;
  const entry = manifest.files.find((f) => f.path === 'AGENTS.md')!;
  const current = entry.sha256;
  await fsp.writeFile(`${file}.new`, (await import('../src/services/scaffold')).appFileVersions(dir).get('AGENTS.md')!.content);
  entry.new_sha256 = current;
  await fsp.writeFile(path.join(dir, MANIFEST_RELATIVE_PATH), JSON.stringify(manifest));
  upgradeWorkspace(dir, opts);
  await assert.rejects(fsp.access(`${file}.new`));
});

test('"I merged it" waits for an upgrade in progress', async (t) => {
  const { dir } = await changed(t);
  const [row] = await listInstructionUpdates(dir);
  const held = await tryLock(path.join(dir, '.situation-board', 'upgrade.lock'));
  assert.notEqual(typeof held, 'string');
  try {
    await assert.rejects(acknowledgeInstructionUpdate(dir, { path: 'AGENTS.md', mine_sha256: row!.mine_sha256, app_sha256: row!.app_sha256 }), status(409));
  } finally {
    await unlock(held as Exclude<typeof held, string>);
  }
  assert.equal((await listInstructionUpdates(dir))[0]!.state, 'ready', 'nothing changed');
});

test('a linked .situation-board is refused, and nothing outside the workspace is written', { skip: process.platform === 'win32' ? 'symlinks need privileges' : false }, async (t) => {
  const { dir } = await changed(t);
  const [row] = await listInstructionUpdates(dir);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-iu-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  await fsp.cp(path.join(dir, '.situation-board'), outside, { recursive: true });
  await fsp.rm(path.join(dir, '.situation-board'), { recursive: true });
  await fsp.symlink(outside, path.join(dir, '.situation-board'));
  const before = await fsp.readFile(path.join(outside, 'app-manifest.json'), 'utf8');
  // Listing does not follow it either: nothing is the app's copy, so nothing offers to be marked merged.
  assert.deepEqual((await listInstructionUpdates(dir)).map((u) => u.state), ['edited']);
  await assert.rejects(acknowledgeInstructionUpdate(dir, { path: 'AGENTS.md', mine_sha256: row!.mine_sha256, app_sha256: row!.app_sha256 }), status(409));
  assert.equal(await fsp.readFile(path.join(outside, 'app-manifest.json'), 'utf8'), before);
  await assert.rejects(fsp.access(path.join(outside, 'upgrade.lock')), 'no lock made outside');
});

test('a file too large to show is listed but not read for comparison', async (t) => {
  const { dir, file } = await changed(t);
  await fsp.writeFile(file, 'x'.repeat(600 * 1024));
  assert.deepEqual((await listInstructionUpdates(dir)).map((u) => u.path), ['AGENTS.md']);
  await assert.rejects(compareInstructionUpdate(dir, 'AGENTS.md'), status(413));
});

test('an interrupted removal is finished even when the file now equals the app version', async (t) => {
  const { dir, file, app } = await changed(t);
  const [row] = await listInstructionUpdates(dir);
  // Acknowledged, but the .new was not removed (interrupted); then the user takes the app version as it is.
  const manifest = readManifest(dir)!;
  manifest.files.find((f) => f.path === 'AGENTS.md')!.merged_sha256 = row!.app_sha256;
  await fsp.writeFile(path.join(dir, MANIFEST_RELATIVE_PATH), JSON.stringify(manifest));
  await fsp.writeFile(file, app);
  assert.ok(upgradeWorkspace(dir, opts).unchanged.includes('AGENTS.md'));
  await assert.rejects(fsp.access(`${file}.new`), 'the app\'s own copy is gone');
});
