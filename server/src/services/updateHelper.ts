import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * Updating a global npm install from the dashboard (#284): the dashboard can't replace its own files while it runs
 * from them, so a small helper does it once the dashboard has stopped: npm install, gtd upgrade, gtd start. The helper
 * uses Node's own modules only, so nothing it needs is replaced under it, and writes how it went for the dashboard
 * that starts next.
 */

export interface UpdateJob {
  /** The dashboard to wait for: nothing is installed while it runs. */
  waitPid: number;
  version: string;
  /** The version running when the update started. */
  from: string;
  node: string;
  npmCli: string;
  npmArgs: string[];
  /** npm's arguments to put the version that was running back, when a failed install left the package unusable. */
  repairArgs: string[];
  /** The installed package's package.json and its gtd command, after the install. */
  packageJson: string;
  bin: string;
  workspace: string;
  port: number;
  resultFile: string;
  lockFile: string;
  logFile: string;
  /** gtd start's record of the dashboard it started: where it listens now. */
  pidFile: string;
  /** Where the dashboards running from this install say so, and this install's folder. */
  runtimesDir: string;
  root: string;
}

/** What the helper wrote when it ended. */
export interface UpdateResult {
  version: string;
  from: string;
  ok: boolean;
  error: string | null;
  upgrade_error: string | null;
  /** A failed install left the package unusable, and the version that was running was installed again. */
  repaired: boolean;
  restarted: boolean;
  start_error: string | null;
  /** The port the dashboard listens on after the restart (another when the old one was taken). */
  port: number | null;
  finished_at: string;
}

/** The helper, as a plain script: Node's own modules only. */
export const HELPER_SOURCE = String.raw`'use strict';
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const job = JSON.parse(process.argv[2]);
const log = (m) => { try { fs.appendFileSync(job.logFile, '[' + new Date().toISOString() + '] ' + m + '\n'); } catch (e) { /* no log */ } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const said = (r) => (String(r.stderr || '').split('\n').map((l) => l.replace(/^npm (ERR!|error) ?/, '').trim()).filter(Boolean).slice(-3).join(' ')
  || (r.error && r.error.message) || ('it ended with code ' + r.status)).slice(0, 400);
const installed = () => { try { return JSON.parse(fs.readFileSync(job.packageJson, 'utf-8')).version; } catch (e) { return null; } };
// The dashboard's own settings are not passed on; the workspace it showed is, so the same one starts again.
const env = Object.assign({}, process.env, { npm_config_update_notifier: 'false' });
for (const k of ['NODE_OPTIONS', 'ESB_WORKSPACE_PATH', 'ESB_UI_PATH', 'PORT', 'NODE_ENV']) delete env[k];
const result = { version: job.version, from: job.from, ok: false, error: null, upgrade_error: null, repaired: false, restarted: false, start_error: null, port: null, finished_at: null };
const readLock = () => { try { return JSON.parse(fs.readFileSync(job.lockFile, 'utf-8')); } catch (e) { return null; } };
/** Adds to the lock in one step, only while it is still this helper's; false when it could not. */
const markLock = (extra) => {
  const lock = readLock();
  if (!lock || lock.pid !== process.pid) return false;
  const tmp = job.lockFile + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(Object.assign(lock, extra))); fs.renameSync(tmp, job.lockFile); return true; } catch (e) { log('could not mark the lock: ' + e.message); return false; }
};
/** True while an npm this helper started may still run: then the lock is never let go. */
let npmRunning = false;
const finish = () => {
  result.finished_at = new Date().toISOString();
  const tmp = job.resultFile + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n'); fs.renameSync(tmp, job.resultFile); } catch (e) { log('could not save the result: ' + e.message); }
  // The lock is let go only while it is still this helper's, and never while its npm may still run.
  const lock = readLock();
  if (npmRunning) markLock({ npm: 'unresolved' });
  else if (lock && lock.pid === process.pid) { try { fs.unlinkSync(job.lockFile); } catch (e) { /* gone */ } }
  log('done: ' + JSON.stringify(result));
};
const run = (args, timeout, extra) => spawnSync(job.node, args, { env: Object.assign({}, env, extra || {}), cwd: job.workspace, encoding: 'utf-8', timeout, windowsHide: true, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
/**
 * npm, with its own process in the lock while it runs: stopping this helper never lets a second npm start over it.
 * The lock says npm is starting before it does; npm runs only once its process is in the lock.
 */
const npm = (args) => new Promise((resolve) => {
  if (!markLock({ npm: 'starting' })) { resolve({ status: null, stderr: '', error: new Error('the update lock could not be written, so npm was not run') }); return; }
  // In this helper's process group (it was started detached): on macOS and Linux the update counts as going while
  // anything in the group runs, npm included, also when this helper has been stopped.
  const child = spawn(job.node, [job.npmCli].concat(args), { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  npmRunning = true;
  let stderr = '';
  let unrecorded = false;
  let settled = false;
  const done = (status, error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    npmRunning = false;
    markLock({ npm: 'done', npm_pid: null });
    resolve({ status, stderr, error: unrecorded ? new Error('npm\'s process could not be recorded, so it was stopped') : error });
  };
  let failure = null;
  // Without a process it never ran; with one, only its end (close) says it stopped: a failed kill is an error too.
  child.on('error', (e) => { failure = e; if (!child.pid) done(null, e); });
  child.on('close', (code) => done(code, failure));
  if (child.stderr) child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20000); });
  // Stopped when it takes too long; only its end (close) counts as stopped.
  const timer = setTimeout(() => child.kill(), 10 * 60000);
  if (child.pid && !markLock({ npm: 'running', npm_pid: child.pid })) { unrecorded = true; child.kill(); }
});
/** The other dashboards running from this install now (not the one that stopped for the update). */
const others = () => {
  let names = [];
  try { names = fs.readdirSync(job.runtimesDir); } catch (e) { return []; }
  const ports = [];
  for (const name of names) {
    try {
      const r = JSON.parse(fs.readFileSync(job.runtimesDir + '/' + name, 'utf-8'));
      if (r.pid !== job.waitPid && r.root === job.root && alive(r.pid)) ports.push(r.port);
    } catch (e) { /* unreadable */ }
  }
  return ports;
};
/** Puts the version that was running back. */
const repair = async () => {
  if (others().length) { result.error = (result.error ? result.error + '. ' : '') + 'Another Get Things Done runs from this install, so ' + job.from + ' was not put back'; return; }
  const r = await npm(job.repairArgs);
  result.repaired = r.status === 0 && installed() === job.from && fs.existsSync(job.bin);
  if (!result.repaired) result.error = (result.error ? result.error + '. ' : '') + 'Putting ' + job.from + ' back did not work either (' + said(r) + ')';
};
/** gtd start; it counts only when a new dashboard runs, on this workspace. */
const startOnce = () => {
  const st = run([job.bin, 'start', '--no-open', '--port', String(job.port)], 90000, { ESB_WORKSPACE_PATH: job.workspace, GTD_UPDATE_HELPER: String(process.pid) });
  let daemon = null;
  try { daemon = JSON.parse(fs.readFileSync(job.pidFile, 'utf-8')); } catch (e) { /* none */ }
  result.restarted = st.status === 0 && !!daemon && daemon.pid !== job.waitPid && alive(daemon.pid) && daemon.workspace === job.workspace;
  result.port = daemon && typeof daemon.port === 'number' ? daemon.port : null;
  result.start_error = result.restarted ? null : said(st);
  return result.restarted;
};
(async () => {
  let start = true;
  try {
    log('updating to ' + job.version + ' from ' + job.from);
    // The dashboard hands the update lock over right after starting this helper; nothing is done without it.
    const handed = Date.now() + 10000;
    while (!(readLock() && readLock().pid === process.pid) && Date.now() < handed) await sleep(100);
    if (!(readLock() && readLock().pid === process.pid)) {
      result.error = 'The update was not handed over, so nothing was installed';
      finish();
      return;
    }
    const until = Date.now() + 30000;
    while (alive(job.waitPid) && Date.now() < until) await sleep(200);
    if (alive(job.waitPid)) {
      // It is still running: nothing installed, and nothing to start.
      result.error = 'The dashboard did not stop, so nothing was installed';
      start = false;
    } else if (others().length) {
      // One started meanwhile (or was missed): its files are never replaced under it.
      result.error = 'Another Get Things Done runs from this install (port ' + others().join(', ') + '), so nothing was installed';
      start = false;
    } else if (installed() !== job.from) {
      // Changed since the dashboard checked (a terminal install, for one): never replaced from here.
      result.error = 'The installed version changed to ' + (installed() || 'an unreadable one') + ' while the update was starting, so nothing was installed';
    } else {
      const r = await npm(job.npmArgs);
      if (r.status === 0 && installed() === job.version) {
        result.ok = true;
        const up = run([job.bin, 'upgrade', '--dir', job.workspace], 2 * 60000);
        if (up.status !== 0) result.upgrade_error = said(up);
      } else {
        result.error = r.status === 0 ? 'npm finished, but the version installed is ' + (installed() || 'unreadable') : said(r);
        // npm puts the old files back when it fails; when it could not, the version that was running is installed again.
        if (installed() !== job.from || !fs.existsSync(job.bin)) await repair();
      }
    }
    if (start && !startOnce() && !result.repaired) {
      // It does not start: the version that was running is installed again and started.
      if (result.ok) { result.ok = false; result.error = job.version + ' was installed but did not start (' + result.start_error + ')'; }
      await repair();
      if (result.repaired) startOnce();
    }
  } catch (e) {
    result.error = result.error || String((e && e.message) || e);
  }
  finish();
})();
`;

/** Writes the helper next to the update state and starts it on its own: it outlives the dashboard. */
export function startUpdateHelper(job: UpdateJob): number {
  const file = path.join(path.dirname(job.resultFile), 'update-helper.cjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, HELPER_SOURCE);
  const child = spawn(job.node, [file, JSON.stringify(job)], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  if (!child.pid) throw new Error('The update helper could not be started');
  return child.pid;
}
