import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { scaffoldWorkspace, upgradeWorkspace } from '../src/services/scaffold';

const opts = { profile: { name: 'Alex Morgan', role: 'COO', organization: 'Northwind Labs' }, aiTools: ['claude-code' as const] };
const SETTINGS = path.join('.claude', 'settings.json');

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-upgrade-json-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  scaffoldWorkspace(dir, opts);
  return { dir, file: path.join(dir, SETTINGS) };
}

/** Reverses every object's keys and array's items, recursively. */
function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder).reverse();
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)]));
  }
  return value;
}

test('gtd upgrade keeps a JSON file that only differs in order, without writing a .new copy', async (t) => {
  const { dir, file } = await workspace(t);
  const reordered = JSON.stringify(reorder(JSON.parse(await fsp.readFile(file, 'utf8'))), null, 4);
  await fsp.writeFile(file, reordered);

  const result = upgradeWorkspace(dir, opts);
  assert.ok(result.unchanged.includes(SETTINGS));
  assert.ok(!result.conflicted.includes(SETTINGS));
  assert.equal(await fsp.readFile(file, 'utf8'), reordered);
  await assert.rejects(fsp.access(`${file}.new`));
});

test('gtd upgrade still keeps a real JSON edit and writes the new version beside it', async (t) => {
  const { dir, file } = await workspace(t);
  const settings = JSON.parse(await fsp.readFile(file, 'utf8'));
  settings.permissions.allow.push('Bash(npm test)');
  await fsp.writeFile(file, JSON.stringify(settings, null, 2));

  assert.ok(upgradeWorkspace(dir, opts).conflicted.includes(SETTINGS));
  assert.match(await fsp.readFile(file, 'utf8'), /Bash\(npm test\)/);
  await fsp.access(`${file}.new`);
});

test('gtd upgrade removes a retired command left as installed, and keeps one the user changed', async (t) => {
  const retired = path.join('.claude', 'commands', 'gtd-kaizen.md');
  const install = async (dir: string, content: string) => {
    // As an older version left it: the file, and its hash in the manifest.
    await fsp.writeFile(path.join(dir, retired), content);
    const manifestFile = path.join(dir, '.situation-board', 'app-manifest.json');
    const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
    manifest.files.push({ path: retired, sha256: createHash('sha256').update(content).digest('hex') });
    await fsp.writeFile(manifestFile, JSON.stringify(manifest));
  };

  const untouched = await workspace(t);
  await install(untouched.dir, 'Apply kaizen proposals.\n');
  const first = upgradeWorkspace(untouched.dir, opts);
  assert.deepEqual(first.removed, [retired]);
  await assert.rejects(fsp.access(path.join(untouched.dir, retired)));
  const manifest = JSON.parse(await fsp.readFile(path.join(untouched.dir, '.situation-board', 'app-manifest.json'), 'utf8'));
  assert.ok(!manifest.files.some((f: { path: string }) => f.path === retired), 'no longer listed as an app file');
  assert.deepEqual(upgradeWorkspace(untouched.dir, opts).removed, [], 'nothing left to remove');

  const changed = await workspace(t);
  await install(changed.dir, 'Apply kaizen proposals.\n');
  await fsp.writeFile(path.join(changed.dir, retired), 'Apply kaizen proposals, my way.\n');
  const second = upgradeWorkspace(changed.dir, opts);
  assert.deepEqual(second.removed, []);
  assert.deepEqual(second.retired_kept, [retired]);
  assert.equal(await fsp.readFile(path.join(changed.dir, retired), 'utf8'), 'Apply kaizen proposals, my way.\n');
});
