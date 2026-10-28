import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { scaffoldWorkspace, upgradeWorkspace, readManifest, getTemplatesPath, MANIFEST_RELATIVE_PATH } from '../src/services/scaffold';

const SETTINGS = path.join('.claude', 'settings.json');
const opts = { profile: { name: 'Alex Morgan', role: 'COO', organization: 'Northwind Labs' }, aiTools: ['claude-code' as const] };

type Permissions = Record<'allow' | 'ask' | 'deny', string[]>;

async function shipped(): Promise<Permissions> {
  const file = path.join(getTemplatesPath(), 'ai', 'claude-code', SETTINGS);
  return JSON.parse(await fsp.readFile(file, 'utf8')).permissions;
}

test('shipped Claude Code settings use only path rules that Claude Code matches', async () => {
  const permissions = await shipped();
  for (const rule of Object.values(permissions).flat()) {
    // Claude Code checks file paths against Edit(...) and Read(...) rules only; Write/NotebookEdit/Glob/MultiEdit
    // path rules are accepted but never match, so the limit would silently not apply.
    assert.doesNotMatch(rule, /^(Write|NotebookEdit|Glob|MultiEdit)\(/, rule);
    // A bare path is relative to the current directory; a single leading slash anchors it at the workspace.
    if (rule.startsWith('Edit(')) assert.match(rule, /^Edit\(\/[^/]/, rule);
  }
});

test('shipped Claude Code settings keep each folder in its write tier', async () => {
  const { allow, ask, deny } = await shipped();
  for (const dir of ['tasks', 'context-updates', '.situation-board/logs']) assert.ok(allow.includes(`Edit(/${dir}/**)`), dir);
  for (const dir of ['stakeholders', 'context', 'outputs']) assert.ok(ask.includes(`Edit(/${dir}/**)`), dir);
  for (const dir of ['.claude', 'profile', '.schemas']) assert.ok(deny.includes(`Edit(/${dir}/**)`), dir);
});

test('gtd upgrade replaces untouched settings that still have Write rules, and keeps edited ones', async (t) => {
  async function oldWorkspace(userEdit: boolean) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-claude-settings-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    scaffoldWorkspace(dir, opts);
    const file = path.join(dir, SETTINGS);
    const old = (await fsp.readFile(file, 'utf8')).replace(/Edit\(\//g, 'Write(');
    const manifest = readManifest(dir)!;
    manifest.files.find((f) => f.path === SETTINGS)!.sha256 = createHash('sha256').update(old).digest('hex');
    await fsp.writeFile(path.join(dir, MANIFEST_RELATIVE_PATH), JSON.stringify(manifest));
    await fsp.writeFile(file, userEdit ? old.replace('"WebSearch(*)"', '"WebSearch(*)", "Bash(npm test)"') : old);
    return { dir, file };
  }

  const untouched = await oldWorkspace(false);
  assert.ok(upgradeWorkspace(untouched.dir, opts).updated.includes(SETTINGS));
  assert.doesNotMatch(await fsp.readFile(untouched.file, 'utf8'), /Write\(/);

  const edited = await oldWorkspace(true);
  assert.ok(upgradeWorkspace(edited.dir, opts).conflicted.includes(SETTINGS));
  assert.match(await fsp.readFile(edited.file, 'utf8'), /Bash\(npm test\)/);
  assert.doesNotMatch(await fsp.readFile(`${edited.file}.new`, 'utf8'), /Write\(/);
});
