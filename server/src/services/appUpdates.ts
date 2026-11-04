import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { atomicWrite } from '../utils/atomicWrite';
import { lock, unlock } from '../utils/fileLock';
import { getAppVersion, readAppVersion } from './scaffold';
import { busyReason, setUpdating } from './appActivity';
import { WorkspaceService } from './workspace';
import { processAlive } from './runState';
import { startUpdateHelper, type UpdateResult } from './updateHelper';

/**
 * Whether a newer version of the app is out, and how this install gets it (#284). A global npm install can install it
 * from here (`install`); the desktop app keeps its own updater.
 *
 * Apart from AI tool runs the user starts or turns on, the check is the only request the app makes on its own, once a
 * day while automatic checks are on: it asks for the newest version number (the npm registry through the user's own
 * npm and its settings, with npm's own update notice off, or the desktop app's update feed on GitHub) and sends
 * nothing from the workspace.
 *
 * State, shared by every dashboard of this user, in `~/.gtd/updates.json` (or GTD_UPDATES_PATH), changed under a lock:
 *   { auto_check, dismissed, results: { <source>: { latest, checked_at, error } } }
 * A result belongs to where it came from (npm, or a desktop channel on a system), so installs of different kinds on
 * one computer never take each other's answers.
 */

const PACKAGE = '@bertonha/getthingsdone';
const RELEASES = 'https://github.com/geovanneb/get-things-done/releases';
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 20_000;
/** "Check now" asks again at most this often, whoever presses it. */
const CHECK_NOW_GAP_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
/** Whether npm could install here is asked again after this long (it runs npm once). */
const INSTALL_CHECK_MS = 5 * 60_000;

/** How this copy of the app was installed, so it is told how to update. */
export type InstallKind = 'desktop' | 'npm' | 'npm-local' | 'npx' | 'source';

export interface UpdateStatus {
  current: string;
  /** The newest version found, or null before the first check. */
  latest: string | null;
  /** Strictly newer than `current`: an older or equal `latest` is never offered. */
  newer: boolean;
  kind: InstallKind;
  /** The release channel checked (one, stable, for now). */
  channel: string;
  /**
   * - `self`: the desktop app downloads it by itself and asks to restart;
   * - `command`: run `commands`;
   * - `manual`: this copy can't update itself (an unsigned or preview desktop build, a copy run from source).
   */
  how: 'self' | 'command' | 'manual';
  commands: string[];
  release_url: string;
  notes_url: string | null;
  auto_check: boolean;
  /** The version whose notice the user put off with Later. */
  dismissed: string | null;
  checked_at: string | null;
  checking: boolean;
  error: string | null;
  /** Something important running now (a recording, a transcription, an AI tool run): no notice meanwhile. */
  busy: string | null;
  /**
   * A global npm install with a newer version found: whether "Update" can install it from here now, and if not, why
   * (then the commands are the way). Always false for other installs.
   */
  can_install: boolean;
  install_blocked: string | null;
  /** An update is going now, from this or another dashboard: the dashboard restarts on its own. */
  installing: boolean;
  /** Installed on disk, newer than the version running: restart to finish. */
  installed: string | null;
  /** Why the last update from the dashboard did not finish (the version that was running started again), or what is left to do. */
  install_error: string | null;
  /** The last update from the dashboard, to this version, finished. */
  updated: string | null;
}

interface Result { latest: string | null; checked_at: string | null; error: string | null }

interface Stored {
  auto_check: boolean;
  dismissed: string | null;
  results: Record<string, Result>;
  /** The file was there but could not be read: automatic checks stay off until the user turns them on again. */
  unreadable: boolean;
}

/** Where the newest version comes from; replaced in tests so they never reach the network. */
export type LatestSource = (kind: InstallKind, channel: string) => Promise<string>;

// Semantic versioning 2.0: no leading zeros, non-empty identifiers, build metadata allowed (and ignored for order).
const NUM = '(0|[1-9]\\d{0,8})';
const IDENT = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && SEMVER.test(value);
}

/** Below zero when `a` comes before `b`, by semantic versioning's precedence. */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) throw new Error(`Not a version: ${x ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d;
  }
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  const p = x[4].split('.');
  const q = y[4].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const pn = /^\d+$/.test(p[i]!);
    const qn = /^\d+$/.test(q[i]!);
    // Numbers of any length (no leading zeros): the longer is larger, else as text.
    if (pn && qn) { if (p[i]!.length !== q[i]!.length) return p[i]!.length - q[i]!.length; if (p[i] !== q[i]) return p[i]! < q[i]! ? -1 : 1; continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p[i] !== q[i]) return p[i]! < q[i]! ? -1 : 1;
  }
  return 0;
}

/** The app's own folder: where its package.json is (the same file `getAppVersion` reads). */
function appRoot(): string {
  for (const dir of [path.resolve(__dirname, '../../..'), path.resolve(__dirname, '../../../..')]) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return process.cwd();
}

/**
 * The desktop app says so (GTD_INSTALL); otherwise judged from where the app's files are. In npm's global folder
 * (`<prefix>/lib/node_modules`, or `…\npm\node_modules` on Windows) nothing above `node_modules` is a project; a copy
 * in a project's own `node_modules` is updated in that project instead.
 */
export function installKind(root = appRoot(), env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): InstallKind {
  if (env['GTD_INSTALL'] === 'desktop') return 'desktop';
  const parts = root.split(/[\\/]+/);
  if (parts.includes('_npx')) return 'npx';
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return 'source';
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const above = parts.slice(0, at).join(sep) || sep;
  return exists(`${above}${sep}package.json`) ? 'npm-local' : 'npm';
}

function storePath(): string {
  return process.env['GTD_UPDATES_PATH'] || path.join(os.homedir(), '.gtd', 'updates.json');
}

function readResult(value: unknown): Result | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  return {
    latest: isVersion(o['latest']) ? o['latest'] : null,
    checked_at: typeof o['checked_at'] === 'string' ? o['checked_at'] : null,
    error: typeof o['error'] === 'string' ? o['error'].slice(0, 300) : null,
  };
}

async function readStored(): Promise<Stored> {
  const text = await fsp.readFile(storePath(), 'utf-8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : ''));
  if (text === null) return { auto_check: true, dismissed: null, results: {}, unreadable: false };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { raw = null; }
  // Damaged or unreadable: what the user chose is unknown, so nothing is asked by itself until they say again.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { auto_check: false, dismissed: null, results: {}, unreadable: true };
  const o = raw as Record<string, unknown>;
  // The user's choice must be there, as written by the dashboard: anything else is as unknown as a damaged file.
  if (typeof o['auto_check'] !== 'boolean') return { auto_check: false, dismissed: null, results: {}, unreadable: true };
  const results: Record<string, Result> = {};
  const found = o['results'] && typeof o['results'] === 'object' && !Array.isArray(o['results']) ? o['results'] as Record<string, unknown> : {};
  for (const [key, value] of Object.entries(found)) { const r = readResult(value); if (r && /^[a-z0-9:-]{1,80}$/.test(key)) results[key] = r; }
  return { auto_check: o['auto_check'], dismissed: isVersion(o['dismissed']) ? o['dismissed'] : null, results, unreadable: false };
}

/** Reads, changes and writes the state as one step, across dashboards. */
async function changeStored(change: (s: Stored) => Stored): Promise<Stored> {
  await fsp.mkdir(path.dirname(storePath()), { recursive: true });
  const held = await lock(`${storePath()}.lock`, LOCK_WAIT_MS, () => Object.assign(new Error('The update settings are being saved elsewhere; try again in a moment'), { statusCode: 409 }));
  try {
    const next = change(await readStored());
    await atomicWrite(storePath(), JSON.stringify({ auto_check: next.auto_check, dismissed: next.dismissed, results: next.results }, null, 2) + '\n');
    return { ...next, unreadable: false };
  } finally {
    await unlock(held);
  }
}

/** The npm that comes with this node, run by node itself (never a shell): the user's own npm settings apply. */
function npmCli(): string | null {
  const real = path.dirname(fs.realpathSync(process.execPath));
  const linked = path.dirname(process.execPath);
  const candidates = [
    path.join(real, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(real, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(real, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(linked, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** npm's arguments for the one question asked: no update notice of its own, no other request. */
export const NPM_VIEW_ARGS = ['view', `${PACKAGE}@latest`, 'version', '--json', '--prefer-online', '--update-notifier=false', '--no-audit', '--no-fund'];

function run(file: string, args: string[], timeout = CHECK_TIMEOUT_MS): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, npm_config_update_notifier: 'false' };
  delete env['NODE_OPTIONS'];
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 4 << 20, windowsHide: true, env }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      // npm's own words, last lines first: what failed, without the whole log.
      const said = String(stderr || '').split('\n').map((l) => l.replace(/^npm (ERR!|error) ?/, '').trim()).filter(Boolean);
      const why = err.killed ? 'it took too long and was stopped' : said.slice(-3).join(' ') || err.message;
      reject(new Error(why.slice(0, 400)));
    });
  });
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.text();
}

/** The update feed file electron-updater reads for this channel on this system. */
export function feedFile(channel: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? `${channel}-mac.yml` : platform === 'linux' ? `${channel}-linux.yml` : `${channel}.yml`;
}

/** Asks npm (as the user set it up) for the newest version; `cli` is npm's own script, found next to this node. */
export async function npmLatest(cli: string | null = npmCli()): Promise<string> {
  if (!cli) throw new Error('npm could not be found next to this node');
  const out = JSON.parse(await run(process.execPath, [cli, ...NPM_VIEW_ARGS]));
  if (!isVersion(out)) throw new Error('npm gave no version');
  return out;
}

const defaultSource: LatestSource = async (kind, channel) => {
  if (kind === 'desktop') {
    const feed = await fetchText(`${RELEASES}/latest/download/${feedFile(channel)}`);
    const version = /^version:\s*['"]?([^'"\s]+)/m.exec(feed)?.[1];
    if (!isVersion(version)) throw new Error('The update feed gave no version');
    return version;
  }
  return npmLatest();
};

/**
 * Updates this install and says whether it could here; replaced in tests so they never install anything. `start`
 * hands the update to a helper that runs once this dashboard has stopped, and returns the helper's process id.
 */
export interface Installer {
  /** null when npm can update this copy from here now, else why not. */
  blocked(workspace: string | null): Promise<string | null>;
  start(job: { version: string; from: string; workspace: string }): number;
  /** The version installed on disk now. */
  installedVersion(): string;
}

/** npm's arguments for the install: exactly that version of this package, globally, with nothing else asked. */
export function npmInstallArgs(version: string): string[] {
  if (!isVersion(version)) throw new Error(`Not a version: ${version}`);
  return ['install', '--global', `${PACKAGE}@${version}`, '--update-notifier=false', '--no-audit', '--no-fund', '--no-progress'];
}

/** Where npm installs global packages under a prefix, and their commands. */
export function globalDirs(prefix: string, platform: NodeJS.Platform = process.platform): { modules: string; bin: string } {
  return platform === 'win32' ? { modules: path.join(prefix, 'node_modules'), bin: prefix } : { modules: path.join(prefix, 'lib', 'node_modules'), bin: path.join(prefix, 'bin') };
}

const real = (p: string): string | null => { try { return fs.realpathSync(p); } catch { return null; } };
const writable = (p: string): boolean => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };

/**
 * Why npm can't update the copy at `root` (null when it can): npm must be there, its global folder (as the user's npm
 * config sets it) must hold this very copy, as a folder and not a link to one elsewhere, and that folder, the package's
 * scope folder and the commands' folder must be writable.
 */
export async function npmInstallBlocked(cli: string | null, root: string): Promise<string | null> {
  if (!cli) return 'npm could not be found next to this node';
  let prefix: string;
  try { prefix = (await run(process.execPath, [cli, 'prefix', '--global', '--update-notifier=false'])).trim(); } catch (err) {
    return `npm could not say where it installs (${(err as Error).message})`;
  }
  if (!prefix || !path.isAbsolute(prefix)) return 'npm could not say where it installs';
  const { modules, bin } = globalDirs(prefix);
  const scope = path.join(modules, PACKAGE.split('/')[0]!);
  const pkg = path.join(scope, PACKAGE.split('/')[1]!);
  let linked = false;
  try { linked = fs.lstatSync(pkg).isSymbolicLink(); } catch { /* not there: the check below says so */ }
  const here = real(root);
  if (!here || linked || here !== real(pkg)) return 'This copy is not the one in npm\'s global folder (npm is set to install somewhere else)';
  if (!writable(modules) || !writable(scope) || !writable(bin)) return 'npm\'s global folder can\'t be written by your user (it may need administrator rights)';
  return null;
}

const pidFile = () => path.join(os.homedir(), '.gtd', 'gtd.pid');

/** The dashboard `gtd start` started and recorded (`~/.gtd/gtd.pid`), or null: only that one can restart itself. */
function recordedDashboard(): { pid: number; port: number } | null {
  try {
    const state = JSON.parse(fs.readFileSync(pidFile(), 'utf-8')) as { pid?: unknown; port?: unknown };
    return typeof state.pid === 'number' && typeof state.port === 'number' ? { pid: state.pid, port: state.port } : null;
  } catch { return null; }
}

const updateDir = () => path.dirname(storePath());
const currentWorkspace = (): string | null => { try { return new WorkspaceService().getWorkspacePath(); } catch { return null; } };
const runtimesDir = () => path.join(updateDir(), 'runtimes');

/** This install's folder, as the lock and the runtime records name it. */
const installRoot = (): string => real(appRoot()) ?? appRoot();

/**
 * Says this dashboard runs from this install, until it stops: an update of the same install waits for it. Returns how
 * to take it back.
 */
export function registerRuntime(port: number): () => void {
  const file = path.join(runtimesDir(), `${process.pid}.json`);
  try {
    fs.mkdirSync(runtimesDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, root: installRoot() }));
  } catch { /* not known to the others: an update elsewhere can't wait for it */ }
  return () => { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } };
}

/**
 * A dashboard starting: known to the others first, then refused while an update of this install is going, so either
 * the update sees it or it sees the update. The dashboard the update's own helper starts is let in (GTD_UPDATE_HELPER).
 */
export function admitRuntime(port: number): () => void {
  const unregister = registerRuntime(port);
  const going = updateGoing();
  const halfWay = going ? null : unresolved();
  const owner = going ?? halfWay;
  if (owner && owner.root === installRoot() && owner.pid !== Number(process.env['GTD_UPDATE_HELPER'])) {
    unregister();
    throw new Error(halfWay
      ? `The last update of Get Things Done was stopped while npm ran. Once no npm runs any more, delete ${lockFile()} and run npm install -g ${PACKAGE}@${halfWay.version || 'latest'}, then start it again`
      : `Get Things Done is being updated to ${owner.version || 'a new version'}; start it again in a minute`);
  }
  return unregister;
}

/** The other dashboards running from this very install, by their port. */
export function otherRuntimes(): number[] {
  const root = installRoot();
  const ports: number[] = [];
  let names: string[];
  try { names = fs.readdirSync(runtimesDir()); } catch { return ports; }
  for (const name of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(runtimesDir(), name), 'utf-8')) as { pid?: unknown; port?: unknown; root?: unknown };
      if (typeof r.pid !== 'number' || r.pid === process.pid || r.root !== root) continue;
      if (processAlive(r.pid)) ports.push(typeof r.port === 'number' ? r.port : 0);
      else fs.rmSync(path.join(runtimesDir(), name), { force: true });
    } catch { /* unreadable: skipped */ }
  }
  return ports;
}
const lockFile = () => path.join(updateDir(), 'update.lock');
const resultFile = () => path.join(updateDir(), 'update-result.json');

/** An update takes minutes; a lock older than this belongs to no update going, whatever process has its number now. */
const LOCK_STALE_MS = 30 * 60_000;

interface Lock { pid: number; version: string; at: number; root: string | null; npm: string | null; npm_pid: number | null }

function readLock(): Lock | null {
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile(), 'utf-8')) as { pid?: unknown; version?: unknown; at?: unknown; root?: unknown; npm?: unknown; npm_pid?: unknown };
    const at = typeof lock.at === 'string' ? Date.parse(lock.at) : NaN;
    return typeof lock.pid === 'number' && Number.isFinite(at)
      ? { pid: lock.pid, version: isVersion(lock.version) ? lock.version : '', at, root: typeof lock.root === 'string' ? lock.root : null, npm: typeof lock.npm === 'string' ? lock.npm : null, npm_pid: typeof lock.npm_pid === 'number' ? lock.npm_pid : null }
      : null;
  } catch { return null; }
}

/**
 * The update going now, from any dashboard: a lock not older than an update takes, whose helper or npm still runs
 * (npm, when the helper was stopped half way: no second npm may start over it).
 */
function updateGoing(): Lock | null {
  const lock = readLock();
  if (!lock) return null;
  // npm writing the install: going however long it takes.
  if (lock.npm_pid !== null && processAlive(lock.npm_pid)) return lock;
  // macOS and Linux: the helper leads its own process group, npm in it; anything of it running means it is going.
  if (groupAlive(lock.pid)) return lock;
  return processAlive(lock.pid) && Date.now() - lock.at < LOCK_STALE_MS ? lock : null;
}

/** Whether any process of a process group still runs (never on Windows, which has none). */
function groupAlive(leader: number): boolean {
  if (process.platform === 'win32' || leader <= 1) return false;
  try { process.kill(-leader, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A lock left behind with no result after it: the helper was stopped half way. */
function updateInterrupted(): Lock | null {
  const lock = readLock();
  if (!lock || updateGoing()) return null;
  const last = lastResult();
  return last && Date.parse(last.finished_at) >= lock.at ? null : lock;
}

/**
 * Stopped half way while npm was starting or running, where that npm can't be followed (Windows: no process groups):
 * whether it still writes the install is not known, so no update and no dashboard start from here until the lock is
 * removed by hand, once no npm runs. On macOS and Linux the process group answers it (`updateGoing`).
 */
function unresolved(): Lock | null {
  if (process.platform !== 'win32') return null;
  const lock = readLock();
  // Judged from the lock alone: a result written meanwhile says nothing about whether npm stopped.
  return lock && !updateGoing() && lock.npm !== null && lock.npm !== 'done' ? lock : null;
}

/** Writes the lock in one step (a reader never sees half of it). */
function writeLock(pid: number, version: string): void {
  const tmp = `${lockFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid, version, at: new Date().toISOString(), root: installRoot() }));
  fs.renameSync(tmp, lockFile());
}

/**
 * Takes the update lock for this process, or says who holds it. The file appears whole or not at all (a hard link of a
 * finished file), and taking over a lock whose update is gone happens under a short mutex, so two dashboards can't both
 * take it.
 */
async function takeLock(version: string): Promise<void> {
  fs.mkdirSync(updateDir(), { recursive: true });
  const busy = () => Object.assign(new Error('An update is being installed already'), { statusCode: 409 });
  const held = await lock(`${lockFile()}.take`, LOCK_WAIT_MS, busy);
  const tmp = `${lockFile()}.${process.pid}.new`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, version, at: new Date().toISOString(), root: installRoot() }));
    if (fs.existsSync(lockFile())) {
      if (updateGoing()) throw busy();
      fs.rmSync(lockFile(), { force: true });
    }
    try { fs.linkSync(tmp, lockFile()); } catch { throw busy(); }
  } finally {
    fs.rmSync(tmp, { force: true });
    await unlock(held);
  }
}

/** Removes the lock only while it is this process's. */
function dropOwnLock(): void {
  if (readLock()?.pid === process.pid) fs.rmSync(lockFile(), { force: true });
}

/** The npm update the dashboard hands to its helper: fixed arguments, no shell, the user's npm and its settings. */
const npmInstaller: Installer = {
  blocked: async (workspace) => {
    const dashboard = recordedDashboard();
    if (!dashboard || dashboard.pid !== process.pid) return 'This dashboard was not started with gtd start in the background, so it can\'t restart itself';
    if (!workspace) return 'No workspace is open';
    const others = otherRuntimes();
    if (others.length) return `Another Get Things Done runs from this install (port ${others.join(', ')}): stop it first`;
    return npmInstallBlocked(npmCli(), appRoot());
  },
  start: ({ version, from, workspace }) => {
    const cli = npmCli();
    const dashboard = recordedDashboard();
    if (!cli || !dashboard) throw new Error('npm or this dashboard\'s record could not be found');
    const root = appRoot();
    return startUpdateHelper({
      waitPid: process.pid, version, from, node: process.execPath, npmCli: cli, npmArgs: npmInstallArgs(version),
      repairArgs: npmInstallArgs(from),
      packageJson: path.join(root, 'package.json'), bin: path.join(root, 'bin', 'gtd.js'), workspace, port: dashboard.port,
      runtimesDir: runtimesDir(), root: installRoot(),
      resultFile: resultFile(), lockFile: lockFile(), logFile: path.join(updateDir(), 'update.log'), pidFile: pidFile(),
    });
  },
  installedVersion: readAppVersion,
};

let installer: Installer = npmInstaller;
/** Tests only: the kind of install to act as (a test runs from the source). */
let testKind: InstallKind | null = null;
const thisInstall = (): InstallKind => testKind ?? installKind();
/** Set from the first moment of an install request in this process, before anything is awaited. */
let starting = false;
let blockedCache: { at: number; reason: Promise<string | null> } | null = null;

/**
 * The dashboard handed an update to its helper but did not stop (the helper gave up waiting): it carries on as it was,
 * and the helper's result says nothing was installed.
 */
export function updateHandoffFailed(): void {
  starting = false;
  setUpdating(false);
}

/** Tests only: how updates are installed, the kind of install to act as, and a clean slate. */
export function setInstallerForTests(next: Installer | null, kind: InstallKind | null = null): void {
  installer = next ?? npmInstaller;
  testKind = kind;
  starting = false;
  setUpdating(false);
  blockedCache = null;
}

/** Why npm can't update from here, asked at most every few minutes (it runs npm); concurrent asks share one. */
function installBlocked(workspace: string | null, fresh = false): Promise<string | null> {
  if (fresh || !blockedCache || Date.now() - blockedCache.at >= INSTALL_CHECK_MS) {
    blockedCache = { at: Date.now(), reason: installer.blocked(workspace).catch((err: Error) => err.message || 'npm could not be checked') };
  }
  return blockedCache.reason;
}

/** The version on disk when it can be read; null when it can't (then nothing is installed: fail closed). */
function onDisk(): string | null {
  const v = installer.installedVersion();
  return isVersion(v) ? v : null;
}

/** The version on disk when it is newer than the one running: installed (in a terminal), waiting for a restart. */
function installedNewer(): string | null {
  const v = onDisk();
  const running = getAppVersion();
  return v && isVersion(running) && compareVersions(v, running) > 0 ? v : null;
}

/** How the last update from the dashboard ended, as its helper wrote it. */
function lastResult(): UpdateResult | null {
  try {
    const r = JSON.parse(fs.readFileSync(resultFile(), 'utf-8')) as UpdateResult;
    return isVersion(r.version) && isVersion(r.from) ? r : null;
  } catch { return null; }
}

let source: LatestSource = defaultSource;
let checking: Promise<Stored> | null = null;
let lastAsked = 0;

/** Tests only: where the newest version comes from (and "Check now" may ask again at once). */
export function setLatestSourceForTests(next: LatestSource | null): void {
  source = next ?? defaultSource;
  lastAsked = 0;
}

/** Whether this process may not ask the network at all: tests, the smoke test, or GTD_DISABLE_UPDATES=1. */
function disabled(): boolean {
  return process.env['GTD_DISABLE_UPDATES'] === '1' || process.env['NODE_ENV'] === 'test';
}

function channel(): string {
  const c = process.env['GTD_UPDATE_CHANNEL'];
  return c && /^[a-z0-9-]{1,40}$/.test(c) ? c : 'latest';
}

/** Where this install's answer comes from, and so where it is kept. */
function sourceKey(kind = thisInstall()): string {
  return kind === 'desktop' ? `desktop:${channel()}:${process.platform}` : 'npm';
}

/** Asks for the newest version once (concurrent asks share it) and keeps the answer, or why it failed. */
async function check(): Promise<Stored> {
  checking ??= (async () => {
    lastAsked = Date.now();
    const at = new Date().toISOString();
    const key = sourceKey();
    let result: Result;
    if (disabled() && source === defaultSource) {
      // Never the network where it is turned off; an injected source (tests) may still answer.
      result = { latest: null, checked_at: at, error: 'Checking for updates is turned off here' };
    } else {
      try {
        const latest = await source(thisInstall(), channel());
        if (!isVersion(latest)) throw new Error('No version was given');
        result = { latest, checked_at: at, error: null };
      } catch (err) {
        result = { latest: null, checked_at: at, error: (err as Error).message || 'The check failed' };
      }
    }
    // A failure keeps the version found before, with why this check did not work.
    return changeStored((s) => ({ ...s, results: { ...s.results, [key]: result.error ? { latest: s.results[key]?.latest ?? null, checked_at: at, error: result.error } : result } }));
  })().finally(() => { checking = null; });
  return checking;
}

async function describe(stored: Stored, workspace: string | null): Promise<UpdateStatus> {
  const current = getAppVersion();
  const kind = thisInstall();
  const result = stored.results[sourceKey(kind)] ?? { latest: null, checked_at: null, error: null };
  const newer = result.latest !== null && isVersion(current) && compareVersions(result.latest, current) > 0;
  const how: UpdateStatus['how'] = kind === 'desktop' ? (process.env['GTD_UPDATES'] === 'on' ? 'self' : 'manual') : kind === 'source' ? 'manual' : 'command';
  const installed = kind === 'npm' ? installedNewer() : null;
  const target = installed ?? (newer ? result.latest! : 'latest');
  const busy = await busyReason(workspace).catch(() => null);
  const going = kind === 'npm' ? updateGoing() : null;
  const disk = kind === 'npm' ? onDisk() : null;
  // Offered only for a global npm install, a version newer than both the running and the installed one, nothing
  // important running and no update going.
  const offer = kind === 'npm' && newer && disk !== null && compareVersions(result.latest!, disk) > 0;
  const halfWay = kind === 'npm' ? unresolved() : null;
  const blocked = !offer || going || starting ? null
    : halfWay ? `the last update was stopped while npm ran. Once no npm runs any more, delete ${lockFile()} and finish it with the commands below`
      : busy ?? await installBlocked(workspace);
  const last = kind === 'npm' ? lastResult() : null;
  const recent = last !== null && Date.now() - Date.parse(last.finished_at) < 24 * 60 * 60 * 1000;
  const interrupted = kind === 'npm' ? updateInterrupted() : null;
  const commands = kind === 'npm' ? [...(installed ? [] : [`npm install -g ${PACKAGE}@${target}`]), 'gtd stop', 'gtd upgrade', 'gtd start']
    : kind === 'npm-local' ? ['npx gtd stop', `npm install ${PACKAGE}@${target}`, 'npx gtd upgrade', 'npx gtd start']
      : kind === 'npx' ? ['stop', 'upgrade', 'start'].map((c) => `npx ${PACKAGE}@${target} ${c}`) : [];
  return {
    current, latest: result.latest, newer, kind, channel: channel(), how, commands,
    release_url: `${RELEASES}/latest`,
    notes_url: result.latest ? `${RELEASES}/tag/v${result.latest}` : null,
    auto_check: stored.auto_check, dismissed: stored.dismissed, checked_at: result.checked_at,
    checking: checking !== null,
    error: stored.unreadable ? 'The saved update settings could not be read, so automatic checks are off until you turn them on again' : result.error,
    busy,
    can_install: offer && !going && !starting && blocked === null,
    install_blocked: blocked,
    installing: going !== null || starting,
    installed,
    install_error: interrupted ? `The update to ${interrupted.version || 'a new version'} was stopped half way. Run the commands below to finish it.`
      : !recent || !last ? null
        : !last.ok ? [
          last.error ?? 'The update did not install',
          last.repaired ? `${last.from} was put back.` : '',
          !last.restarted && last.start_error ? `Starting the dashboard did not work either (${last.start_error}).` : '',
        ].filter(Boolean).join(' ')
          : last.version === current && last.upgrade_error ? `Updated, but refreshing the app's files in your workspace did not finish (${last.upgrade_error}). Run gtd upgrade.` : null,
    updated: recent && last?.ok && last.version === current ? last.version : null,
  };
}

/**
 * "Update": updates this global npm install to the version the check found, and restarts. The dashboard can't replace
 * its own files while it runs from them, so a helper does it once the dashboard has stopped (npm install, gtd upgrade,
 * gtd start) and the page reconnects. Only that exact version, newer than both the running and the installed one,
 * never while something important runs, one update at a time across dashboards. When npm fails, the version that was
 * running starts again and says why. The caller stops the dashboard after answering.
 */
export async function install(version: unknown, workspace: string | null = null): Promise<UpdateStatus> {
  const refuse = (status: number, message: string) => Object.assign(new Error(message), { statusCode: status });
  // Claimed before anything is awaited, so two requests at once can't both go on.
  if (starting) throw refuse(409, 'An update is being installed already');
  starting = true;
  let started = false;
  try {
    if (thisInstall() !== 'npm') throw refuse(409, 'Only a global npm install can be updated from here');
    if (!workspace) throw refuse(409, 'No workspace is open');
    const found = (await readStored()).results[sourceKey('npm')]?.latest ?? null;
    if (!isVersion(version) || version !== found) throw refuse(400, 'Invalid version: only the version the check found can be installed');
    const running = getAppVersion();
    const disk = onDisk();
    if (!isVersion(running) || disk === null) throw refuse(409, 'The installed version could not be read, so nothing is installed');
    for (const [what, v] of [['running', running], ['installed', disk]] as const) {
      if (compareVersions(version, v) <= 0) throw refuse(409, `${version} is not newer than the ${what} ${v}: an update never goes back`);
    }
    if (updateGoing()) throw refuse(409, 'An update is being installed already');
    if (unresolved()) throw refuse(409, 'The last update was stopped while npm ran: finish it with the commands');
    const busy = await busyReason(workspace).catch(() => null);
    if (busy) throw refuse(409, `${busy}: update when it is done`);
    const blocked = await installBlocked(workspace, true);
    if (blocked) throw refuse(409, blocked);
    await takeLock(version);
    try {
      // Admission closes first, then what runs is checked again: nothing can start between the two.
      setUpdating(true);
      const now = await busyReason(workspace).catch(() => null);
      if (now) throw refuse(409, `${now}: update when it is done`);
      // The workspace to start again on is the one open now (a switch may have finished during the checks).
      if (currentWorkspace() !== workspace) throw refuse(409, 'The workspace changed meanwhile: try again');
      const others = otherRuntimes();
      if (others.length) throw refuse(409, `Another Get Things Done runs from this install (port ${others.join(', ')}): stop it first`);
      const pid = installer.start({ version, from: running, workspace });
      writeLock(pid, version);
      started = true;
    } catch (err) {
      setUpdating(false);
      dropOwnLock();
      throw err;
    }
    return describe(await readStored(), workspace);
  } finally {
    // After a start the flag stays: this dashboard is about to stop.
    if (!started) starting = false;
  }
}

export async function updateStatus(workspace: string | null = null): Promise<UpdateStatus> {
  return describe(await readStored(), workspace);
}

/** "Check now": asks again, unless it was asked a moment ago (then the answer being fetched or kept is used). */
export async function checkNow(workspace: string | null = null): Promise<UpdateStatus> {
  if (checking) return describe(await checking, workspace);
  if (Date.now() - lastAsked < CHECK_NOW_GAP_MS) return updateStatus(workspace);
  return describe(await check(), workspace);
}

export async function setAutoCheck(value: unknown, workspace: string | null = null): Promise<UpdateStatus> {
  if (typeof value !== 'boolean') throw Object.assign(new Error('Invalid auto_check: use true or false'), { statusCode: 400 });
  return describe(await changeStored((s) => ({ ...s, auto_check: value })), workspace);
}

/** "Later" on the notice: hides it for that version only, in every dashboard. */
export async function dismiss(version: unknown, workspace: string | null = null): Promise<UpdateStatus> {
  const key = sourceKey();
  const stored = await changeStored((s) => {
    if (!isVersion(version) || version !== s.results[key]?.latest) throw Object.assign(new Error('Invalid version: only the version found can be put off'), { statusCode: 400 });
    return { ...s, dismissed: version };
  });
  return describe(stored, workspace);
}

/**
 * Checks a minute after start and then hourly, asking only when the last answer is a day old and checks are on.
 * Returns how to stop it, for when the server closes.
 */
export function startUpdateChecks(): () => void {
  if (disabled()) return () => {};
  const due = async () => {
    const stored = await readStored();
    if (!stored.auto_check) return;
    const checked = stored.results[sourceKey()]?.checked_at;
    const last = checked ? Date.parse(checked) : 0;
    if (!(Date.now() - last < CHECK_EVERY_MS)) await check();
  };
  const first = setTimeout(() => void due().catch(() => {}), 60_000);
  const hourly = setInterval(() => void due().catch(() => {}), 60 * 60 * 1000);
  first.unref();
  hourly.unref();
  return () => { clearTimeout(first); clearInterval(hourly); };
}
