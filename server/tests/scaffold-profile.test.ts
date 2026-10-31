import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { scaffoldWorkspace, upgradeWorkspace, readManifest, refreshAppFiles, newerVersion, MANIFEST_RELATIVE_PATH } from '../src/services/scaffold';

test('an organization name ending in a full stop is not followed by a second one', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-scaffold-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  scaffoldWorkspace(dir, { profile: { name: 'Alex Morgan', role: 'COO', organization: 'Northwind Labs Inc.' }, aiTools: ['codex'] });
  const agents = await fsp.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /\*\*Alex Morgan\*\* — COO at Northwind Labs Inc\.$/m);
  assert.doesNotMatch(agents, /Inc\.\./);
});

/** A workspace whose AGENTS.md still has the old profile line ("… at Northwind Labs Inc.."), recorded as app-written. */
async function oldWorkspace(t: { after: (fn: () => Promise<void>) => void }, userEdit = '') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-upgrade-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const opts = { profile: { name: 'Alex Morgan', role: 'COO', organization: 'Northwind Labs Inc.' }, aiTools: ['codex' as const] };
  scaffoldWorkspace(dir, opts);
  const file = path.join(dir, 'AGENTS.md');
  const old = (await fsp.readFile(file, 'utf8')).replace('COO at Northwind Labs Inc.', 'COO at Northwind Labs Inc..');
  const manifest = readManifest(dir)!;
  manifest.files.find((f) => f.path === 'AGENTS.md')!.sha256 = createHash('sha256').update(old).digest('hex');
  await fsp.writeFile(path.join(dir, MANIFEST_RELATIVE_PATH), JSON.stringify(manifest));
  await fsp.writeFile(file, old + userEdit);
  return { dir, file, opts };
}

test('gtd upgrade fixes the line in an untouched AGENTS.md and keeps an edited one', async (t) => {
  const untouched = await oldWorkspace(t);
  assert.ok(upgradeWorkspace(untouched.dir, untouched.opts).updated.includes('AGENTS.md'));
  assert.doesNotMatch(await fsp.readFile(untouched.file, 'utf8'), /Inc\.\./);

  const edited = await oldWorkspace(t, '\nMy own note.\n');
  assert.ok(upgradeWorkspace(edited.dir, edited.opts).conflicted.includes('AGENTS.md'));
  assert.match(await fsp.readFile(edited.file, 'utf8'), /My own note\./);
  assert.doesNotMatch(await fsp.readFile(`${edited.file}.new`, 'utf8'), /Inc\.\./);
});

test('routine placeholders stay as written, and gtd upgrade repairs files that had the date filled in', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-placeholders-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const opts = { profile: { name: 'Alex Morgan', role: 'COO', organization: 'Northwind Labs' }, aiTools: ['claude-code' as const, 'codex' as const, 'copilot' as const] };
  scaffoldWorkspace(dir, opts);
  const files = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md', 'README.md', '.schemas/routine.schema.json'];
  for (const rel of files) {
    assert.match(await fsp.readFile(path.join(dir, rel), 'utf8'), /\{\{date\}\}/, rel);
  }

  // A workspace written by an earlier version had today's date in place of {{date}}.
  const manifest = readManifest(dir)!;
  for (const rel of files) {
    const filled = (await fsp.readFile(path.join(dir, rel), 'utf8')).replace(/\{\{date\}\}/g, '2026-01-15');
    await fsp.writeFile(path.join(dir, rel), filled);
    manifest.files.find((f) => f.path === rel)!.sha256 = createHash('sha256').update(filled).digest('hex');
  }
  await fsp.writeFile(path.join(dir, MANIFEST_RELATIVE_PATH), JSON.stringify(manifest));

  const result = upgradeWorkspace(dir, opts);
  for (const rel of files) {
    assert.ok(result.updated.includes(rel), rel);
    assert.match(await fsp.readFile(path.join(dir, rel), 'utf8'), /\{\{date\}\}/, rel);
  }
});

test('opening a workspace brings its files up to the app, with the profile and tools it has, and keeps your edits', async (t) => {
  const untouched = await oldWorkspace(t);
  const result = refreshAppFiles(untouched.dir)!;
  assert.ok(result.updated.includes('AGENTS.md'));
  assert.match(await fsp.readFile(untouched.file, 'utf8'), /\*\*Alex Morgan\*\* — COO at Northwind Labs Inc\.$/m, 'the name from the profile');
  assert.deepEqual(result.added, [], 'no tool the workspace did not have');
  assert.equal(await fsp.access(path.join(untouched.dir, 'CLAUDE.md')).then(() => true, () => false), false, 'Codex only: no Claude Code files');

  // A second opening changes nothing at all, the manifest included: a git workspace stays clean.
  const manifest = path.join(untouched.dir, MANIFEST_RELATIVE_PATH);
  const before = await fsp.readFile(manifest, 'utf8');
  assert.deepEqual(refreshAppFiles(untouched.dir)!.updated, []);
  assert.equal(await fsp.readFile(manifest, 'utf8'), before);
  assert.deepEqual((await fsp.readdir(untouched.dir)).filter((n) => n.endsWith('.tmp')), [], 'no temporary files left');
});

test('a file you changed is kept, and so is a .new you are merging', async (t) => {
  const edited = await oldWorkspace(t, '\nMy own note.\n');
  assert.ok(refreshAppFiles(edited.dir)!.conflicted.includes('AGENTS.md'));
  assert.match(await fsp.readFile(edited.file, 'utf8'), /My own note\./);
  const newFile = `${edited.file}.new`;
  await fsp.writeFile(newFile, 'User merge in progress');
  refreshAppFiles(edited.dir);
  assert.equal(await fsp.readFile(newFile, 'utf8'), 'User merge in progress');
});

test('an older app leaves a workspace alone, a quoted name reads back as written, and no tool is added', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-refresh-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  scaffoldWorkspace(dir, { profile: { name: 'Alex "Ace" Morgan', role: 'COO', organization: 'Northwind Labs' }, aiTools: ['codex'] });
  assert.deepEqual(refreshAppFiles(dir)!.updated, [], 'a fresh workspace needs nothing, whatever its name');

  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-refresh-'));
  t.after(() => fsp.rm(empty, { recursive: true, force: true }));
  scaffoldWorkspace(empty, { profile: { name: 'A', role: 'B', organization: 'C' }, aiTools: [] });
  assert.equal(refreshAppFiles(empty)!.added.includes('CLAUDE.md'), false);

  const manifest = path.join(dir, MANIFEST_RELATIVE_PATH);
  const newer = { ...readManifest(dir)!, appVersion: '99.0.0' };
  await fsp.writeFile(manifest, JSON.stringify(newer));
  await fsp.writeFile(path.join(dir, 'AGENTS.md'), 'From a newer app');
  assert.equal(refreshAppFiles(dir), null);
  assert.equal(await fsp.readFile(path.join(dir, 'AGENTS.md'), 'utf8'), 'From a newer app');
  assert.equal(newerVersion('0.10.0', '0.9.9'), true);
  assert.equal(newerVersion('0.8.0', '0.8.0'), false);
});

test('a rewritten file keeps its permissions, and a failure to write the .new is not taken for one already there', { skip: process.platform === 'win32' ? 'POSIX permissions' : false }, async (t) => {
  const untouched = await oldWorkspace(t);
  await fsp.chmod(untouched.file, 0o600);
  refreshAppFiles(untouched.dir);
  assert.equal((await fsp.stat(untouched.file)).mode & 0o777, 0o600);
  assert.deepEqual((await fsp.readdir(untouched.dir)).filter((n) => n.endsWith('.tmp')), []);

  const edited = await oldWorkspace(t, '\nMy own note.\n');
  await fsp.chmod(edited.dir, 0o500);
  try {
    assert.throws(() => refreshAppFiles(edited.dir), /EACCES|EPERM/);
  } finally {
    await fsp.chmod(edited.dir, 0o700);
  }
});

test('one writer at a time: a second refresh while the first holds the workspace is skipped', async (t) => {
  const { dir } = await oldWorkspace(t);
  const { tryLock, unlock } = await import('../src/utils/fileLock');
  const held = await tryLock(path.join(dir, '.situation-board', 'upgrade.lock'));
  assert.notEqual(typeof held, 'string');
  t.after(() => unlock(held as Exclude<typeof held, string>));
  const { refreshWorkspace } = await import('../src/services/workspaceRefresh');
  const outcome = await refreshWorkspace(dir);
  assert.equal(outcome.status, 'skipped');
  assert.match(await fsp.readFile(path.join(dir, 'AGENTS.md'), 'utf8'), /Inc\.\./, 'not touched');
});
