import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-gitdiff-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace });
const write = (name: string, data: string | Buffer) => fs.writeFileSync(path.join(workspace, name), data);
fs.mkdirSync(path.join(workspace, 'profile'));
write('profile/executive-profile.md', '---\nname: Alex Morgan\n---\nStyle: short-form\n');
write('notes.md', 'line one\n');
write('会議 メモ.md', 'one\ntwo\nthree\n');
write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
write('old name.md', 'alpha\nbeta\ngamma\ndelta\n');
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Jane Doe');
git('config', 'user.email', 'jane@example.com');
// A contributor's global commit signing would need their key here.
git('config', 'commit.gpgsign', 'false');
// The default since git 2.9, set in case a global config turns it off.
git('config', 'diff.renames', 'true');
git('add', '.');
git('commit', '-q', '-m', 'First');
process.env['ESB_WORKSPACE_PATH'] = workspace;

test('the diff names every changed file and counts its lines as git does', async (t) => {
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const { GitService } = await import('../src/services/gitService');
  const service = new GitService();

  write('profile/executive-profile.md', '---\nname: Alex Morgan\n---\nStyle: long-form, data-driven\n');
  write('notes.md', 'line two\n');
  let diff = await service.getDiff();
  assert.deepEqual(diff.files, ['notes.md', 'profile/executive-profile.md']);
  assert.deepEqual(diff.stats, { insertions: 2, deletions: 2, files_changed: 2 });
  assert.match(diff.diff, /^\+Style: long-form, data-driven$/m);

  diff = await service.getDiff('profile/executive-profile.md');
  assert.deepEqual(diff.files, ['profile/executive-profile.md']);
  assert.deepEqual(diff.stats, { insertions: 1, deletions: 1, files_changed: 1 });

  // A name with spaces and Japanese is given as it is (not quoted), a binary file adds no lines, and a rename counts once.
  write('会議 メモ.md', 'one\nthree\nfour\nfive\n');
  write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
  fs.rmSync(path.join(workspace, 'old name.md'));
  write('new name.md', 'alpha\nbeta\ngamma\ndelta\nepsilon\n');
  git('add', '--intent-to-add', 'new name.md');
  diff = await service.getDiff();
  assert.deepEqual(diff.files.sort(), ['logo.png', 'new name.md', 'notes.md', 'profile/executive-profile.md', '会議 メモ.md']);
  assert.deepEqual(diff.stats, { insertions: 2 + 2 + 1, deletions: 2 + 1, files_changed: 5 });

  git('checkout', '-q', '--', '.');
  git('rm', '-q', '--cached', 'new name.md');
  fs.rmSync(path.join(workspace, 'new name.md'));
  assert.deepEqual(await service.getDiff(), { files: [], diff: '', stats: { insertions: 0, deletions: 0, files_changed: 0 } });
});
