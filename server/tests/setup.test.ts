import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import matter from 'gray-matter';

// A computer where nothing is set up yet: an empty HOME with a Documents folder, and `claude` on PATH.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-setup-'));
const home = path.join(tmp, 'home');
const bin = path.join(tmp, 'bin');
fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
fs.mkdirSync(bin);
const fakeClaude = path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
fs.writeFileSync(fakeClaude, '#!/bin/sh\n');
fs.chmodSync(fakeClaude, 0o755);
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
process.env['PATH'] = bin;
delete process.env['ESB_WORKSPACE_PATH'];

async function startApp(t: { after: (fn: () => void) => void }) {
  const express = (await import('express')).default;
  const { registerRoutes } = await import('../src/routes');
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  // Setup starts the file watcher on the new workspace; stop it so it never keeps the test process alive.
  const { watcherService } = await import('../src/services/watcherService');
  t.after(() => {
    watcherService.stop();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const post = (url: string, body: unknown) =>
    fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { base, post };
}

test('first-run setup creates a workspace with the profile and only the chosen AI tools', async (t) => {
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { base, post } = await startApp(t);

  const before = await (await fetch(`${base}/setup`)).json();
  assert.equal(before.configured, false);
  assert.equal(before.suggested_path, path.join(home, 'Documents', 'Get Things Done'));
  assert.deepEqual(before.ai_tools.map((tool: { id: string }) => tool.id), ['claude-code', 'copilot', 'codex']);
  assert.equal(before.ai_tools.find((tool: { id: string }) => tool.id === 'claude-code').installed, true);

  // Requests the setup must refuse.
  const target = before.suggested_path as string;
  for (const [body, message] of [
    [{}, /choose a folder/],
    [{ path: target }, /does not exist/],
    [{ path: target, create: true, profile: { name: 'Alex\nMorgan' } }, /single line/],
    [{ path: target, create: true, ai_tools: ['claude-code', 'chatbot'] }, /ai_tools/],
    [{ path: target, create: true, workspace_name: 'x'.repeat(121) }, /too long/],
    [{ path: target, create: true, profile: 'Alex' }, /profile/],
  ] as const) {
    const res = await post('/setup', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, message);
  }
  assert.equal(fs.existsSync(target), false, 'a refused request creates nothing');

  // "Open an existing workspace" on a plain folder asks first instead of creating one.
  fs.mkdirSync(target);
  const notYet = await post('/setup', { path: target, require_existing: true });
  assert.equal(notYet.status, 409);
  assert.equal((await notYet.json()).needs_init, true);
  assert.equal(fs.existsSync(path.join(target, 'workspace.yaml')), false);

  const created = await post('/setup', {
    path: target,
    create: true,
    workspace_name: 'Alex "AM" Workspace',
    profile: { name: 'Alex "AM" Morgan', role: 'COO \\ Operations', organization: 'Northwind Labs' },
    ai_tools: ['codex'],
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.initialized, true);
  assert.equal(body.config.name, 'Alex "AM" Workspace');

  // Quotes and backslashes survive in the YAML the app writes.
  const profile = matter(fs.readFileSync(path.join(target, 'profile', 'executive-profile.md'), 'utf8')).data;
  assert.equal(profile['name'], 'Alex "AM" Morgan');
  assert.equal(profile['role'], 'COO \\ Operations');
  assert.ok(fs.existsSync(path.join(target, 'AGENTS.md')), 'Codex instructions');
  assert.ok(!fs.existsSync(path.join(target, 'CLAUDE.md')), 'no Claude Code files when not chosen');

  const after = await (await fetch(`${base}/setup`)).json();
  assert.equal(after.configured, true);
  assert.equal(after.workspace_path, target);
  assert.equal((await (await fetch(`${base}/workspace`)).json()).name, 'Alex "AM" Workspace');

  // Opening an existing workspace leaves its profile alone.
  const reopened = await post('/setup', { path: target, profile: { name: 'Someone Else' }, ai_tools: ['claude-code'] });
  assert.equal(reopened.status, 200);
  assert.equal((await reopened.json()).initialized, false);
  assert.equal(matter(fs.readFileSync(path.join(target, 'profile', 'executive-profile.md'), 'utf8')).data['name'], 'Alex "AM" Morgan');
  assert.ok(!fs.existsSync(path.join(target, 'CLAUDE.md')));

  // Renaming keeps quotes and `$` sequences as typed.
  const renamed = await fetch(`${base}/workspace`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ops "Q4" $& plan' }),
  });
  assert.equal((await renamed.json()).name, 'Ops "Q4" $& plan');
});

test('AI tool detection looks only at the given folders and never runs anything', async () => {
  const { detectAiTools } = await import('../src/services/aiToolDetection');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-tools-'));
  try {
    const none = detectAiTools([dir], () => false);
    assert.deepEqual(none.map((tool) => tool.installed), [false, false, false]);

    // VS Code counts for Copilot; a file that is not executable does not count.
    const code = path.join(dir, process.platform === 'win32' ? 'code.cmd' : 'code');
    fs.writeFileSync(code, '');
    if (process.platform !== 'win32') {
      assert.equal(detectAiTools([dir], () => false)[1]?.installed, false, 'not executable');
      fs.chmodSync(code, 0o755);
    }
    const found = detectAiTools([dir], () => false);
    assert.deepEqual(found.map((tool) => [tool.id, tool.installed]), [['claude-code', false], ['copilot', true], ['codex', false]]);
    assert.ok(found.every((tool) => tool.install_url.startsWith('https://') && tool.description.length > 0));

    // The VS Code app folder counts too, for macOS where `code` is often not on PATH.
    assert.equal(detectAiTools([], (app) => app.endsWith('Visual Studio Code.app'))[1]?.installed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
