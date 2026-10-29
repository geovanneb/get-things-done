// Starts the packaged app (release/, after `npm run package` or `npm run dist`) the way a new user would: an empty
// home folder and no git on PATH. Checks the first-run setup API, creates a workspace and a task, proves the bundled
// git runs, then quits the app. Used by .github/workflows/desktop.yml; works on macOS and Windows.
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(desktop, 'release');
const APP = 'Get Things Done';

function findExecutable() {
  if (process.platform === 'win32') return path.join(release, 'win-unpacked', `${APP}.exe`);
  if (process.platform === 'darwin') {
    const dir = fs.readdirSync(release).find((d) => d.startsWith('mac') && fs.existsSync(path.join(release, d, `${APP}.app`)));
    if (dir) return path.join(release, dir, `${APP}.app`, 'Contents', 'MacOS', APP);
  }
  throw new Error(`No packaged app found in ${release}. Run \`npm run package --prefix desktop\` first.`);
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findServer(deadline) {
  while (Date.now() < deadline) {
    for (let port = 3001; port < 3021; port++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/setup`, { signal: AbortSignal.timeout(500) });
        if (res.ok) return `http://127.0.0.1:${port}`;
      } catch {
        // not this port, or not up yet
      }
    }
    await sleep(500);
  }
  return null;
}

async function portClosed(base, deadline) {
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return true;
    }
    await sleep(500);
  }
  return false;
}

const executable = findExecutable();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-packaged-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });

// A new user's environment: nothing set up, and no git on PATH, so only the bundled git can work.
const env = process.platform === 'win32'
  ? {
      USERPROFILE: home, HOMEDRIVE: path.parse(home).root.replace(/\\$/, ''), HOMEPATH: home.slice(2),
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      SystemRoot: process.env['SystemRoot'], TEMP: tmp, TMP: tmp,
      PATH: path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32'),
    }
  : { HOME: home, PATH: '/bin', TMPDIR: tmp };

console.log(`Starting ${executable}`);
const child = spawn(executable, [`--user-data-dir=${path.join(tmp, 'user-data')}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });

let base = null;
try {
  base = await findServer(Date.now() + 60_000);
  check('the packaged app starts its server', base !== null);
  if (!base) throw new Error('server did not start');

  const status = await (await fetch(`${base}/api/setup`)).json();
  check('a new user gets the setup screen', status.configured === false && status.ai_tools?.length === 3);

  const page = await fetch(`${base}/`);
  check('the dashboard is served', page.ok && (await page.text()).includes('<div id="root">'));

  const workspace = path.join(home, 'Documents', 'Get Things Done');
  const created = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: workspace, create: true, profile: { name: 'Alex Morgan', role: 'COO', organization: 'Northwind Labs' }, ai_tools: ['codex'] }),
  });
  check('setup creates a workspace from the templates inside the app', created.status === 201 && fs.existsSync(path.join(workspace, 'AGENTS.md')));

  // The first thing a new user does: add a task, and see it on the board.
  const task = await (await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Prepare the Q4 steering update', priority: 'high', body: 'Fictional smoke test task.' }),
  })).json();
  const board = await (await fetch(`${base}/api/tasks`)).json();
  check('a new task is saved in the workspace and listed', Boolean(task.id) && board.some((t) => t.id === task.id && t.title === 'Prepare the Q4 steering update'), task.id);

  // The smoke test's own git makes the workspace a repository; the app must use its bundled git for the rest.
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  const git = await (await fetch(`${base}/api/workspace/git/enabled`)).json();
  check('git works without git on PATH (bundled git)', git.git_installed === true && git.git_enabled === true, JSON.stringify(git));
  const staged = await fetch(`${base}/api/workspace/git/stage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'workspace.yaml' }),
  });
  const gitStatus = await (await fetch(`${base}/api/workspace/git/status`)).json();
  check('the bundled git stages a file', staged.ok && gitStatus.staged?.includes('workspace.yaml'), JSON.stringify(gitStatus.staged));
} catch (err) {
  check('smoke test ran to the end', false, err instanceof Error ? err.message : String(err));
} finally {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  } else {
    child.kill('SIGTERM');
  }
  if (base) check('quitting the app stops its server', await portClosed(base, Date.now() + 15_000));
  child.kill('SIGKILL');
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* Windows may still hold files */ }
}

if (failures) {
  console.error(`\n${failures} check(s) failed. App output:\n${output.slice(-4000)}`);
  process.exit(1);
}
console.log('\nPackaged app smoke test passed');
