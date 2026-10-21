#!/usr/bin/env node
/**
 * End-to-end smoke test against the built package (run `npm run build` first).
 *
 * Creates a throwaway workspace with the real CLI, starts the bundled server,
 * fills it with the demo data and checks the main API surfaces. Everything runs
 * in a temp directory with its own HOME, so it never touches your config.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-smoke-'));
const home = path.join(tmp, 'home');
const ws = path.join(tmp, 'workspace');
fs.mkdirSync(home);
const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: home, USERPROFILE: home };

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

execFileSync(process.execPath, [path.join(root, 'bin/gtd.js'), 'init', '-y', '-d', ws,
  '--name', 'Alex Morgan', '--role', 'COO', '--org', 'Northwind Labs', '--ai', 'claude-code,copilot,codex'],
  { env, stdio: 'pipe' });
check('gtd init creates a workspace', fs.existsSync(path.join(ws, 'workspace.yaml')));
check('gtd init writes the Claude Code setup', fs.existsSync(path.join(ws, 'CLAUDE.md')));

const server = spawn(process.execPath, [path.join(root, 'dist/server/index.js')], {
  env: { ...env, ESB_WORKSPACE_PATH: ws, ESB_UI_PATH: path.join(root, 'dist/ui'), PORT: String(port), NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

try {
  let healthy = false;
  for (let i = 0; i < 50 && !healthy; i++) {
    try { healthy = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  check('server answers /health', healthy);
  if (!healthy) throw new Error('server did not start');

  const ui = await fetch(`${base}/board`);
  check('UI is served for app routes', ui.ok && (await ui.text()).includes('<div id="root">'));

  const missing = await fetch(`${base}/api/does-not-exist`);
  check('unknown API paths return a JSON 404', missing.status === 404);

  execFileSync(process.execPath, [path.join(root, 'scripts/seed-demo.mjs'), base], { env, stdio: 'pipe' });

  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  check('tasks are listed', tasks.length === 14, `count=${tasks.length}`);

  const people = await (await fetch(`${base}/api/stakeholders`)).json();
  check('stakeholders are listed', people.length === 6, `count=${people.length}`);

  const search = await (await fetch(`${base}/api/search?q=carrier`)).json();
  check('search finds seeded content', (search.results ?? []).length > 0);

  const insights = await (await fetch(`${base}/api/insights`)).json();
  check('insights count work waiting on review', insights.summary?.awaiting_review === 1);

  const task = tasks.find((t) => t.status === 'ready');
  const moved = await (await fetch(`${base}/api/tasks/${task.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
  })).json();
  check('moving a task to done stamps done_date', Boolean(moved.done_date));

  const issues = await (await fetch(`${base}/api/workspace/validate`)).json();
  const errors = issues.filter((i) => i.level === 'error');
  check('a workspace edited through the app has no validation errors', errors.length === 0,
    errors.length ? JSON.stringify(errors.slice(0, 3)) : '');
} catch (err) {
  check('smoke test ran to the end', false, String(err));
} finally {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed. Server log:\n${serverLog}`);
  process.exit(1);
}
console.log('\nALL PASS');
