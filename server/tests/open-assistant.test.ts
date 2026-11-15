import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { assistantLaunch, workspaceAssistants } from '../src/routes/workspace';

const none = () => null;

test('each assistant opens with its own program, never one named by the request', () => {
  assert.deepEqual(assistantLaunch('claude-code', none), { via: 'terminal', program: 'claude' });
  assert.deepEqual(assistantLaunch('codex', none), { via: 'terminal', program: 'codex' });
});

test('Copilot opens in a terminal with its CLI, otherwise in VS Code', () => {
  assert.deepEqual(assistantLaunch('copilot', (c) => (c === 'copilot' ? '/usr/local/bin/copilot' : null)), { via: 'terminal', program: 'copilot' });
  assert.deepEqual(assistantLaunch('copilot', (c) => (c === 'code' ? '/usr/local/bin/code' : null)), { via: 'editor', program: '/usr/local/bin/code' });
  assert.deepEqual(assistantLaunch('copilot', none, 'darwin'), { via: 'editor', program: null }, 'the VS Code app on macOS');
  assert.deepEqual(assistantLaunch('copilot', none, 'linux'), { via: 'terminal', program: 'copilot' });
});

test('the workspace assistants come from its instruction files, Claude Code when it has none', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-assistants-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  assert.deepEqual(workspaceAssistants(dir), ['claude-code']);
  await fsp.writeFile(path.join(dir, 'AGENTS.md'), '# Fictional\n');
  assert.deepEqual(workspaceAssistants(dir), ['codex']);
  await fsp.mkdir(path.join(dir, '.github'));
  await fsp.writeFile(path.join(dir, '.github', 'copilot-instructions.md'), '# Fictional\n');
  await fsp.writeFile(path.join(dir, 'CLAUDE.md'), '# Fictional\n');
  assert.deepEqual(workspaceAssistants(dir), ['claude-code', 'codex', 'copilot']);
});
