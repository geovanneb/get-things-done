import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { MANIFEST_RELATIVE_PATH, readManifest, scaffoldWorkspace, upgradeWorkspace, type AppManifest } from '../src/services/scaffold';

const opts = { profile: { name: 'Alex Morgan', role: 'COO', organization: 'Northwind Labs' }, aiTools: ['codex' as const] };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function freshWorkspace(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-refresh-new-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  scaffoldWorkspace(dir, opts);
  const file = path.join(dir, 'AGENTS.md');
  return { dir, file, current: await fsp.readFile(file, 'utf8') };
}

/** Rewrites the manifest as a test needs it: what an earlier release would have left. */
async function editManifest(dir: string, change: (m: AppManifest) => void) {
  const manifest = readManifest(dir)!;
  change(manifest);
  await fsp.writeFile(path.join(dir, MANIFEST_RELATIVE_PATH), JSON.stringify(manifest));
}
const entry = (m: AppManifest) => m.files.find((f) => f.path === 'AGENTS.md')!;

test('a release before this one: its .new, still exactly as it wrote it, is replaced by the current version', async (t) => {
  const { dir, file, current } = await freshWorkspace(t);
  const earlier = `${current}\nA rule from the earlier release.\n`;
  // An older app recorded only the file's version, not its .new.
  await editManifest(dir, (m) => { delete m.newCopiesTracked; entry(m).sha256 = sha(earlier); });
  await fsp.writeFile(file, `${earlier}\nMy own note.\n`);
  await fsp.writeFile(`${file}.new`, earlier);

  assert.ok(upgradeWorkspace(dir, opts).conflicted.includes('AGENTS.md'));
  assert.match(await fsp.readFile(file, 'utf8'), /My own note\./, 'the user\'s file is kept');
  assert.equal(await fsp.readFile(`${file}.new`, 'utf8'), current);
  assert.equal(entry(readManifest(dir)!).new_sha256, sha(current), 'from now on it is tracked');
  assert.deepEqual((await fsp.readdir(dir)).filter((n) => n.endsWith('.tmp')), [], 'no temporary files left');
});

test('across releases, only the .new the app wrote is refreshed; one the user changed stays theirs', async (t) => {
  const { dir, file, current } = await freshWorkspace(t);
  const earlier = `${current}\nA rule from the earlier release.\n`;
  await editManifest(dir, (m) => { entry(m).sha256 = sha(earlier); });
  await fsp.writeFile(file, `${earlier}\nMy own note.\n`);

  // This release writes the .new itself and records it.
  upgradeWorkspace(dir, opts);
  assert.equal(await fsp.readFile(`${file}.new`, 'utf8'), current);
  assert.equal(entry(readManifest(dir)!).new_sha256, sha(current));

  // Unchanged on the next start: nothing is written again.
  const before = (await fsp.stat(`${file}.new`)).mtimeMs;
  upgradeWorkspace(dir, opts);
  assert.equal((await fsp.stat(`${file}.new`)).mtimeMs, before);

  // A later release finds its predecessor's copy and refreshes it.
  await editManifest(dir, (m) => { entry(m).sha256 = sha(earlier); entry(m).new_sha256 = sha(earlier); });
  await fsp.writeFile(`${file}.new`, earlier);
  upgradeWorkspace(dir, opts);
  assert.equal(await fsp.readFile(`${file}.new`, 'utf8'), current);

  // The user saves their own text into the .new, even text that matches a release. It is never the app's again.
  await editManifest(dir, (m) => { entry(m).sha256 = sha(earlier); entry(m).new_sha256 = sha(earlier); });
  await fsp.writeFile(`${file}.new`, current);
  upgradeWorkspace(dir, opts);
  assert.equal(entry(readManifest(dir)!).new_sha256, undefined, 'a .new that is not the recorded copy is untracked');
  const later = `${current}\nA rule from a later release.\n`;
  await editManifest(dir, (m) => { entry(m).sha256 = sha(later); });
  upgradeWorkspace(dir, opts);
  assert.equal(await fsp.readFile(`${file}.new`, 'utf8'), current, 'kept by the next release too');
});

test('a .new the user changed is kept, even from an earlier release', async (t) => {
  const { dir, file, current } = await freshWorkspace(t);
  const earlier = `${current}\nA rule from the earlier release.\n`;
  await editManifest(dir, (m) => { delete m.newCopiesTracked; entry(m).sha256 = sha(earlier); });
  await fsp.writeFile(file, `${earlier}\nMy own note.\n`);
  await fsp.writeFile(`${file}.new`, `${earlier}\nHalf merged.\n`);

  assert.ok(upgradeWorkspace(dir, opts).conflicted.includes('AGENTS.md'));
  assert.equal(await fsp.readFile(`${file}.new`, 'utf8'), `${earlier}\nHalf merged.\n`);
});

test('a .new that is a link or a folder is left alone, and the upgrade still finishes', { skip: process.platform === 'win32' ? 'symlinks need privileges' : false }, async (t) => {
  const { dir, file, current } = await freshWorkspace(t);
  const earlier = `${current}\nA rule from the earlier release.\n`;
  await editManifest(dir, (m) => { delete m.newCopiesTracked; entry(m).sha256 = sha(earlier); });
  await fsp.writeFile(file, `${earlier}\nMy own note.\n`);

  // A link to a file holding exactly the earlier release's text: the link is the user's, not the app's copy.
  const target = path.join(dir, 'my-merge.md');
  await fsp.writeFile(target, earlier);
  await fsp.symlink(target, `${file}.new`);
  assert.ok(upgradeWorkspace(dir, opts).conflicted.includes('AGENTS.md'));
  assert.ok((await fsp.lstat(`${file}.new`)).isSymbolicLink(), 'still a link');
  assert.equal(await fsp.readFile(target, 'utf8'), earlier);

  await fsp.rm(`${file}.new`);
  await fsp.mkdir(`${file}.new`);
  assert.ok(upgradeWorkspace(dir, opts).conflicted.includes('AGENTS.md'));
  assert.ok((await fsp.stat(`${file}.new`)).isDirectory());
});

test('a conflict resolved for a release, and back in a later one, still refreshes the app\'s own .new', async (t) => {
  const { dir, file, current } = await freshWorkspace(t);
  const earlier = `${current}\nA rule from the earlier release.\n`;
  await editManifest(dir, (m) => { entry(m).sha256 = sha(earlier); });
  await fsp.writeFile(file, `${earlier}\nMy own note.\n`);
  upgradeWorkspace(dir, opts);
  assert.equal(entry(readManifest(dir)!).new_sha256, sha(current), 'the app wrote and recorded the .new');

  // The user takes the app's version as it is, and leaves the .new there: no conflict this time.
  await fsp.writeFile(file, current);
  assert.ok(upgradeWorkspace(dir, opts).unchanged.includes('AGENTS.md'));
  assert.equal(entry(readManifest(dir)!).new_sha256, sha(current), 'still recorded while unchanged');

  // A later release, and a new edit: the old .new is the app's and shows the newest version again.
  const later = `${current}\nMy second note.\n`;
  await editManifest(dir, (m) => { entry(m).sha256 = sha(earlier); });
  await fsp.writeFile(file, later);
  await fsp.writeFile(`${file}.new`, earlier);
  await editManifest(dir, (m) => { entry(m).new_sha256 = sha(earlier); });
  assert.ok(upgradeWorkspace(dir, opts).conflicted.includes('AGENTS.md'));
  assert.equal(await fsp.readFile(`${file}.new`, 'utf8'), current);
});
