import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
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
