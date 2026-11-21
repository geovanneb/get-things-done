import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { assistantLaunch, requestTarget, windowsTerminalLaunch, workspaceAssistants } from '../src/routes/workspace';
import { promptArgs } from '../src/utils/assistantCommand';
import { parseAssistantRequest, requestText } from '../src/utils/assistantRequest';

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

test('a request to start with is checked: a known kind and an ID of the shape it takes, nothing else', () => {
  assert.deepEqual(parseAssistantRequest({ request: 'task', id: 'TASK-2026-0001' }), { request: 'task', id: 'TASK-2026-0001' });
  assert.deepEqual(parseAssistantRequest({ request: 'analyze', id: 'CU-2026-0001' }), { request: 'analyze', id: 'CU-2026-0001' });
  assert.deepEqual(parseAssistantRequest({ request: 'apply', id: 'CU-2026-0001' }), { request: 'apply', id: 'CU-2026-0001' });
  for (const bad of [
    null, 'task', [], {}, { request: 'task' }, { request: 'deploy', id: 'TASK-2026-0001' },
    { request: 'task', id: 'CU-2026-0001' }, { request: 'analyze', id: 'TASK-2026-0001' },
    { request: 'task', id: 'TASK-2026-0001; rm -rf ~' }, { request: 'task', id: "TASK-2026-0001' && echo x '" },
    { request: 'task', id: 'TASK-2026-0001\n' }, { request: 'task', id: 42 },
  ]) assert.equal(parseAssistantRequest(bad), null, JSON.stringify(bad));
});

test('each assistant starts with the request sent: Claude Code and Codex as their prompt, Copilot after -i, VS Code never', () => {
  assert.deepEqual(promptArgs('claude', requestText('claude-code', 'task', 'TASK-2026-0001')), ['/gtd-task TASK-2026-0001']);
  assert.deepEqual(promptArgs('codex', requestText('codex', 'analyze', 'CU-2026-0001')), ['Analyze context update CU-2026-0001']);
  assert.deepEqual(promptArgs('copilot', requestText('copilot', 'apply', 'CU-2026-0001')), ['-i', 'Apply context update CU-2026-0001']);
  assert.deepEqual(promptArgs('code', 'Execute task TASK-2026-0001'), []);
  assert.deepEqual(promptArgs('claude', undefined), [], 'without a request it opens as before');
});

test('on Windows the request goes to the new window as its own arguments, the path as the working directory', () => {
  const launch = windowsTerminalLaunch('C:\\Fictional & 100%', 'copilot', ['-i', 'Execute task TASK-2026-0001']);
  assert.deepEqual(launch.args, ['/c', 'start', '', 'cmd', '/k', 'copilot', '-i', 'Execute task TASK-2026-0001']);
  assert.equal(launch.options.cwd, 'C:\\Fictional & 100%');
});

test('a request starts only for an active task or a context update the workspace holds', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-targets-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  assert.equal(await requestTarget(dir, 'task', 'TASK-2026-0001'), null, 'a workspace with no tasks folder');
  await fsp.mkdir(path.join(dir, 'tasks', 'active', 'TASK-2026-0001'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'tasks', 'archive', 'TASK-2026-0002'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'context-updates', 'CU-2026-0001'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'context-updates', 'CU-2026-0002'), 'a file, not an update folder');
  assert.equal(await requestTarget(dir, 'task', 'TASK-2026-0001'), 'TASK-2026-0001');
  assert.equal(await requestTarget(dir, 'task', 'TASK-2026-0002'), null, 'an archived task is not run');
  assert.equal(await requestTarget(dir, 'analyze', 'CU-2026-0001'), 'CU-2026-0001');
  assert.equal(await requestTarget(dir, 'apply', 'CU-2026-0002'), null);
  assert.equal(await requestTarget(dir, 'analyze', 'CU-2026-0009'), null);
});
