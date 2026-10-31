// Starts the packaged app (release/, after `npm run package` or `npm run dist`) the way a new user would: an empty
// home folder and no git on PATH. Checks the first-run setup API, creates a workspace, proves the bundled git runs,
// then quits the app. Used by .github/workflows/desktop.yml; works on macOS and Windows.
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
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

/** A free port far from 3001, so the test never talks to another copy of the app (or `gtd start`) on this machine. */
function freeHighPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function findServer(firstPort, deadline) {
  while (Date.now() < deadline) {
    // The app tries its saved port first, then the next ones.
    for (let port = firstPort; port < Math.min(firstPort + 20, 65536); port++) {
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

/**
 * The end of the app's server log, which holds the real error behind a 500 (the response hides it, and the server's
 * output goes to this file, not to the app's own). Its folder depends on the platform, and it is always under `dir`.
 */
function readServerLog(dir) {
  try {
    const found = fs.readdirSync(dir, { recursive: true }).find((f) => path.basename(String(f)) === 'server.log');
    return found ? fs.readFileSync(path.join(dir, String(found)), 'utf-8').slice(-4000) : '(no server.log found)';
  } catch (err) {
    return `(could not be read: ${err instanceof Error ? err.message : String(err)})`;
  }
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
// No update checks: the smoke test must not depend on the network or on published releases.
env.GTD_DISABLE_UPDATES = '1';
// With a models folder, the app also downloads a model and transcribes speech with it: only Electron shows what the
// engine may not do there. The model and the speed test's sample are the only downloads.
const models = process.env['GTD_SMOKE_MODELS'];
const MODEL = 'sensevoice-2024-07-17';
if (models) env.ESB_MODELS_PATH = path.resolve(models);

// The app reads its port from desktop.json in its user data folder.
const userData = path.join(tmp, 'user-data');
const port = await freeHighPort();
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'desktop.json'), JSON.stringify({ port }));

console.log(`Starting ${executable} on port ${port}`);
const child = spawn(executable, [`--user-data-dir=${userData}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
let serverLog = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });
child.on('error', (error) => { output += `Spawn failed: ${error.message}\n`; });

let base = null;
try {
  base = await findServer(port, Date.now() + 60_000);
  check('the packaged app starts its server', base !== null);
  if (!base) throw new Error('server did not start');

  // Never change anything unless this is the copy we started: its suggested folder is inside our temporary home.
  // (A copy started another way, for example by macOS on the first run of a new build, would use the real home.)
  const status = await (await fetch(`${base}/api/setup`)).json();
  const ours = typeof status.suggested_path === 'string' && path.resolve(status.suggested_path) === path.join(home, 'Documents', 'Get Things Done');
  check('the server belongs to the app this test started', ours, status.suggested_path);
  if (!ours) {
    base = null;
    throw new Error('connected to an app that uses another home folder; stopping before any change');
  }

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

  // Persist and read back a fictional task, through the API (Phase 1 acceptance).
  const taskResponse = await fetch(`${base}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Prepare the Q4 steering update', priority: 'high', body: 'Fictional smoke test task.' }),
  });
  const task = await taskResponse.json();
  const boardResponse = await fetch(`${base}/api/tasks`);
  const board = await boardResponse.json();
  check('a new task is saved in the workspace and listed', taskResponse.status === 201 && boardResponse.ok &&
    Array.isArray(board) && board.some((t) => t.id === task.id && t.title === 'Prepare the Q4 steering update'), JSON.stringify(task));

  // The smoke test's own git makes the workspace a repository; the app must use its bundled git for the rest.
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  // The worker starts as Electron running as Node and loads the native engine from inside the app (no model needed).
  const engine = await (await fetch(`${base}/api/transcription/engine`)).json();
  check('the transcription engine loads inside the app', engine.available === true && typeof engine.version === 'string', JSON.stringify(engine));
  // Whisper on the GPU ships in the Apple Silicon build only. It must be inside the app, signed with it, and start
  // there; a model to run it is not needed for that (the build machine's GPU is not the user's).
  if (process.platform === 'darwin') {
    const helper = path.join(path.dirname(path.dirname(executable)), 'Resources', 'whisper', 'gtd-whisper');
    const expected = process.arch === 'arm64' && process.env['GTD_SMOKE_EXPECT_GPU'] !== '0';
    check(expected ? 'the app has the GPU engine' : 'the Intel app has no GPU engine', engine.gpu === expected && fs.existsSync(helper) === expected, JSON.stringify(engine));
    if (expected) {
      let answer = '';
      try { execFileSync(helper, [], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (err) { answer = String(err.stdout ?? ''); }
      check('the GPU engine starts from inside the app', answer.includes('"type":"error"'), answer);
      let signed = true;
      try { execFileSync('codesign', ['--verify', '--strict', helper], { stdio: 'ignore' }); } catch { signed = false; }
      check('the GPU engine is signed with the app', signed);
    }
  }

  if (models) {
    const model = async () => (await (await fetch(`${base}/api/transcription`)).json()).models.find((m) => m.id === MODEL);
    if (!(await model()).installed) {
      const started = await fetch(`${base}/api/transcription/models/${MODEL}/download`, { method: 'POST' });
      check('the app starts downloading a model', started.ok, await started.text());
    }
    const until = Date.now() + 10 * 60_000;
    let state = await model();
    while (!state.installed && state.download?.status !== 'failed' && Date.now() < until) { await sleep(2000); state = await model(); }
    check('the app downloads a model', state.installed === true, JSON.stringify(state.download));
    const speed = await fetch(`${base}/api/transcription/models/${MODEL}/speed-test`, { method: 'POST' });
    const measured = await speed.text();
    check('the app transcribes with it', speed.ok && JSON.parse(measured).realtime_x > 0, measured);
  }

  const git = await (await fetch(`${base}/api/workspace/git/enabled`)).json();
  check('git works without git on PATH (bundled git)', git.git_installed === true && git.git_enabled === true, JSON.stringify(git));
  const staged = await fetch(`${base}/api/workspace/git/stage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'workspace.yaml' }),
  });
  const stageBody = await staged.text();
  const gitStatus = await (await fetch(`${base}/api/workspace/git/status`)).json();
  check('the bundled git stages a file', staged.ok && gitStatus.staged?.includes('workspace.yaml'), JSON.stringify({ status: staged.status, response: stageBody, gitStatus }));
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
  if (failures) serverLog = readServerLog(tmp);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* Windows may still hold files */ }
}

if (failures) {
  console.error(`\n${failures} check(s) failed. App output:\n${output.slice(-4000)}\nServer log:\n${serverLog}`);
  process.exit(1);
}
console.log('\nPackaged app smoke test passed');
