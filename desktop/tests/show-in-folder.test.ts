import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isBundle, parseRelativePath, showInFolder, type FolderShell } from '../src/show-in-folder';

/** A fictional workspace with a meeting folder, a script, and a folder outside it. */
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-show-in-folder-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const ws = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await fsp.mkdir(path.join(ws, 'meetings', 'MQ-2026-0001', 'v1'), { recursive: true });
  await fsp.mkdir(path.join(ws, 'meetings', 'MQ-2026-0001', 'audio'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'meetings', 'MQ-2026-0001', 'meeting.json'), '{}');
  await fsp.writeFile(path.join(ws, 'meetings', 'MQ-2026-0001', 'v1', 'call.transcript.md'), 'fictional');
  await fsp.writeFile(path.join(ws, 'run-me.command'), '#!/bin/sh\necho fictional');
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'fictional');
  return { ws, outside, real: await fsp.realpath(ws) };
}

/**
 * Records what the app asked the shell to do. It also carries `openPath`, which the bridge's shell has too: any call
 * to it fails the test, since opening launches a file or an app bundle.
 */
function shell(): FolderShell & { shown: string[]; openPath: (full: string) => Promise<string> } {
  const shown: string[] = [];
  return {
    shown,
    showItemInFolder: (full) => { shown.push(full); },
    openPath: async (full) => { assert.fail(`openPath was called on ${full}: the bridge must only reveal`); },
  };
}

test('only a relative path inside the workspace is accepted from the page', () => {
  assert.equal(parseRelativePath('meetings/MQ-2026-0001'), 'meetings/MQ-2026-0001');
  assert.equal(parseRelativePath('./meetings//MQ-2026-0001/'), 'meetings/MQ-2026-0001');
  assert.equal(parseRelativePath('context-updates\\CU-2026-0001\\materials'), 'context-updates/CU-2026-0001/materials');
  for (const bad of [undefined, null, 5, {}, '', '.', '/etc', '/Users/demo/workspace/meetings', 'C:\\Windows', 'C:Windows', '\\\\server\\share', '..', 'meetings/../../x', 'a\0b', 'x'.repeat(1025)]) {
    assert.equal(parseRelativePath(bad), null, JSON.stringify(bad));
  }
});

test('a file is revealed in its folder; a folder is shown from inside, its first visible entry selected', async (t) => {
  const { ws, real } = await fixture(t);
  await fsp.writeFile(path.join(ws, 'meetings', 'MQ-2026-0001', '.hidden'), 'x');
  const s = shell();
  assert.deepEqual(await showInFolder(ws, 'meetings/MQ-2026-0001/v1/call.transcript.md', s), { opened: true });
  assert.deepEqual(await showInFolder(ws, 'run-me.command', s), { opened: true });
  assert.deepEqual(await showInFolder(ws, 'meetings/MQ-2026-0001', s), { opened: true });
  assert.deepEqual(s.shown, [
    path.join(real, 'meetings', 'MQ-2026-0001', 'v1', 'call.transcript.md'),
    path.join(real, 'run-me.command'),
    path.join(real, 'meetings', 'MQ-2026-0001', 'audio'),
  ], 'a script is only revealed; the folder\'s first entry by name, dotfiles skipped');
});

test('an empty folder, or one with only dotfiles, is revealed in its parent', async (t) => {
  const { ws, real } = await fixture(t);
  await fsp.mkdir(path.join(ws, 'empty'));
  await fsp.mkdir(path.join(ws, 'dotfiles-only'));
  await fsp.writeFile(path.join(ws, 'dotfiles-only', '.DS_Store'), 'x');
  const s = shell();
  await showInFolder(ws, 'empty', s);
  await showInFolder(ws, 'dotfiles-only', s);
  assert.deepEqual(s.shown, [path.join(real, 'empty'), path.join(real, 'dotfiles-only')]);
});

test('an app or other bundle is revealed like a file, never entered or launched, also as a folder\'s first entry', async (t) => {
  const { ws, real } = await fixture(t);
  await fsp.mkdir(path.join(ws, 'Tool.app', 'Contents', 'MacOS'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'Tool.app', 'Contents', 'MacOS', 'Tool'), '#!/bin/sh');
  await fsp.mkdir(path.join(ws, 'apps', 'A Helper.APP', 'Contents'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'apps', 'b-notes.md'), 'x');
  // A package with no telling name: macOS knows it by Contents/Info.plist.
  await fsp.mkdir(path.join(ws, 'Unnamed', 'Contents'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'Unnamed', 'Contents', 'Info.plist'), '<plist/>');
  for (const name of ['Thing.bundle', 'Kit.framework', 'Ext.plugin', 'Drv.kext', 'Setup.pkg', 'Setup.mpkg']) await fsp.mkdir(path.join(ws, name));
  assert.equal(await isBundle(path.join(ws, 'Unnamed')), true);
  assert.equal(await isBundle(path.join(ws, 'apps')), false);
  const s = shell();
  await showInFolder(ws, 'Tool.app', s);
  await showInFolder(ws, 'apps', s);
  await showInFolder(ws, 'Unnamed', s);
  for (const name of ['Thing.bundle', 'Kit.framework', 'Ext.plugin', 'Drv.kext', 'Setup.pkg', 'Setup.mpkg']) await showInFolder(ws, name, s);
  assert.deepEqual(s.shown, [
    path.join(real, 'Tool.app'),
    path.join(real, 'apps', 'A Helper.APP'),
    path.join(real, 'Unnamed'),
    ...['Thing.bundle', 'Kit.framework', 'Ext.plugin', 'Drv.kext', 'Setup.pkg', 'Setup.mpkg'].map((n) => path.join(real, n)),
  ]);
});

test('nothing is shown for a path that is missing, outside, or leads outside through a link', async (t) => {
  const { ws, outside } = await fixture(t);
  await fsp.symlink(outside, path.join(ws, 'meetings', 'MQ-2026-0002'), 'junction');
  await fsp.symlink(path.join(outside, 'secret.txt'), path.join(ws, 'linked.txt')).catch(() => undefined);
  const s = shell();
  for (const asked of ['meetings/MQ-2026-0009', '../outside', path.join(outside, 'secret.txt'), 'meetings/MQ-2026-0002', 'meetings/MQ-2026-0002/secret.txt', 'linked.txt']) {
    assert.equal((await showInFolder(ws, asked, s)).opened, false, asked);
  }
  assert.deepEqual(s.shown, [], 'the shell was never asked');
});

test('a folder\'s first entry that leads outside is skipped: only an entry inside, or the folder, is revealed', async (t) => {
  const { ws, outside, real } = await fixture(t);
  await fsp.mkdir(path.join(ws, 'mixed'));
  await fsp.symlink(outside, path.join(ws, 'mixed', 'a-link'), 'junction');
  await fsp.writeFile(path.join(ws, 'mixed', 'b-file.md'), 'x');
  await fsp.mkdir(path.join(ws, 'only-link'));
  await fsp.symlink(outside, path.join(ws, 'only-link', 'a-link'), 'junction');
  const s = shell();
  await showInFolder(ws, 'mixed', s);
  await showInFolder(ws, 'only-link', s);
  assert.deepEqual(s.shown, [path.join(real, 'mixed', 'b-file.md'), path.join(real, 'only-link')]);
  assert.ok(!s.shown.some((p) => p.startsWith(outside)), 'nothing outside is ever revealed');
});

test('a link is never a folder\'s chosen entry, even one that stays inside: the reveal stays in the asked folder', async (t) => {
  const { ws, real } = await fixture(t);
  await fsp.mkdir(path.join(ws, 'linked'));
  await fsp.symlink(path.join(ws, 'meetings'), path.join(ws, 'linked', 'a-inside-link'), 'junction');
  await fsp.writeFile(path.join(ws, 'linked', 'b-notes.md'), 'x');
  await fsp.mkdir(path.join(ws, 'links-and-dotfiles'));
  await fsp.symlink(path.join(ws, 'meetings'), path.join(ws, 'links-and-dotfiles', 'a-inside-link'), 'junction');
  await fsp.writeFile(path.join(ws, 'links-and-dotfiles', '.hidden'), 'x');
  const s = shell();
  await showInFolder(ws, 'linked', s);
  await showInFolder(ws, 'links-and-dotfiles', s);
  assert.deepEqual(s.shown, [path.join(real, 'linked', 'b-notes.md'), path.join(real, 'links-and-dotfiles')]);
});

test('a link that stays inside the workspace is followed to where it really is', async (t) => {
  const { ws, real } = await fixture(t);
  await fsp.symlink(path.join(ws, 'meetings', 'MQ-2026-0001', 'v1'), path.join(ws, 'shortcut'), 'junction');
  const s = shell();
  assert.deepEqual(await showInFolder(ws, 'shortcut', s), { opened: true });
  assert.deepEqual(s.shown, [path.join(real, 'meetings', 'MQ-2026-0001', 'v1', 'call.transcript.md')]);
});

test('a workspace that is gone shows nothing', async (t) => {
  const { ws } = await fixture(t);
  const s = shell();
  assert.equal((await showInFolder(path.join(ws, 'missing-workspace'), 'meetings', s)).opened, false);
  assert.deepEqual(s.shown, []);
});
