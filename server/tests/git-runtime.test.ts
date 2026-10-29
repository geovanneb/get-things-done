import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The desktop app's situation: no git on PATH, a bundled git in a folder with spaces, plus GIT_* variables.
const realGit = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git']).toString().split(/\r?\n/)[0]!.trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-gitrt-'));
const home = path.join(tmp, 'home');
const appBin = path.join(tmp, 'Get Things Done.app', 'bin');
const workspace = path.join(tmp, 'Northwind Labs');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(appBin, { recursive: true });
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(tmp, 'templates'));
fs.writeFileSync(path.join(tmp, 'gitconfig'), '');
const bundledGit = path.join(appBin, 'git');
fs.symlinkSync(realGit, bundledGit);
fs.writeFileSync(path.join(workspace, 'workspace.yaml'), 'name: "Northwind Labs"\n');
execFileSync(realGit, ['init', '-q', '-b', 'main'], { cwd: workspace });

process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
process.env['PATH'] = path.join(tmp, 'empty-bin');
process.env['ESB_WORKSPACE_PATH'] = workspace;

test('a host-supplied git in a path with spaces runs status, stage and commit with its own GIT_* variables', async (t) => {
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { GitService, useGitRuntime } = await import('../src/services/gitService');
  const git = new GitService();

  assert.equal(await git.isInstalled(), false, 'nothing on PATH');

  useGitRuntime({
    binary: bundledGit,
    env: {
      // The variables the bundled git (dugite) sets, which simple-git only allows when their category is enabled.
      GIT_EXEC_PATH: execFileSync(realGit, ['--exec-path']).toString().trim(),
      GIT_TEMPLATE_DIR: path.join(tmp, 'templates'),
      GIT_CONFIG_SYSTEM: path.join(tmp, 'gitconfig'),
      GIT_AUTHOR_NAME: 'Alex Morgan',
      GIT_AUTHOR_EMAIL: 'alex@northwind.example',
      GIT_COMMITTER_NAME: 'Alex Morgan',
      GIT_COMMITTER_EMAIL: 'alex@northwind.example',
    },
  });
  assert.equal(await git.isInstalled(), true);
  assert.equal(await git.isGitRepo(), true);

  const status = await git.getStatus();
  assert.equal(status.is_repo, true);
  assert.deepEqual(status.untracked, ['workspace.yaml']);

  await git.stageFile('workspace.yaml');
  // A file name that looks like an option is staged as a path, not run as one.
  await assert.rejects(git.stageFile('--exec-path=/tmp'), /did not match any files|pathspec/);
  await git.commit('Add workspace');
  const [last] = await git.getLog(1);
  assert.equal(last?.message, 'Add workspace');
  assert.equal(last?.author, 'Alex Morgan');

  useGitRuntime(null);
  assert.equal(await git.isInstalled(), false, 'back to PATH');
});
