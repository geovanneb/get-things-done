import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { scaffoldWorkspace, upgradeWorkspace, readManifest, MANIFEST_RELATIVE_PATH } from '../src/services/scaffold';

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
