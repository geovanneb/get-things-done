import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Another git holding the index for a moment, as a `git status` does while the dashboard opens.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-gitlock-'));
fs.writeFileSync(path.join(workspace, 'workspace.yaml'), 'name: "Northwind Labs"\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
execFileSync('git', ['config', 'user.name', 'Jane Doe'], { cwd: workspace });
execFileSync('git', ['config', 'user.email', 'jane@example.com'], { cwd: workspace });
process.env['ESB_WORKSPACE_PATH'] = workspace;
const lock = path.join(workspace, '.git', 'index.lock');

test('stage and commit wait for a lock that goes away, and report one that stays', async (t) => {
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const { GitService } = await import('../src/services/gitService');
  const git = new GitService();

  fs.writeFileSync(lock, '');
  setTimeout(() => fs.rmSync(lock), 300);
  await git.stageFile('workspace.yaml');
  assert.deepEqual((await git.getStatus()).staged, ['workspace.yaml']);

  fs.writeFileSync(lock, '');
  setTimeout(() => fs.rmSync(lock), 300);
  await git.commit('First');
  assert.equal((await git.getStatus()).is_clean, true);

  fs.writeFileSync(path.join(workspace, 'workspace.yaml'), 'name: "Contoso"\n');
  fs.writeFileSync(lock, '');
  await assert.rejects(git.stageFile('workspace.yaml'), /index\.lock/);
  fs.rmSync(lock);
});
