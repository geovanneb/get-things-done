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

  // Live updates: an agent editing a task file on disk must reach the dashboard over SSE.
  const sse = await fetch(`${base}/api/events`);
  const reader = sse.body.getReader();
  let streamed = '';
  const sawChange = (async () => {
    const until = Date.now() + 8000;
    while (Date.now() < until && !streamed.includes('event: file_change')) {
      const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({}), 500))]);
      if (done) break;
      if (value) streamed += new TextDecoder().decode(value);
    }
    return streamed.includes('event: file_change');
  })();
  await new Promise((r) => setTimeout(r, 1000)); // let the watcher settle
  const edited = path.join(ws, 'tasks', 'active', tasks[0].id, 'task.md');
  fs.appendFileSync(edited, '\nEdited outside the app.\n');
  check('editing a task file on disk pushes a live update', await sawChange);
  await reader.cancel();

  const task = tasks.find((t) => t.status === 'ready');
  const moved = await (await fetch(`${base}/api/tasks/${task.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
  })).json();
  check('moving a task to done stamps done_date', Boolean(moved.done_date));

  // A task reopened by editing task.md keeps a stale done_date on disk; the app
  // must not carry it over when the task is completed again.
  const reopened = tasks.find((t) => t.status === 'backlog' && t.id !== task.id);
  const reopenedFile = path.join(ws, 'tasks', 'active', reopened.id, 'task.md');
  const stale = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(reopenedFile, fs.readFileSync(reopenedFile, 'utf8').replace(/^status: .*$/m, (m) => `${m}\ndone_date: '${stale}'`));
  const recompleted = await (await fetch(`${base}/api/tasks/${reopened.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
  })).json();
  check('completing a task again replaces a stale done_date', Boolean(recompleted.done_date) && recompleted.done_date !== stale,
    `done_date=${recompleted.done_date}`);

  const group = await fetch(`${base}/api/stakeholders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Smoke group', type: 'groups' }),
  });
  check('a stakeholder group can be created', group.ok);

  const issues = await (await fetch(`${base}/api/workspace/validate`)).json();
  const errors = issues.filter((i) => i.level === 'error');
  check('a workspace edited through the app (incl. a group) has no validation errors', errors.length === 0,
    errors.length ? JSON.stringify(errors.slice(0, 3)) : '');

  // Git integration: the dashboard can show status, stage and commit in a workspace repo.
  const git = (...args) => execFileSync('git', ['-C', ws, ...args], { env, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Smoke Test');
  git('config', 'user.email', 'smoke@example.com');
  git('config', 'commit.gpgsign', 'false');
  const post = (url, body) => fetch(`${base}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const status = await (await fetch(`${base}/api/workspace/git/status`)).json();
  check('git status sees the workspace files', status.is_repo === true && status.untracked.length > 0,
    `is_repo=${status.is_repo} untracked=${status.untracked?.length}`);
  check('git stage works', (await post('/api/workspace/git/stage', { file: 'README.md' })).ok);
  check('git commit works', (await post('/api/workspace/git/commit', { message: 'Smoke test commit' })).ok);
  const log = await (await fetch(`${base}/api/workspace/git/log`)).json();
  check('git log shows the commit', log[0]?.message === 'Smoke test commit', `log=${JSON.stringify(log[0] ?? null)}`);
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
